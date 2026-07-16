// Notification + payments backbone unit tests. No network, no live creds.
// Run: node --test  (Node's built-in runner; each test FILE runs in its own
// process, so the env we set here is isolated from clips.test.js).
//
// We set env BEFORE requiring index.js so the module boots in test mode
// (require.main !== module skips app.listen) with the payments routes ENABLED.
// Deliberately absent: STRIPE_SECRET_KEY (checkout stays simulated),
// STRIPE_WEBHOOK_SECRET (webhook stays simulated by default; individual tests
// set it at call time to exercise real signature verification), RESEND_API_KEY
// (the email channel is a graceful no-op).

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
process.env.CHECKOUT_ENABLED = "1";
process.env.STRIPE_WEBHOOK_ENABLED = "1";
// Ensure a clean slate for the mode-sensitive secrets.
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.RESEND_API_KEY;

const { app, notify } = require("../index.js");

// ---- tiny in-process HTTP harness (same shape as clips.test.js) ------------
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
    if (payload && !h["content-type"] && !h["Content-Type"]) {
      h["content-type"] = "application/json";
    }
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: h },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            json: (() => {
              try {
                return JSON.parse(data);
              } catch {
                return null;
              }
            })(),
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

// Compute a valid Stripe-Signature header for a raw body string.
function stripeSig(body, secret, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${body}`)
    .digest("hex");
  return `t=${t},v1=${v1}`;
}

// ===========================================================================
// notify(): never throws, idempotent
// ===========================================================================

test("notify() never throws when every channel fails (fetch rejects)", async () => {
  const realFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("network down");
  };
  try {
    await assert.doesNotReject(() =>
      notify({
        userId: "u1",
        type: "session.booked",
        title: "Booked",
        body: "See you Friday",
        email: "parent@example.com",
        dedupeKey: "booking-1",
        data: { bookingId: "b1" },
      }),
    );
  } finally {
    global.fetch = realFetch;
  }
});

test("notify() never throws when Supabase returns errors (missing table / 404)", async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
    text: async () => "relation \"notifications\" does not exist",
  });
  try {
    await assert.doesNotReject(() =>
      notify({ userId: "u1", type: "clip.ready", title: "Clip", body: "Ready" }),
    );
  } finally {
    global.fetch = realFetch;
  }
});

test("notify() is idempotent: an existing dedupe row short-circuits email + push", async () => {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ u, method: opts.method || "GET" });
    // Dedupe pre-check (GET notifications) returns an existing row.
    if (u.includes("/rest/v1/notifications") && (opts.method || "GET") === "GET") {
      return { ok: true, json: async () => [{ id: "n1" }] };
    }
    return { ok: true, json: async () => [], text: async () => "" };
  };
  try {
    await notify({
      userId: "u1",
      type: "session.booked",
      title: "Booked",
      body: "again",
      dedupeKey: "booking-1",
    });
    assert.ok(
      !calls.some((c) => c.u.includes("exp.host")),
      "no Expo push fired after the dedupe hit",
    );
    assert.ok(
      !calls.some((c) => c.u.includes("/rest/v1/push_tokens")),
      "no push-token lookup after the dedupe hit",
    );
    assert.ok(
      !calls.some((c) => c.u.includes("/rest/v1/notifications") && c.method === "POST"),
      "no duplicate row inserted after the dedupe hit",
    );
  } finally {
    global.fetch = realFetch;
  }
});

// ===========================================================================
// POST /stripe/webhook: 400 bad signature, 200 unhandled, 200 valid handled
// ===========================================================================

test("POST /stripe/webhook returns 400 on a bad signature (secret set)", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_testsecret";
  const { server, port } = await startServer();
  try {
    const body = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: {} },
    });
    const res = await request(port, {
      method: "POST",
      path: "/stripe/webhook",
      headers: { "content-type": "application/json", "stripe-signature": "t=123,v1=deadbeef" },
      body,
    });
    assert.strictEqual(res.status, 400, "a tampered/garbage signature is the one non-200");
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    server.close();
  }
});

test("POST /stripe/webhook returns 400 when the signature header is missing (secret set)", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_testsecret";
  const { server, port } = await startServer();
  try {
    const body = JSON.stringify({ type: "checkout.session.completed", data: { object: {} } });
    const res = await request(port, {
      method: "POST",
      path: "/stripe/webhook",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.strictEqual(res.status, 400);
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    server.close();
  }
});

// W2 replaces this dispatch smoke test with real invoice cycle-mint assertions.
test("POST /stripe/webhook accepts invoice.paid and dispatches to the stub handler", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_testsecret";
  const handled = [];
  const handlerErrors = [];
  const realHandler = global.handleInvoicePaid;
  const realConsoleError = console.error;
  global.handleInvoicePaid = async (event) => handled.push(event);
  console.error = (...args) => {
    if (String(args[0]).includes("handler for invoice.paid failed")) handlerErrors.push(args);
    else realConsoleError(...args);
  };
  const { server, port } = await startServer();
  try {
    const body = JSON.stringify({ type: "invoice.paid", data: { object: { id: "in_1" } } });
    const sig = stripeSig(body, "whsec_testsecret");
    const res = await request(port, {
      method: "POST",
      path: "/stripe/webhook",
      headers: { "content-type": "application/json", "stripe-signature": sig },
      body,
    });
    assert.strictEqual(res.status, 200, "handled invoice events are ACK'd after dispatch");
    assert.strictEqual(res.json.received, true);
    assert.strictEqual(handled.length, 1, "invoice.paid dispatches to its stub handler");
    assert.strictEqual(handled[0].data.object.id, "in_1");
    assert.strictEqual(handlerErrors.length, 0, "stub dispatch completes without error");
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    if (realHandler === undefined) delete global.handleInvoicePaid;
    else global.handleInvoicePaid = realHandler;
    console.error = realConsoleError;
    server.close();
  }
});

test("POST /stripe/webhook returns 200 for a VALID signature on a handled event", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_testsecret";
  const { server, port } = await startServer();
  try {
    const body = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { id: "cs_123", client_reference_id: "u1", amount_total: 5000 } },
    });
    const sig = stripeSig(body, "whsec_testsecret");
    const res = await request(port, {
      method: "POST",
      path: "/stripe/webhook",
      headers: { "content-type": "application/json", "stripe-signature": sig },
      body,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.received, true);
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    server.close();
  }
});

// ===========================================================================
// POST /checkout/create-session: refuses a client price, simulated stable shape
// ===========================================================================

test("POST /checkout/create-session REFUSES a client-supplied amount", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  // Auth passes; the price-field guard fires before any package lookup.
  global.fetch = async (url) => {
    if (String(url).includes("/auth/v1/user")) {
      return { ok: true, json: async () => ({ id: "user-1" }) };
    }
    return { ok: true, json: async () => [] };
  };
  try {
    const res = await request(port, {
      method: "POST",
      path: "/checkout/create-session",
      headers: { authorization: "Bearer good-jwt" },
      body: JSON.stringify({ packageId: "p1", amount: 1 }),
    });
    assert.strictEqual(res.status, 400, "the client never names its own price");
    assert.match(res.json.error, /server-side/);
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test("POST /checkout/create-session simulated mode returns a stable shape (amount from the package row)", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/auth/v1/user")) {
      return { ok: true, json: async () => ({ id: "user-1" }) };
    }
    if (u.includes("/rest/v1/athletes")) {
      return { ok: true, json: async () => [{ coach_id: "coach-1" }] };
    }
    if (u.includes("/rest/v1/packages")) {
      return {
        ok: true,
        json: async () => [
          { id: "p1", coach_id: "coach-1", name: "5-Session Pack", price_cents: 5000,
            active: true },
        ],
      };
    }
    return { ok: true, json: async () => [] };
  };
  try {
    const res = await request(port, {
      method: "POST",
      path: "/checkout/create-session",
      headers: { authorization: "Bearer good-jwt" },
      body: JSON.stringify({ packageId: "p1" }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.simulated, true);
    assert.strictEqual(res.json.amountCents, 5000, "amount is the server-computed package price");
    assert.strictEqual(res.json.packageId, "p1");
    assert.strictEqual(res.json.clientSecret, null);
    assert.ok(typeof res.json.url === "string" && res.json.url.length > 0, "a checkout url is returned");
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test("POST /checkout/create-session returns 401 without a JWT", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, {
      method: "POST",
      path: "/checkout/create-session",
      body: JSON.stringify({ packageId: "p1" }),
    });
    assert.strictEqual(res.status, 401, "identity must come from a verified JWT");
  } finally {
    server.close();
  }
});

// ===========================================================================
// D19 REAL WEBHOOK PROVISIONING (checkout.session.completed)
// ===========================================================================
//
// Shared fetch mock (same shape as scheduling-endpoints.test.js): routes Supabase
// REST by URL + method, records every call. Unmatched returns ok/empty so notify's
// dedupe GET + notifications insert + push_tokens lookup are absorbed.
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
  return {
    calls,
    restore() {
      global.fetch = realFetch;
    },
  };
}
function okr(json, status = 200) {
  return { ok: status < 400, status, json: async () => json, text: async () => "" };
}

const PKG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COACH_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ATHLETE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SESSION_ID = "cs_test_dddddddd";

// Build a signed checkout.session.completed delivery for the given session object.
function completedEvent(port, sessionObj) {
  const body = JSON.stringify({
    type: "checkout.session.completed",
    data: { object: sessionObj },
  });
  const sig = stripeSig(body, "whsec_testsecret");
  return request(port, {
    method: "POST",
    path: "/stripe/webhook",
    headers: { "content-type": "application/json", "stripe-signature": sig },
    body,
  });
}

test("webhook HARD GATE: a handled event without STRIPE_WEBHOOK_SECRET refuses to provision (503)", async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET; // unverified: must not provision.
  const { server, port } = await startServer();
  const mock = installFetchMock([]);
  try {
    const body = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { id: SESSION_ID, metadata: { packageId: PKG_ID } } },
    });
    const res = await request(port, {
      method: "POST",
      path: "/stripe/webhook",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.strictEqual(res.status, 503, "503 preserves a paid event for redelivery once the secret is set");
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/package_purchases")),
      "nothing is provisioned on an unverified event",
    );
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/athlete_claims")),
      "no account is provisioned on an unverified event",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

test("webhook provisions credits from the package and mints a claim for a NEW buyer email", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_testsecret";
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      // idempotency pre-check: no prior purchase for this session.
      test: (u, m) =>
        u.includes("/package_purchases") && u.includes("stripe_session_id=eq.") && m === "GET",
      reply: () => okr([]),
    },
    {
      // package lookup drives credits/coach/expiry.
      test: (u, m) => u.includes("/packages") && m === "GET",
      reply: () => okr([{ id: PKG_ID, coach_id: COACH_ID, credits: 5, expires_days: 30 }]),
    },
    {
      // no athlete matches the buyer email in this tenant.
      test: (u, m) => u.includes("/athletes") && m === "GET",
      reply: () => okr([]),
    },
    {
      // create the athlete card from the email.
      test: (u, m) => u.includes("/athletes") && m === "POST",
      reply: () => okr([{ id: ATHLETE_ID }]),
    },
    {
      // no reusable claim -> mint.
      test: (u, m) => u.includes("/athlete_claims") && m === "GET",
      reply: () => okr([]),
    },
    {
      test: (u, m) => u.includes("/athlete_claims") && m === "POST",
      reply: () => okr([{ token: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }]),
    },
    {
      // purchase insert.
      test: (u, m) => u.includes("/package_purchases") && m === "POST",
      reply: () => okr([{ id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }], 201),
    },
  ]);
  try {
    const res = await completedEvent(port, {
      id: SESSION_ID,
      amount_total: 5000,
      metadata: { packageId: PKG_ID },
      customer_details: { email: "New.Buyer@Example.com", name: "New Buyer" },
    });
    assert.strictEqual(res.status, 200);

    // The athlete card was created for THIS coach from the (lowercased) email.
    const athIns = mock.calls.find((c) => c.u.includes("/athletes") && c.method === "POST");
    assert.ok(athIns, "an athlete card was created (buy-first funnel)");
    assert.strictEqual(athIns.body.coach_id, COACH_ID);
    assert.strictEqual(athIns.body.parent_email, "new.buyer@example.com", "email normalized to lowercase");

    // A claim was minted (the account offer, NOT a Supabase auth user).
    const claimIns = mock.calls.find((c) => c.u.includes("/athlete_claims") && c.method === "POST");
    assert.ok(claimIns, "a claim row was minted");
    assert.strictEqual(claimIns.body.athlete_id, ATHLETE_ID);
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/auth/v1/") && c.method === "POST"),
      "no Supabase auth user is created directly — the claim tap is the magic link",
    );

    // The purchase carried package-derived credits + expiry + idempotency key.
    const purIns = mock.calls.find((c) => c.u.includes("/package_purchases") && c.method === "POST");
    assert.ok(purIns, "the purchase was inserted");
    assert.strictEqual(purIns.body.credits_total, 5, "credits come from the package server-side");
    assert.strictEqual(purIns.body.credits_remaining, 5);
    assert.strictEqual(purIns.body.stripe_session_id, SESSION_ID, "keyed on the session id for idempotency");
    assert.strictEqual(purIns.body.athlete_id, ATHLETE_ID, "purchase linked to the new athlete");
    assert.strictEqual(purIns.body.source, "checkout");
    assert.ok(purIns.body.expires_at, "expires_at set from package.expires_days");

    // notify() fired payment.confirmed keyed on the session id, carrying the claim link.
    const note = mock.calls.find(
      (c) => c.u.includes("/rest/v1/notifications") && c.method === "POST",
    );
    assert.ok(note, "a payment.confirmed notification row was written");
    assert.strictEqual(note.body.type, "payment.confirmed");
    assert.strictEqual(note.body.dedupe_key, SESSION_ID);
    assert.ok(
      note.body.data && String(note.body.data.claimUrl).includes("/claim/"),
      "the claim link rides the payment.confirmed notification",
    );
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});

test("webhook links the purchase to a MATCHED athlete, minting a claim only when unclaimed", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_testsecret";
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      test: (u, m) =>
        u.includes("/package_purchases") && u.includes("stripe_session_id=eq.") && m === "GET",
      reply: () => okr([]),
    },
    {
      test: (u, m) => u.includes("/packages") && m === "GET",
      reply: () => okr([{ id: PKG_ID, coach_id: COACH_ID, credits: 10, expires_days: null }]),
    },
    {
      // an existing UNCLAIMED athlete matches the buyer email.
      test: (u, m) => u.includes("/athletes") && m === "GET",
      reply: () => okr([{ id: ATHLETE_ID, user_id: null }]),
    },
    {
      test: (u, m) => u.includes("/athlete_claims") && m === "GET",
      reply: () => okr([]),
    },
    {
      test: (u, m) => u.includes("/athlete_claims") && m === "POST",
      reply: () => okr([{ token: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }]),
    },
    {
      test: (u, m) => u.includes("/package_purchases") && m === "POST",
      reply: () => okr([{ id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }], 201),
    },
  ]);
  try {
    const res = await completedEvent(port, {
      id: SESSION_ID,
      amount_total: 9000,
      metadata: { packageId: PKG_ID },
      customer_details: { email: "match@example.com" },
    });
    assert.strictEqual(res.status, 200);
    // Matched -> no athlete created, purchase linked, claim minted (unclaimed).
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/athletes") && c.method === "POST"),
      "a matched athlete is reused, never re-created",
    );
    const purIns = mock.calls.find((c) => c.u.includes("/package_purchases") && c.method === "POST");
    assert.strictEqual(purIns.body.athlete_id, ATHLETE_ID, "purchase linked to the matched athlete");
    assert.strictEqual(purIns.body.credits_total, 10, "credits from the package");
    assert.strictEqual(purIns.body.expires_at, null, "no-expiry package -> expires_at null");
    assert.ok(
      mock.calls.some((c) => c.u.includes("/athlete_claims") && c.method === "POST"),
      "an unclaimed matched athlete is offered a claim",
    );
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});

test("webhook links the purchase to a CLAIMED athlete without minting a claim", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_testsecret";
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      test: (u, m) =>
        u.includes("/package_purchases") && u.includes("stripe_session_id=eq.") && m === "GET",
      reply: () => okr([]),
    },
    {
      test: (u, m) => u.includes("/packages") && m === "GET",
      reply: () => okr([{ id: PKG_ID, coach_id: COACH_ID, credits: 5, expires_days: 30 }]),
    },
    {
      // an existing CLAIMED athlete (user_id set) matches the buyer email.
      test: (u, m) => u.includes("/athletes") && m === "GET",
      reply: () => okr([{ id: ATHLETE_ID, user_id: "auth-user-1" }]),
    },
    {
      test: (u, m) => u.includes("/package_purchases") && m === "POST",
      reply: () => okr([{ id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }], 201),
    },
  ]);
  try {
    const res = await completedEvent(port, {
      id: SESSION_ID,
      amount_total: 5000,
      metadata: { packageId: PKG_ID },
      customer_details: { email: "claimed@example.com" },
    });
    assert.strictEqual(res.status, 200);
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/athlete_claims")),
      "a claimed athlete is never offered a claim",
    );
    const purIns = mock.calls.find((c) => c.u.includes("/package_purchases") && c.method === "POST");
    assert.strictEqual(purIns.body.athlete_id, ATHLETE_ID, "purchase still linked to the athlete");
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});

test("webhook is idempotent: a duplicate session id no-ops (no second purchase)", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_testsecret";
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      // idempotency pre-check finds an existing purchase for this session.
      test: (u, m) =>
        u.includes("/package_purchases") && u.includes("stripe_session_id=eq.") && m === "GET",
      reply: () => okr([{ id: "existing-purchase" }]),
    },
  ]);
  try {
    const res = await completedEvent(port, {
      id: SESSION_ID,
      amount_total: 5000,
      metadata: { packageId: PKG_ID },
      customer_details: { email: "dup@example.com" },
    });
    assert.strictEqual(res.status, 200, "a duplicate delivery is ACK'd, never retried");
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/package_purchases") && c.method === "POST"),
      "no second purchase is inserted for a duplicate session",
    );
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/packages") && c.method === "GET"),
      "a duplicate short-circuits before any package lookup or provisioning",
    );
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});
