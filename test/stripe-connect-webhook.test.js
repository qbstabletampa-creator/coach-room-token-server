// Connect webhook behavior on the platform endpoint. Same harness as
// checkout-launch-refund.test.js: env set BEFORE requiring index.js so the route
// mounts; webhooks driven over real HTTP with a valid signature so the ROUTE's
// status code is exercised. Covers: account.updated resolves the coach by
// event.account and is gated by CONNECT_ENABLED; a connected checkout.session.completed
// (event.account set) still mints exactly once and is idempotent on redelivery.

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
process.env.STRIPE_WEBHOOK_ENABLED = "1";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.RESEND_API_KEY;

const { app } = require("../index.js");

const COACH_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ATHLETE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PKG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const PURCHASE_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SESSION_ID = "cs_connected_1";
const ACCT = "acct_coach_1";
const SECRET = "whsec_connectsecret";

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
      res.on("end", () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(data); } catch { return null; } })() }));
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
    return okr([]);
  };
  return { calls, restore() { global.fetch = realFetch; } };
}

function stripeSig(body, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

function postWebhook(port, type, object, extra = {}) {
  const body = JSON.stringify({ type, data: { object }, ...extra });
  return request(port, {
    path: "/stripe/webhook",
    headers: { "content-type": "application/json", "stripe-signature": stripeSig(body) },
    body,
  });
}

// ===========================================================================
// account.updated — coach resolution by event.account + flag gate
// ===========================================================================

test("account.updated (CONNECT_ENABLED) refreshes connect_status keyed by event.account", async () => {
  process.env.CONNECT_ENABLED = "1";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const { server, port } = await startServer();
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && u.includes("stripe_account_id=eq.") && m === "PATCH", reply: () => okr(null, 204) },
  ]);
  try {
    const res = await postWebhook(
      port,
      "account.updated",
      { id: ACCT, charges_enabled: true, details_submitted: true, payouts_enabled: true },
      { account: ACCT },
    );
    assert.equal(res.status, 200);
    const patch = mock.calls.find((c) => c.u.includes("stripe_account_id=eq.") && c.method === "PATCH");
    assert.ok(patch, "the coach is resolved by the connected account id");
    assert.match(patch.u, new RegExp(`stripe_account_id=eq\\.${ACCT}`));
    assert.equal(patch.body.connect_status, "enabled");
  } finally {
    delete process.env.CONNECT_ENABLED;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});

