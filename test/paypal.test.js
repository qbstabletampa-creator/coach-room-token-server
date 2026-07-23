// PayPal collect lane tests (PAYPAL_ENABLED ON). No network, no live creds: env
// is set BEFORE requiring index.js so the /paypal routes register, and
// global.fetch is mocked per test to route BOTH Supabase PostgREST calls and
// PayPal REST calls by URL + method. The webhook is driven over real HTTP so the
// raw-body mount + signature gate are exercised as a route, not just a handler.
//
// Coverage:
//   - create-order rejects an unknown packageId and a coach with no paypal_email,
//     rejects a client-supplied price, and returns { orderId, approveUrl } on the
//     happy path with a server-authoritative amount.
//   - the return capture mints EXACTLY ONE payments row (collected_via=paypal,
//     entry_source=paypal_webhook, paypal_order_id set); a REPLAYED webhook for
//     the same order changes ZERO rows (idempotency guard).
//   - a bad webhook signature is the one 400 case; unknown event types ack 200.
//   - payment-claims never admits paypal as a claim rail (counter-metric).

const test = require("node:test");
const assert = require("node:assert");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
process.env.ROOM_TICKET_SECRET = "test-ticket-secret";
process.env.PAYPAL_ENABLED = "1";
process.env.PAYPAL_CLIENT_ID = "test-client-id";
process.env.PAYPAL_CLIENT_SECRET = "test-client-secret";
process.env.PAYPAL_WEBHOOK_ID = "WH-TEST-1";
process.env.PAYPAL_API_BASE = "https://api-m.sandbox.paypal.test";
process.env.SCHEDULING_PUBLIC_URL = "https://coachtime.test";

const http = require("node:http");
const { app } = require("../index.js");
const { __resetTokenCache } = require("../lib/paypal.js");
const {
  createClaim,
  CLAIM_RAILS,
} = require("../lib/payment-claims.js");

// ---- ids -------------------------------------------------------------------
const USER_ID = "11111111-1111-4111-8111-111111111111"; // the buyer (JWT subject)
const COACH_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PKG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const ORDER_ID = "PAYPAL-ORDER-1";
const APPROVE_URL = "https://www.sandbox.paypal.test/checkoutnow?token=PAYPAL-ORDER-1";
const AUTH = { authorization: "Bearer test-jwt" };

// ---- HTTP driver -----------------------------------------------------------
function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}
function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body);
    const h = { ...headers };
    if (payload && !h["content-type"]) h["content-type"] = "application/json";
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers: h }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          text: data,
          json: (() => { try { return JSON.parse(data); } catch { return null; } })(),
        }),
      );
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---- fetch mock (URL + method routing, same idiom as the ledger tests) -----
function okr(json, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => json,
    text: async () => (status === 409 ? "23505 duplicate key" : ""),
  };
}
function installFetchMock(routes) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ u, method, body: opts.body && !Buffer.isBuffer(opts.body) ? tryParse(opts.body) : null });
    for (const r of routes) if (r.test(u, method)) return r.reply(u, method, opts);
    return okr([]); // default: empty success
  };
  return { calls, restore() { global.fetch = realFetch; } };
}
function tryParse(s) { try { return JSON.parse(s); } catch { return s; } }

