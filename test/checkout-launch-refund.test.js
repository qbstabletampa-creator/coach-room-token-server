// Checkout-launch go-live blockers: R2 (silent credit loss on transient webhook
// failure) and R3 (refund never revokes credits). Same harness as
// payments-ledger.test.js: env is set BEFORE requiring index.js so the Stripe
// webhook route is mounted; global.fetch is mocked per test to route Supabase
// PostgREST calls by URL + method. Webhooks are driven over real HTTP with a
// valid Stripe signature so we exercise the ROUTE's status code (the thing R2 is
// about), not just the handler.

const test = require("node:test");
const assert = require("node:assert/strict");
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

const COACH_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ATHLETE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PKG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const PURCHASE_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SESSION_ID = "cs_launch_1";
const PI = "pi_launch_1";
const SECRET = "whsec_launchsecret";

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function request(port, { method = "POST", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body);
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          json: (() => { try { return JSON.parse(data); } catch { return null; } })(),
        }),
      );
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function okr(json, status = 200) {
  return { ok: status < 400, status, json: async () => json, text: async () => (status === 409 ? "23505" : "") };
}

function installFetchMock(routes) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ u, method, body: opts.body ? JSON.parse(opts.body) : null });
    for (const r of routes) if (r.test(u, method)) return r.reply(u, method, opts);
    return okr([]); // default: empty, success
  };
  return { calls, restore() { global.fetch = realFetch; } };
}