test("account.updated is IGNORED (200, no write) when CONNECT_ENABLED is off", async () => {
  // Default-on flag: OFF is the explicit emergency switch, not an unset env.
  process.env.CONNECT_ENABLED = "0";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const { server, port } = await startServer();
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && m === "PATCH", reply: () => okr(null, 204) },
  ]);
  try {
    const res = await postWebhook(
      port,
      "account.updated",
      { id: ACCT, charges_enabled: true, details_submitted: true },
      { account: ACCT },
    );
    assert.equal(res.status, 200, "an unhandled type is ack'd, never a retry-storm");
    assert.equal(mock.calls.some((c) => c.method === "PATCH"), false, "the flag being off means no status write");
  } finally {
    delete process.env.CONNECT_ENABLED;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// Connected checkout.session.completed — mint still idempotent under event.account
// ===========================================================================

const connectedSession = () => ({
  id: SESSION_ID,
  amount_total: 5000,
  payment_intent: "pi_connected_1",
  metadata: { packageId: PKG_ID },
  customer_details: { email: "buyer@example.com", name: "Buyer" },
});

function provisionRoutes({ precheck = () => okr([]) } = {}) {
  return [
    { test: (u, m) => u.includes("/package_purchases") && u.includes("stripe_session_id=eq.") && m === "GET", reply: (u2, m2, o) => precheck(u2, m2, o) },
    { test: (u, m) => u.includes("/packages") && m === "GET", reply: () => okr([{ id: PKG_ID, coach_id: COACH_ID, credits: 5, expires_days: 30 }]) },
    { test: (u, m) => u.includes("/athletes") && m === "GET", reply: () => okr([]) },
    { test: (u, m) => u.includes("/athletes") && m === "POST", reply: () => okr([{ id: ATHLETE_ID }]) },
    { test: (u, m) => u.includes("/athlete_claims") && m === "GET", reply: () => okr([]) },
    { test: (u, m) => u.includes("/athlete_claims") && m === "POST", reply: () => okr([{ token: "77777777-7777-4777-8777-777777777777" }]) },
    { test: (u, m) => u.includes("/package_purchases") && m === "POST", reply: () => okr([{ id: PURCHASE_ID }], 201) },
    { test: (u, m) => u.includes("/rest/v1/payments") && u.includes("stripe_session_id=eq.") && m === "GET", reply: () => okr([]) },
    { test: (u, m) => u.includes("/rest/v1/payments") && m === "POST", reply: () => okr([{ id: "mirror-1" }], 201) },
  ];
}

test("a connected checkout.session.completed (event.account set) mints exactly one purchase", async () => {
  process.env.CONNECT_ENABLED = "1";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const { server, port } = await startServer();
  const mock = installFetchMock(provisionRoutes());
  try {
    const res = await postWebhook(port, "checkout.session.completed", connectedSession(), { account: ACCT });
    assert.equal(res.status, 200);
    const purchasePosts = mock.calls.filter((c) => c.u.includes("/package_purchases") && c.method === "POST");
    assert.equal(purchasePosts.length, 1, "the connected session provisions via server-authoritative package metadata");
    assert.equal(purchasePosts[0].body.stripe_session_id, SESSION_ID, "the connected-account session id is stored as-is");
    assert.equal(purchasePosts[0].body.stripe_payment_intent_id, "pi_connected_1");
  } finally {
    delete process.env.CONNECT_ENABLED;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});

test("a redelivered connected session is idempotent — the pre-check no-ops, never a second mint", async () => {
  process.env.CONNECT_ENABLED = "1";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const { server, port } = await startServer();
  // The purchase already exists (pre-check finds it): redelivery must not re-insert.
  const mock = installFetchMock(
    provisionRoutes({ precheck: () => okr([{ id: PURCHASE_ID, coach_id: COACH_ID, athlete_id: ATHLETE_ID }]) }),
  );
  try {
    const res = await postWebhook(port, "checkout.session.completed", connectedSession(), { account: ACCT });
    assert.equal(res.status, 200);
    const purchasePosts = mock.calls.filter((c) => c.u.includes("/package_purchases") && c.method === "POST");
    assert.equal(purchasePosts.length, 0, "a duplicate connected delivery never re-mints");
  } finally {
    delete process.env.CONNECT_ENABLED;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// Dual-secret verification — prod runs TWO Stripe endpoints (platform +
// connect), each with its own signing secret (2026-07-22 go-live wiring).
// ===========================================================================

test("an event signed with STRIPE_CONNECT_WEBHOOK_SECRET verifies when set (second prod endpoint)", async () => {
  process.env.CONNECT_ENABLED = "1";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_endpoint";
  const { server, port } = await startServer();
  const patches = [];
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && m === "GET", reply: () => okr([{ id: COACH_ID }]) },
    { test: (u, m) => u.includes("/coaches") && m === "PATCH", reply: (u, m, o) => { patches.push(JSON.parse(o.body)); return okr(null, 204); } },
  ]);
  try {
    const body = JSON.stringify({
      type: "account.updated",
      data: { object: { id: ACCT, charges_enabled: true, details_submitted: true } },
      account: ACCT,
    });
    const t = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac("sha256", "whsec_connect_endpoint").update(`${t}.${body}`).digest("hex");
    const res = await request(port, {
      path: "/stripe/webhook",
      headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${v1}` },
      body,
    });
    assert.equal(res.status, 200, "connect-endpoint signature must verify via the fallback secret");
    assert.equal(patches.length, 1, "the verified connected event was processed");
    assert.equal(patches[0].connect_status, "enabled");
  } finally {
    delete process.env.CONNECT_ENABLED;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});

test("a garbage signature still 400s when both secrets are set (fallback is not a bypass)", async () => {
  process.env.CONNECT_ENABLED = "1";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_endpoint";
  const { server, port } = await startServer();
  const mock = installFetchMock([]);
  try {
    const body = JSON.stringify({ type: "account.updated", data: { object: { id: ACCT } }, account: ACCT });
    const t = Math.floor(Date.now() / 1000);
    const res = await request(port, {
      path: "/stripe/webhook",
      headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=deadbeef` },
      body,
    });
    assert.equal(res.status, 400, "neither secret matches => bad signature");
  } finally {
    delete process.env.CONNECT_ENABLED;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    mock.restore();
    server.close();
  }
});
