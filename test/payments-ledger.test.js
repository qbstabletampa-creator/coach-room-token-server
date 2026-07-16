// Payments Phase 1 ledger tests (PAYMENTS_ENABLED ON + STRIPE_WEBHOOK_ENABLED ON).
// No network, no live creds; env is set BEFORE requiring index.js so the module
// boots in test mode with the payments routes registered. global.fetch is mocked
// per test to route Supabase PostgREST + Stripe-mirror calls by URL + method.
//
// Covers: CRUD happy paths, amount validation, tenant isolation (coach A cannot
// read or void coach B rows), void reopening a singly-paid charge, and the
// Stripe webhook payments-ledger mirror (writes exactly one row, idempotent on
// replay, fail-soft on mirror failure).

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
process.env.ROOM_TICKET_SECRET = "test-ticket-secret";
process.env.PAYMENTS_ENABLED = "1";
process.env.STRIPE_WEBHOOK_ENABLED = "1";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.RESEND_API_KEY;

const { app } = require("../index.js");

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body);
    const h = { ...headers };
    if (payload && !h["content-type"] && !h["Content-Type"]) h["content-type"] = "application/json";
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: h },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            json: (() => { try { return JSON.parse(data); } catch { return null; } })(),
            text: data,
          }),
        );
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function installFetchMock(routes) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ u, method, body: opts.body ? JSON.parse(opts.body) : null });
    for (const r of routes) {
      if (r.test(u, method)) return r.reply(u, method, opts);
    }
    return { ok: true, status: 200, json: async () => [], text: async () => "" };
  };
  return { calls, restore() { global.fetch = realFetch; } };
}
function okr(json, status = 200) {
  return { ok: status < 400, status, json: async () => json, text: async () => "" };
}

// Compute a valid Stripe-Signature header for a raw body string.
function stripeSig(body, secret, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

const COACH_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHARGE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PAYMENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ATHLETE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PKG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const COACH_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PURCHASE_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SESSION_ID = "cs_test_ledger_1";

// The auth route every coach-authed handler hits first.
function authRoute(coachId = COACH_A) {
  return {
    test: (u) => u.includes("/auth/v1/user"),
    reply: () => okr({ id: coachId }),
  };
}

const AUTH = { authorization: "Bearer good-jwt" };

// ===========================================================================
// CRUD happy paths
// ===========================================================================

test("POST /charges creates an ad-hoc owed item (201)", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    authRoute(),
    {
      test: (u, m) => u.includes("/rest/v1/coach_charges") && m === "POST",
      reply: () => okr([{ id: CHARGE_ID, label: "Private lesson", amount_cents: 6000, status: "open" }]),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/charges",
      headers: AUTH,
      body: JSON.stringify({ label: "Private lesson", amount_cents: 6000 }),
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.json.charge.id, CHARGE_ID);
    const ins = mock.calls.find((c) => c.u.includes("/coach_charges") && c.method === "POST");
    assert.strictEqual(ins.body.coach_id, COACH_A, "the charge is stamped with the JWT coach id");
    assert.strictEqual(ins.body.status, "open");
  } finally {
    mock.restore();
    server.close();
  }
});

test("POST /payments records a payment on a rail (201) and stamps created_by from the JWT", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    authRoute(),
    {
      test: (u, m) => u.includes("/rest/v1/payments") && m === "POST",
      reply: () => okr([{ id: PAYMENT_ID, amount_cents: 5000, collected_via: "venmo" }]),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/payments",
      headers: AUTH,
      body: JSON.stringify({ amount_cents: 5000, collected_via: "venmo", note: "Zelle from parent" }),
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.json.payment.id, PAYMENT_ID);
    const ins = mock.calls.find((c) => c.u.includes("/rest/v1/payments") && c.method === "POST");
    assert.strictEqual(ins.body.coach_id, COACH_A);
    assert.strictEqual(ins.body.created_by, COACH_A, "created_by is the JWT coach id, never the body");
    assert.strictEqual(ins.body.entry_source, "manual");
    assert.strictEqual(ins.body.collected_via, "venmo");
    assert.strictEqual(ins.body.status, "recorded");
  } finally {
    mock.restore();
    server.close();
  }
});