// Supabase auth route: requireSupabaseUser hits /auth/v1/user.
function authRoute(user = { id: USER_ID }) {
  return { test: (u) => u.includes("/auth/v1/user"), reply: () => okr(user) };
}
// getPackage: athletes tenant lookup then packages lookup.
function packageRoutes(pkg = { id: PKG_ID, coach_id: COACH_ID, name: "5-pack", price_cents: 5000, active: true }) {
  return [
    { test: (u, m) => u.includes("/rest/v1/athletes") && u.includes(`user_id=eq.${USER_ID}`) && m === "GET",
      reply: () => okr([{ coach_id: COACH_ID }]) },
    { test: (u, m) => u.includes("/rest/v1/packages") && m === "GET", reply: () => okr(pkg ? [pkg] : []) },
  ];
}
function coachPaypalRoute(email = "coach@paypal.test") {
  return { test: (u, m) => u.includes("/rest/v1/coaches") && u.includes("paypal_email") && m === "GET",
    reply: () => okr([{ paypal_email: email }]) };
}
// PayPal OAuth token.
function paypalOAuthRoute() {
  return { test: (u, m) => u.includes("/v1/oauth2/token") && m === "POST",
    reply: () => okr({ access_token: "test-access-token", expires_in: 32400 }) };
}
// PayPal order create.
function paypalCreateRoute(id = ORDER_ID) {
  return { test: (u, m) => u.endsWith("/v2/checkout/orders") && m === "POST",
    reply: () => okr({ id, links: [{ rel: "approve", href: APPROVE_URL }] }, 201) };
}
// PayPal order capture -> COMPLETED order with a capture amount + custom_id.
function paypalCaptureRoute({ id = ORDER_ID, value = "50.00", custom = `${COACH_ID}:${PKG_ID}` } = {}) {
  return {
    test: (u, m) => u.includes("/v2/checkout/orders/") && u.endsWith("/capture") && m === "POST",
    reply: () => okr({
      id,
      status: "COMPLETED",
      purchase_units: [{
        custom_id: custom,
        payments: { captures: [{ id: "CAP-1", status: "COMPLETED", amount: { value, currency_code: "USD" }, create_time: "2026-07-22T12:00:00Z" }] },
      }],
    }),
  };
}
function paypalVerifyRoute(status = "SUCCESS") {
  return { test: (u, m) => u.includes("/v1/notification/verify-webhook-signature") && m === "POST",
    reply: () => okr({ verification_status: status }) };
}

// A STATEFUL payments store simulating the paypal_order_id partial unique index:
// a GET by order id returns the stored row after the first insert; a POST stores
// once and 409s (23505) on a duplicate order id, exactly like the DB. We ALSO
// count POST attempts so a replay that (wrongly) tries to insert is visible even
// though the simulated index would block a duplicate row.
function paymentsStore() {
  const byOrder = new Map();
  const posts = [];
  return {
    posts,
    routes: [
      { test: (u, m) => u.includes("/rest/v1/payments") && u.includes("paypal_order_id=eq.") && m === "GET",
        reply: (u2) => {
          const oid = decodeURIComponent((u2.match(/paypal_order_id=eq\.([^&]+)/) || [])[1] || "");
          const row = byOrder.get(oid);
          return okr(row ? [row] : []);
        } },
      // owns-row tenant checks for athletes/package_purchases (absent link -> not called).
      { test: (u, m) => u.includes("/rest/v1/payments") && m === "POST",
        reply: (u2, m2, opts) => {
          const body = JSON.parse(opts.body);
          posts.push(body);
          const oid = body.paypal_order_id;
          if (byOrder.has(oid)) return okr({ code: "23505" }, 409); // simulated unique violation
          const row = { id: `pay-${byOrder.size + 1}`, ...body };
          byOrder.set(oid, row);
          return okr([row], 201);
        } },
    ],
    rowCount() { return byOrder.size; },
  };
}

function stripeSigNoop() {} // placeholder to keep parity if imported elsewhere

// ===========================================================================
// create-order
// ===========================================================================

test("POST /paypal/create-order 404-package: unknown packageId is rejected", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([authRoute(), ...packageRoutes(null)]);
  try {
    const res = await request(port, { method: "POST", path: "/paypal/create-order", headers: AUTH, body: JSON.stringify({ packageId: PKG_ID }) });
    assert.strictEqual(res.status, 404, "no package -> 404");
    assert.ok(!mock.calls.some((c) => c.u.includes("/v2/checkout/orders")), "no PayPal order is created for an unknown package");
  } finally { mock.restore(); server.close(); }
});