function stripeSig(body, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

function postWebhook(port, type, object) {
  const body = JSON.stringify({ type, data: { object } });
  return request(port, {
    path: "/stripe/webhook",
    headers: { "content-type": "application/json", "stripe-signature": stripeSig(body) },
    body,
  });
}

const completedSession = (over = {}) => ({
  id: SESSION_ID,
  amount_total: 5000,
  payment_intent: PI,
  metadata: { packageId: PKG_ID },
  customer_details: { email: "buyer@example.com", name: "Buyer" },
  ...over,
});

// Provisioning reads for a fresh NEW buyer, parametrized so a test can override
// the pre-check and the package_purchases POST outcome.
function provisionRoutes({ precheck = () => okr([]), purchasePost = () => okr([{ id: PURCHASE_ID }], 201) } = {}) {
  return [
    { test: (u, m) => u.includes("/package_purchases") && u.includes("stripe_session_id=eq.") && m === "GET", reply: (u2, m2, o) => precheck(u2, m2, o) },
    { test: (u, m) => u.includes("/packages") && m === "GET", reply: () => okr([{ id: PKG_ID, coach_id: COACH_ID, credits: 5, expires_days: 30 }]) },
    { test: (u, m) => u.includes("/athletes") && u.includes(`id=eq.${ATHLETE_ID}`) && m === "GET", reply: () => okr([{ id: ATHLETE_ID }]) },
    { test: (u, m) => u.includes("/athletes") && m === "GET", reply: () => okr([]) },
    { test: (u, m) => u.includes("/athletes") && m === "POST", reply: () => okr([{ id: ATHLETE_ID }]) },
    { test: (u, m) => u.includes("/athlete_claims") && m === "GET", reply: () => okr([]) },
    { test: (u, m) => u.includes("/athlete_claims") && m === "POST", reply: () => okr([{ token: "77777777-7777-4777-8777-777777777777" }]) },
    { test: (u, m) => u.includes("/package_purchases") && m === "POST", reply: (u2, m2, o) => purchasePost(u2, m2, o) },
    { test: (u, m) => u.includes("/rest/v1/payments") && u.includes("stripe_session_id=eq.") && m === "GET", reply: () => okr([]) },
    { test: (u, m) => u.includes("/rest/v1/payments") && m === "POST", reply: () => okr([{ id: "mirror-1" }], 201) },
  ];
}

// ===========================================================================
// R2 — silent credit loss on transient webhook failure
// ===========================================================================

test("R2.1 transient mint failure returns 5xx (Stripe must retry), never 2xx", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const { server, port } = await startServer();
  // The package_purchases INSERT (the durable mint) hits a transient 503.
  const mock = installFetchMock(provisionRoutes({ purchasePost: () => okr({ message: "db unavailable" }, 503) }));
  try {
    const res = await postWebhook(port, "checkout.session.completed", completedSession());
    assert.equal(res.status >= 500 && res.status < 600, true, `expected 5xx, got ${res.status}`);
    assert.notEqual(res.status, 200, "a failed mint must NOT be ACKed 200 — that loses the credits");
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});

test("R2.2 retry after a transient failure mints exactly once (idempotent)", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const { server, port } = await startServer();
  // Delivery 1 fails at the mint (503). Delivery 2's pre-check finds the row that
  // actually committed (response was lost) and no-ops — the mint never doubles.
  let committed = false;
  const mock = installFetchMock(
    provisionRoutes({
      precheck: () => okr(committed ? [{ id: PURCHASE_ID, coach_id: COACH_ID, athlete_id: ATHLETE_ID }] : []),
      purchasePost: () => okr({ message: "db unavailable" }, 503),
    }),
  );
  try {
    const first = await postWebhook(port, "checkout.session.completed", completedSession());
    assert.equal(first.status >= 500, true, "delivery 1 (transient mint failure) returns 5xx");

    committed = true; // the insert had actually landed; Stripe redelivers.
    const second = await postWebhook(port, "checkout.session.completed", completedSession());
    assert.equal(second.status, 200, "delivery 2 finds the committed purchase and ACKs 200");

    const purchasePosts = mock.calls.filter((c) => c.u.includes("/package_purchases") && c.method === "POST");
    assert.equal(purchasePosts.length, 1, "the mint was attempted exactly once across both deliveries — never doubled");
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// R3 — refund never revokes credits
// ===========================================================================

function refundRoutes(purchase) {
  return [
    // protection refund handler runs first and must no-op (no booking charge).
    { test: (u, m) => u.includes("/booking_charges") && m === "GET", reply: () => okr([]) },
    // package refund: find by the globally-unique payment_intent.
    { test: (u, m) => u.includes("/package_purchases") && u.includes("stripe_payment_intent_id=eq.") && m === "GET", reply: () => okr(purchase ? [purchase] : []) },
    // CAS revoke PATCH — echo the write back as the matched row.
    { test: (u, m) => u.includes("/package_purchases") && m === "PATCH", reply: (u2, m2, o) => okr([{ ...purchase, ...JSON.parse(o.body) }]) },
    { test: (u, m) => u.includes("/credit_deductions") && m === "POST", reply: () => okr(null, 201) },
    { test: (u, m) => u.includes("/rest/v1/payments") && m === "PATCH", reply: () => okr(null, 200) },
  ];
}

const refundCharge = () => ({ id: "ch_launch_1", payment_intent: PI, metadata: {} });

test("R3.1 refund of a fully-unspent purchase revokes all credits and writes an expire ledger row", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const { server, port } = await startServer();
  const purchase = { id: PURCHASE_ID, coach_id: COACH_ID, athlete_id: ATHLETE_ID, credits_total: 5, credits_remaining: 5, status: "active" };
  const mock = installFetchMock(refundRoutes(purchase));
  try {
    const res = await postWebhook(port, "charge.refunded", refundCharge());
    assert.equal(res.status, 200);

    const patch = mock.calls.find((c) => c.u.includes("/package_purchases") && c.method === "PATCH");
    assert.ok(patch, "the purchase was flipped");
    assert.equal(patch.body.credits_remaining, 0, "unspent credits zeroed");
    assert.equal(patch.body.status, "refunded");

    const ledger = mock.calls.find((c) => c.u.includes("/credit_deductions") && c.method === "POST");
    assert.ok(ledger, "an immutable ledger row was written for the revoke");
    assert.equal(ledger.body.action, "expire");
    assert.equal(ledger.body.amount, 5, "revoked the full unspent balance");
    assert.equal(ledger.body.purchase_id, PURCHASE_ID);
    assert.equal(ledger.body.coach_id, COACH_ID);
    assert.match(ledger.body.reason, /payment_refunded/);

    const voidMirror = mock.calls.find((c) => c.u.includes("/rest/v1/payments") && c.method === "PATCH");
    assert.ok(voidMirror, "the collected-money mirror was voided so revenue reflects the refund");
    assert.equal(voidMirror.body.status, "void");
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});

test("R3.2 refund after a partial spend clamps at zero and records the shortfall (never negative)", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const { server, port } = await startServer();
  // total 5, 3 already spent, 2 unspent -> revoke 2, shortfall 3, never negative.
  const purchase = { id: PURCHASE_ID, coach_id: COACH_ID, athlete_id: ATHLETE_ID, credits_total: 5, credits_remaining: 2, status: "active" };
  const mock = installFetchMock(refundRoutes(purchase));
  try {
    const res = await postWebhook(port, "charge.refunded", refundCharge());
    assert.equal(res.status, 200);

    const patch = mock.calls.find((c) => c.u.includes("/package_purchases") && c.method === "PATCH");
    assert.equal(patch.body.credits_remaining, 0, "clamped to zero, not negative");
    // The CAS guard pins the revoke to the exact balance we read.
    assert.match(patch.u, /credits_remaining=eq\.2/);

    const ledger = mock.calls.find((c) => c.u.includes("/credit_deductions") && c.method === "POST");
    assert.equal(ledger.body.amount, 2, "only the UNSPENT credits are clawed back");
    assert.ok(ledger.body.amount > 0, "ledger magnitude is positive (0011 CHECK amount > 0)");
    assert.match(ledger.body.reason, /shortfall_3/, "the already-spent shortfall is recorded, not driven negative");
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});

test("R3.3 refund of an unknown/foreign payment_intent is a safe no-op with no cross-tenant writes", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const { server, port } = await startServer();
  const mock = installFetchMock(refundRoutes(null)); // no purchase matches this PI
  try {
    const res = await postWebhook(port, "charge.refunded", refundCharge());
    assert.equal(res.status, 200, "an unknown refund is ACKed, never a 5xx retry-storm");

    assert.equal(mock.calls.some((c) => c.u.includes("/package_purchases") && c.method === "PATCH"), false, "no purchase is mutated");
    assert.equal(mock.calls.some((c) => c.u.includes("/credit_deductions") && c.method === "POST"), false, "no ledger row is written");
    assert.equal(mock.calls.some((c) => c.u.includes("/rest/v1/payments") && c.method === "PATCH"), false, "no mirror is voided");
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});

test("R3.4 a redelivered refund is idempotent — an already-refunded purchase is a no-op", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const { server, port } = await startServer();
  const purchase = { id: PURCHASE_ID, coach_id: COACH_ID, athlete_id: ATHLETE_ID, credits_total: 5, credits_remaining: 0, status: "refunded" };
  const mock = installFetchMock(refundRoutes(purchase));
  try {
    const res = await postWebhook(port, "charge.refunded", refundCharge());
    assert.equal(res.status, 200);
    assert.equal(mock.calls.some((c) => c.u.includes("/package_purchases") && c.method === "PATCH"), false, "no second revoke");
    assert.equal(mock.calls.some((c) => c.u.includes("/credit_deductions") && c.method === "POST"), false, "no duplicate ledger row");
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});