test("POST /payments flips a linked open charge to paid", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    authRoute(),
    // ownsRow(charge) -> the coach owns CHARGE_ID.
    {
      test: (u, m) => u.includes("/rest/v1/coach_charges") && u.includes("id=eq.") && m === "GET",
      reply: () => okr([{ id: CHARGE_ID }]),
    },
    {
      test: (u, m) => u.includes("/rest/v1/payments") && m === "POST",
      reply: () => okr([{ id: PAYMENT_ID, amount_cents: 6000, collected_via: "cash" }]),
    },
    {
      test: (u, m) => u.includes("/rest/v1/coach_charges") && m === "PATCH",
      reply: () => okr(null),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/payments",
      headers: AUTH,
      body: JSON.stringify({ amount_cents: 6000, collected_via: "cash", charge_id: CHARGE_ID }),
    });
    assert.strictEqual(res.status, 201);
    const flip = mock.calls.find((c) => c.u.includes("/coach_charges") && c.method === "PATCH");
    assert.ok(flip, "the linked charge was flipped");
    assert.ok(flip.u.includes(`id=eq.${CHARGE_ID}`) && flip.u.includes("status=eq.open"));
    assert.strictEqual(flip.body.status, "paid");
  } finally {
    mock.restore();
    server.close();
  }
});

test("GET /payments/methods returns the coach rail preferences", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    authRoute(),
    {
      test: (u, m) => u.includes("/rest/v1/coaches") && m === "GET",
      reply: () => okr([{ venmo_handle: "@cj", cashapp_handle: null, zelle_handle: null, preferred_rail: "venmo", show_rails_on_page: true }]),
    },
  ]);
  try {
    const res = await request(port, { path: "/payments/methods", headers: AUTH });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.venmo_handle, "@cj");
    assert.strictEqual(res.json.preferred_rail, "venmo");
    assert.strictEqual(res.json.show_rails_on_page, true);
  } finally {
    mock.restore();
    server.close();
  }
});