test("POST /paypal/create-order rejects a coach with no paypal_email (409)", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([authRoute(), ...packageRoutes(), coachPaypalRoute(null)]);
  try {
    const res = await request(port, { method: "POST", path: "/paypal/create-order", headers: AUTH, body: JSON.stringify({ packageId: PKG_ID }) });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.json && res.json.error, "paypal_not_enabled");
    assert.ok(!mock.calls.some((c) => c.u.includes("/v2/checkout/orders")), "no order is created when the coach cannot take PayPal");
  } finally { mock.restore(); server.close(); }
});

test("POST /paypal/create-order rejects a client-supplied price (400)", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([authRoute(), ...packageRoutes(), coachPaypalRoute()]);
  try {
    const res = await request(port, { method: "POST", path: "/paypal/create-order", headers: AUTH, body: JSON.stringify({ packageId: PKG_ID, amountCents: 100 }) });
    assert.strictEqual(res.status, 400, "the client may never name a price");
  } finally { mock.restore(); server.close(); }
});

test("POST /paypal/create-order requires a packageId (400)", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([authRoute()]);
  try {
    const res = await request(port, { method: "POST", path: "/paypal/create-order", headers: AUTH, body: JSON.stringify({}) });
    assert.strictEqual(res.status, 400);
  } finally { mock.restore(); server.close(); }
});

test("POST /paypal/create-order returns { orderId, approveUrl } with a server-side amount", async () => {
  __resetTokenCache();
  const { server, port } = await startServer();
  const mock = installFetchMock([
    authRoute(), ...packageRoutes(), coachPaypalRoute(),
    paypalOAuthRoute(), paypalCreateRoute(),
  ]);
  try {
    const res = await request(port, { method: "POST", path: "/paypal/create-order", headers: AUTH, body: JSON.stringify({ packageId: PKG_ID }) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.orderId, ORDER_ID);
    assert.strictEqual(res.json.approveUrl, APPROVE_URL);
    // The amount PayPal received is the SERVER package price (5000c -> "50.00"),
    // never a client value, and custom_id carries the tenant context.
    const createCall = mock.calls.find((c) => c.u.endsWith("/v2/checkout/orders") && c.method === "POST");
    assert.ok(createCall, "an order was created");
    assert.strictEqual(createCall.body.purchase_units[0].amount.value, "50.00");
    assert.strictEqual(createCall.body.purchase_units[0].custom_id, `${COACH_ID}:${PKG_ID}`);
    assert.strictEqual(createCall.body.intent, "CAPTURE");
  } finally { mock.restore(); server.close(); }
});

// ===========================================================================
// return capture mints one row; replayed webhook changes zero rows
// ===========================================================================

function webhookBody(orderId = ORDER_ID, value = "50.00") {
  return JSON.stringify({
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      id: "CAP-WEBHOOK-1",
      amount: { value, currency_code: "USD" },
      custom_id: `${COACH_ID}:${PKG_ID}`,
      create_time: "2026-07-22T12:00:05Z",
      supplementary_data: { related_ids: { order_id: orderId } },
    },
  });
}