test("PATCH /payments/rails updates handles and rejects a bad preferred_rail", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    authRoute(),
    {
      test: (u, m) => u.includes("/rest/v1/coaches") && m === "PATCH",
      reply: () => okr([{ venmo_handle: "@newcj", cashapp_handle: null, zelle_handle: null, preferred_rail: "venmo", show_rails_on_page: false }]),
    },
  ]);
  try {
    const good = await request(port, {
      method: "PATCH",
      path: "/payments/rails",
      headers: AUTH,
      body: JSON.stringify({ venmo_handle: "@newcj", preferred_rail: "venmo" }),
    });
    assert.strictEqual(good.status, 200);
    const patch = mock.calls.find((c) => c.u.includes("/coaches") && c.method === "PATCH");
    assert.ok(patch.u.includes(`id=eq.${COACH_A}`), "the update is scoped to the JWT coach");
    assert.strictEqual(patch.body.venmo_handle, "@newcj");

    const bad = await request(port, {
      method: "PATCH",
      path: "/payments/rails",
      headers: AUTH,
      body: JSON.stringify({ preferred_rail: "bitcoin" }),
    });
    assert.strictEqual(bad.status, 400, "an invalid rail is rejected");
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// amount validation
// ===========================================================================

test("POST /payments rejects a non-positive / non-integer amount with 400 and writes nothing", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([authRoute()]);
  try {
    for (const amt of [0, -500, 12.5, "50", null]) {
      const res = await request(port, {
        method: "POST",
        path: "/payments",
        headers: AUTH,
        body: JSON.stringify({ amount_cents: amt, collected_via: "cash" }),
      });
      assert.strictEqual(res.status, 400, `amount ${JSON.stringify(amt)} is rejected`);
    }
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/rest/v1/payments") && c.method === "POST"),
      "no payment row is ever inserted on a validation failure",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

test("POST /payments rejects an invalid collected_via rail with 400", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([authRoute()]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/payments",
      headers: AUTH,
      body: JSON.stringify({ amount_cents: 5000, collected_via: "paypal" }),
    });
    assert.strictEqual(res.status, 400);
    assert.ok(!mock.calls.some((c) => c.u.includes("/rest/v1/payments") && c.method === "POST"));
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// GET /payments/overview: owed + paid, tenant-scoped reads
// ===========================================================================

test("GET /payments/overview returns owed + paid grouped by rail, every read scoped to the JWT coach", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    authRoute(),
    { test: (u, m) => u.includes("/rest/v1/coach_charges") && m === "GET", reply: () => okr([{ id: CHARGE_ID, label: "Clinic fee", amount_cents: 5000, athlete_id: null, slot_id: null, created_at: "2026-07-01T00:00:00Z" }]) },
    { test: (u, m) => u.includes("/rest/v1/bookable_slots") && m === "GET", reply: () => okr([]) },
    { test: (u, m) => u.includes("/rest/v1/credit_deductions") && m === "GET", reply: () => okr([]) },
    // payments read for owed-exclusion (select=slot_id) -> none.
    { test: (u, m) => u.includes("/rest/v1/payments") && u.includes("select=slot_id") && m === "GET", reply: () => okr([]) },
    // revenueByRail grouping read.
    { test: (u, m) => u.includes("/rest/v1/payments") && u.includes("select=amount_cents,collected_via") && m === "GET", reply: () => okr([{ amount_cents: 5000, collected_via: "venmo" }, { amount_cents: 3000, collected_via: "stripe" }]) },
    // listPayments recent read.
    { test: (u, m) => u.includes("/rest/v1/payments") && m === "GET", reply: () => okr([{ id: PAYMENT_ID, amount_cents: 5000, collected_via: "venmo", occurred_at: "2026-07-10T00:00:00Z" }]) },
  ]);
  try {
    const res = await request(port, { path: "/payments/overview?range=this_month", headers: AUTH });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.owed.total_cents, 5000, "owed totals the open charges");
    assert.strictEqual(res.json.paid.total_cents, 8000, "paid totals all recorded payments");
    assert.strictEqual(res.json.paid.by_rail.venmo.total_cents, 5000);
    assert.strictEqual(res.json.paid.by_rail.stripe.total_cents, 3000);

    // Every money read is tenant-scoped to the JWT coach id.
    const reads = mock.calls.filter(
      (c) => c.method === "GET" && (c.u.includes("/coach_charges") || c.u.includes("/payments") || c.u.includes("/bookable_slots")),
    );
    assert.ok(reads.length > 0);
    for (const r of reads) {
      assert.ok(r.u.includes(`coach_id=eq.${COACH_A}`), `read is scoped to the coach: ${r.u}`);
    }
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// tenant isolation: coach A cannot void coach B's payment
// ===========================================================================

test("POST /payments/:id/void 404s for a payment that is not the coach's own (no PATCH fired)", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    authRoute(COACH_A),
    // The load-by-id is scoped to COACH_A; coach B's row is invisible -> [].
    { test: (u, m) => u.includes("/rest/v1/payments") && u.includes("id=eq.") && m === "GET", reply: () => okr([]) },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: `/payments/${PAYMENT_ID}/void`,
      headers: AUTH,
    });
    assert.strictEqual(res.status, 404, "a cross-tenant payment id is a 404, revealing nothing");
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/rest/v1/payments") && c.method === "PATCH"),
      "no void PATCH is ever issued for a payment the coach does not own",
    );
    // The load query WAS scoped to the JWT coach.
    const load = mock.calls.find((c) => c.u.includes("/rest/v1/payments") && c.method === "GET");
    assert.ok(load.u.includes(`coach_id=eq.${COACH_A}`), "the void load is tenant-scoped");
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// void reopens a singly-paid charge
// ===========================================================================

test("POST /payments/:id/void reopens a charge when the voided payment was its only recorded payment", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    authRoute(),
    // "any OTHER recorded payment against this charge?" -> none. Checked BEFORE
    // the id=eq. load route because "charge_id=eq." contains "id=eq." as a
    // substring (real PostgREST distinguishes them; the naive mock needs order).
    { test: (u, m) => u.includes("/rest/v1/payments") && u.includes("charge_id=eq.") && m === "GET", reply: () => okr([]) },
    // load the coach's own recorded payment, linked to CHARGE_ID.
    { test: (u, m) => u.includes("/rest/v1/payments") && u.includes("id=eq.") && m === "GET", reply: () => okr([{ id: PAYMENT_ID, status: "recorded", charge_id: CHARGE_ID }]) },
    // the void flip (recorded -> void).
    { test: (u, m) => u.includes("/rest/v1/payments") && m === "PATCH", reply: () => okr([{ id: PAYMENT_ID, status: "void" }]) },
    // reopen the charge.
    { test: (u, m) => u.includes("/rest/v1/coach_charges") && m === "PATCH", reply: () => okr(null) },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: `/payments/${PAYMENT_ID}/void`,
      headers: AUTH,
    });
    assert.strictEqual(res.status, 200);
    const reopen = mock.calls.find((c) => c.u.includes("/coach_charges") && c.method === "PATCH");
    assert.ok(reopen, "the charge was reopened");
    assert.ok(reopen.u.includes(`id=eq.${CHARGE_ID}`) && reopen.u.includes("status=eq.paid"));
    assert.strictEqual(reopen.body.status, "open", "the singly-paid charge flips back to open");
  } finally {
    mock.restore();
    server.close();
  }
});