test("return capture mints exactly one payments row; a replayed webhook changes zero rows", async () => {
  __resetTokenCache();
  const { server, port } = await startServer();
  const store = paymentsStore();
  const mock = installFetchMock([
    paypalOAuthRoute(), paypalCaptureRoute(), paypalVerifyRoute("SUCCESS"),
    ...store.routes,
  ]);
  try {
    // 1) Buyer returns from PayPal: capture + mirror. Exactly one row is written.
    const ret = await request(port, { method: "GET", path: `/paypal/return?token=${ORDER_ID}` });
    assert.strictEqual(ret.status, 200);
    assert.match(ret.text, /all set/i, "the done page confirms success");
    assert.strictEqual(store.rowCount(), 1, "the return capture mints exactly one payments row");
    assert.strictEqual(store.posts.length, 1, "exactly one insert attempted");
    const row = store.posts[0];
    assert.strictEqual(row.collected_via, "paypal");
    assert.strictEqual(row.entry_source, "paypal_webhook");
    assert.strictEqual(row.matched_by, "paypal_webhook");
    assert.strictEqual(row.paypal_order_id, ORDER_ID);
    assert.strictEqual(row.coach_id, COACH_ID, "coach_id resolved from the order custom_id");
    assert.strictEqual(row.amount_cents, 5000);

    // 2) The webhook redelivers the SAME order (belt-and-braces). ZERO new rows,
    //    and — the app-level idempotency guard — ZERO new insert attempts.
    const postsBefore = store.posts.length;
    const wh = await request(port, {
      method: "POST", path: "/paypal/webhook",
      headers: { "content-type": "application/json", "paypal-transmission-id": "t1", "paypal-transmission-sig": "s1", "paypal-cert-url": "c", "paypal-auth-algo": "a", "paypal-transmission-time": "2026-07-22T12:00:06Z" },
      body: webhookBody(),
    });
    assert.strictEqual(wh.status, 200, "the webhook acks 200");
    assert.strictEqual(store.rowCount(), 1, "the replay changes zero rows");
    assert.strictEqual(store.posts.length - postsBefore, 0, "the replay issues zero payments inserts (pre-check idempotency guard)");
  } finally { mock.restore(); server.close(); }
});

test("webhook with a bad signature is rejected 400; unknown event types ack 200", async () => {
  __resetTokenCache();
  const { server, port } = await startServer();
  const store = paymentsStore();
  const badSig = installFetchMock([paypalOAuthRoute(), paypalVerifyRoute("FAILURE"), ...store.routes]);
  try {
    const res = await request(port, {
      method: "POST", path: "/paypal/webhook",
      headers: { "content-type": "application/json", "paypal-transmission-id": "t", "paypal-transmission-sig": "s", "paypal-cert-url": "c", "paypal-auth-algo": "a", "paypal-transmission-time": "x" },
      body: webhookBody(),
    });
    assert.strictEqual(res.status, 400, "a signature that does not verify is the one 400 case");
    assert.strictEqual(store.posts.length, 0, "no mirror on an unverified event");
  } finally { badSig.restore(); server.close(); }

  __resetTokenCache();
  const { server: s2, port: p2 } = await startServer();
  const store2 = paymentsStore();
  const okSig = installFetchMock([paypalOAuthRoute(), paypalVerifyRoute("SUCCESS"), ...store2.routes]);
  try {
    const res = await request(p2, {
      method: "POST", path: "/paypal/webhook",
      headers: { "content-type": "application/json", "paypal-transmission-id": "t", "paypal-transmission-sig": "s", "paypal-cert-url": "c", "paypal-auth-algo": "a", "paypal-transmission-time": "x" },
      body: JSON.stringify({ event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "x" } }),
    });
    assert.strictEqual(res.status, 200, "a verified but non-handled type acks 200");
    assert.strictEqual(store2.posts.length, 0, "an ignored event mirrors nothing");
  } finally { okSig.restore(); s2.close(); }
});

// ===========================================================================
// counter-metric: payment-claims never admits paypal as a claim rail
// ===========================================================================

test("payment-claims rejects paypal as a claim rail (counter-metric)", async () => {
  // The frozen claim-rail set must never include paypal (paypal money mirrors
  // through the capture lane, it is never an out-of-band 'I paid' claim).
  assert.ok(!CLAIM_RAILS.has("paypal"), "paypal is NOT a claim rail");

  const mock = installFetchMock([]);
  try {
    const r = await createClaim({ coachId: COACH_ID, amount_cents: 5000, claimed_rail: "paypal" });
    assert.ok(r.error, "a paypal claim is rejected");
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/payment_claims") && c.method === "POST"),
      "no claim row is inserted for a paypal rail",
    );
  } finally { mock.restore(); }
});

void stripeSigNoop;