test("POST /payments/:id/void does NOT reopen a charge that still has another recorded payment", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    authRoute(),
    // another recorded payment still covers the charge (checked before id=eq.).
    { test: (u, m) => u.includes("/rest/v1/payments") && u.includes("charge_id=eq.") && m === "GET", reply: () => okr([{ id: "other-payment" }]) },
    { test: (u, m) => u.includes("/rest/v1/payments") && u.includes("id=eq.") && m === "GET", reply: () => okr([{ id: PAYMENT_ID, status: "recorded", charge_id: CHARGE_ID }]) },
    { test: (u, m) => u.includes("/rest/v1/payments") && m === "PATCH", reply: () => okr([{ id: PAYMENT_ID, status: "void" }]) },
  ]);
  try {
    const res = await request(port, { method: "POST", path: `/payments/${PAYMENT_ID}/void`, headers: AUTH });
    assert.strictEqual(res.status, 200);
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/coach_charges") && c.method === "PATCH"),
      "the charge stays paid while another recorded payment covers it",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// Stripe webhook payments-ledger mirror
// ===========================================================================

function completedEvent(port, sessionObj) {
  const body = JSON.stringify({ type: "checkout.session.completed", data: { object: sessionObj } });
  const sig = stripeSig(body, "whsec_testsecret");
  return request(port, {
    method: "POST",
    path: "/stripe/webhook",
    headers: { "content-type": "application/json", "stripe-signature": sig },
    body,
  });
}

// Full provisioning mock for a fresh NEW-buyer checkout, parametrized so a test
// can override the payments-mirror pre-check + POST behavior.
function provisionRoutes({ mirrorPrecheck = () => okr([]), mirrorPost = () => okr(null, 201) } = {}) {
  return [
    { test: (u, m) => u.includes("/package_purchases") && u.includes("stripe_session_id=eq.") && m === "GET", reply: () => okr([]) },
    { test: (u, m) => u.includes("/packages") && m === "GET", reply: () => okr([{ id: PKG_ID, coach_id: COACH_ID, credits: 5, expires_days: 30 }]) },
    // mirrorStripePayment tenant-validation reads for linked rows.
    { test: (u, m) => u.includes("/athletes") && u.includes(`id=eq.${ATHLETE_ID}`) && u.includes(`coach_id=eq.${COACH_ID}`) && m === "GET", reply: () => okr([{ id: ATHLETE_ID }]) },
    { test: (u, m) => u.includes("/package_purchases") && u.includes(`id=eq.${PURCHASE_ID}`) && u.includes(`coach_id=eq.${COACH_ID}`) && m === "GET", reply: () => okr([{ id: PURCHASE_ID }]) },
    { test: (u, m) => u.includes("/athletes") && m === "GET", reply: () => okr([]) },
    { test: (u, m) => u.includes("/athletes") && m === "POST", reply: () => okr([{ id: ATHLETE_ID }]) },
    { test: (u, m) => u.includes("/athlete_claims") && m === "GET", reply: () => okr([]) },
    { test: (u, m) => u.includes("/athlete_claims") && m === "POST", reply: () => okr([{ token: "77777777-7777-4777-8777-777777777777" }]) },
    { test: (u, m) => u.includes("/package_purchases") && m === "POST", reply: () => okr([{ id: PURCHASE_ID }], 201) },
    // payments mirror pre-check (stripe_session_id) + insert.
    { test: (u, m) => u.includes("/rest/v1/payments") && u.includes("stripe_session_id=eq.") && m === "GET", reply: (u2, m2, opts) => mirrorPrecheck(u2, m2, opts) },
    { test: (u, m) => u.includes("/rest/v1/payments") && m === "POST", reply: (u2, m2, opts) => mirrorPost(u2, m2, opts) },
  ];
}

test("webhook mirror writes EXACTLY ONE payments row (stripe, entry_source stripe_webhook, purchase linked)", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_testsecret";
  const { server, port } = await startServer();
  const mock = installFetchMock(provisionRoutes());
  try {
    const res = await completedEvent(port, {
      id: SESSION_ID,
      amount_total: 5000,
      metadata: { packageId: PKG_ID },
      customer_details: { email: "new.buyer@example.com", name: "New Buyer" },
    });
    assert.strictEqual(res.status, 200);
    const mirrorPosts = mock.calls.filter((c) => c.u.includes("/rest/v1/payments") && c.method === "POST");
    assert.strictEqual(mirrorPosts.length, 1, "exactly one ledger row is mirrored");
    const row = mirrorPosts[0].body;
    assert.strictEqual(row.coach_id, COACH_ID);
    assert.strictEqual(row.athlete_id, ATHLETE_ID, "mirror links the provisioned athlete");
    assert.strictEqual(row.amount_cents, 5000, "amount from the session total");
    assert.strictEqual(row.collected_via, "stripe");
    assert.strictEqual(row.entry_source, "stripe_webhook");
    assert.strictEqual(row.stripe_session_id, SESSION_ID, "keyed on the session id for idempotency");
    assert.strictEqual(row.purchase_id, PURCHASE_ID, "mirror links the package_purchases row");
    assert.strictEqual(row.status, "recorded");
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});

test("webhook mirror tags apple_pay when the session wallet says so", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_testsecret";
  const { server, port } = await startServer();
  const mock = installFetchMock(provisionRoutes());
  try {
    const res = await completedEvent(port, {
      id: "cs_test_apple_1",
      amount_total: 5000,
      metadata: { packageId: PKG_ID },
      customer_details: { email: "apple@example.com" },
      payment_method_details: { card: { wallet: { type: "apple_pay" } } },
    });
    assert.strictEqual(res.status, 200);
    const row = mock.calls.find((c) => c.u.includes("/rest/v1/payments") && c.method === "POST").body;
    assert.strictEqual(row.collected_via, "apple_pay", "an apple_pay wallet is tagged as such");
    assert.strictEqual(row.coach_id, COACH_ID);
    assert.strictEqual(row.athlete_id, ATHLETE_ID, "mirror links the provisioned athlete");
    assert.strictEqual(row.amount_cents, 5000, "amount from the session total");
    assert.strictEqual(row.entry_source, "stripe_webhook");
    assert.strictEqual(row.stripe_session_id, "cs_test_apple_1", "keyed on the session id for idempotency");
    assert.strictEqual(row.purchase_id, PURCHASE_ID, "mirror links the package_purchases row");
    assert.strictEqual(row.status, "recorded");
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});

test("webhook mirror is idempotent: a session already mirrored inserts NO second row", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_testsecret";
  const { server, port } = await startServer();
  // Fresh purchase, but a payments row already exists for the session -> mirror no-ops.
  const mock = installFetchMock(
    provisionRoutes({ mirrorPrecheck: () => okr([{ id: "existing-mirror" }]) }),
  );
  try {
    const res = await completedEvent(port, {
      id: SESSION_ID,
      amount_total: 5000,
      metadata: { packageId: PKG_ID },
      customer_details: { email: "dup@example.com" },
    });
    assert.strictEqual(res.status, 200);
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/rest/v1/payments") && c.method === "POST"),
      "no second ledger row when the session is already mirrored",
    );
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});

test("webhook mirror FAILURE never fails the webhook (still 200) and never unwinds provisioning", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_testsecret";
  const { server, port } = await startServer();
  const mock = installFetchMock(
    provisionRoutes({
      mirrorPost: () => { throw new Error("payments insert exploded"); },
    }),
  );
  try {
    const res = await completedEvent(port, {
      id: SESSION_ID,
      amount_total: 5000,
      metadata: { packageId: PKG_ID },
      customer_details: { email: "boom@example.com" },
    });
    assert.strictEqual(res.status, 200, "a mirror explosion is swallowed; the webhook still ACKs 200");
    // Provisioning still happened (the purchase was inserted before the mirror).
    assert.ok(
      mock.calls.some((c) => c.u.includes("/package_purchases") && c.method === "POST"),
      "the purchase was still provisioned despite the mirror failure",
    );
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});
