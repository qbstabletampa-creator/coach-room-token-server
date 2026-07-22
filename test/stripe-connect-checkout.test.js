// Checkout Connect routing: the real createSessionHandler (lib/checkout.js) is
// driven in REAL mode with an injected fake Stripe SDK and an injected connect
// router. Proves a DIRECT charge on the connected account when the coach is
// eligible, and unchanged PLATFORM behavior when not (pending account or flag
// off). Supabase reads are mocked via global.fetch (same idiom as payments.test.js).

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";

const { createSessionHandler } = require("../lib/checkout.js");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const COACH_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ATHLETE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PKG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";

function okr(json, status = 200) {
  return { ok: status < 400, status, json: async () => json, text: async () => "" };
}

function installFetchMock() {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ u, method });
    if (u.includes("/rest/v1/athletes") && method === "GET") {
      return okr([{ id: ATHLETE_ID, parent_email: "parent@example.com" }]);
    }
    if (u.includes("/rest/v1/stripe_customers") && method === "GET") return okr([]);
    if (u.includes("/rest/v1/stripe_customers") && method === "POST") return okr(null, 201);
    return okr([]);
  };
  return { calls, restore() { global.fetch = realFetch; } };
}

function fakeStripe(capture) {
  return {
    customers: {
      create: async (_params, opts) => { capture.customerOpts = opts; return { id: "cus_1" }; },
    },
    checkout: {
      sessions: {
        create: async function (params, opts) {
          capture.sessionParams = params;
          capture.sessionOpts = opts;
          capture.sessionArgc = arguments.length;
          return { id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" };
        },
      },
    },
  };
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

function buildHandler(capture, resolveConnectRouting) {
  return createSessionHandler({
    requireSupabaseUser: async () => ({ user: { id: USER_ID, email: "parent@example.com" } }),
    getPackage: async () => ({ id: PKG_ID, coach_id: COACH_ID, name: "5-Pack", price_cents: 5000, active: true, billing_type: "one_time" }),
    getStripeSecretKey: () => "sk_test_x",
    getStripeClient: () => fakeStripe(capture),
    resolveConnectRouting,
  });
}

test("checkout routes a DIRECT charge to the connected account when the coach is eligible", async () => {
  const mock = installFetchMock();
  const capture = {};
  const handler = buildHandler(capture, async () => ({ accountId: "acct_live_1", chargesEnabled: true }));
  try {
    const res = fakeRes();
    await handler({ body: { packageId: PKG_ID }, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.connected, true, "response marks the session as connected");
    assert.equal(res.body.sessionId, "cs_1");
    assert.equal(capture.customerOpts.stripeAccount, "acct_live_1", "the customer is created ON the connected account");
    assert.equal(capture.sessionOpts.stripeAccount, "acct_live_1", "the Checkout Session is created ON the connected account");
    // Direct charge => coach is merchant of record: NO application fee / transfer.
    assert.equal(capture.sessionParams.application_fee_amount, undefined);
    assert.equal(capture.sessionParams.transfer_data, undefined);
  } finally { mock.restore(); }
});

test("checkout stays on the PLATFORM account when the connected account is not charge-enabled", async () => {
  const mock = installFetchMock();
  const capture = {};
  const handler = buildHandler(capture, async () => ({ accountId: "acct_live_1", chargesEnabled: false }));
  try {
    const res = fakeRes();
    await handler({ body: { packageId: PKG_ID }, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.connected, false);
    assert.equal(capture.sessionOpts, undefined, "platform charge passes NO options object at all");
    assert.equal(capture.customerOpts.stripeAccount, undefined);
  } finally { mock.restore(); }
});

test("checkout stays on the PLATFORM account when connect routing returns null (flag off)", async () => {
  const mock = installFetchMock();
  const capture = {};
  const handler = buildHandler(capture, async () => null);
  try {
    const res = fakeRes();
    await handler({ body: { packageId: PKG_ID }, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.connected, false);
    assert.equal(capture.sessionOpts, undefined);
  } finally { mock.restore(); }
});

// Regression (2026-07-22 e2e CRITICAL #1): stripe-node rejects an EMPTY options
// object on sessions.create ("Unknown arguments"), 502ing every platform
// checkout. The platform path must be the exact single-argument call; only a
// real connected charge passes options.
test("platform checkout calls sessions.create with ONE argument (empty options 502s on real stripe-node)", async () => {
  const mock = installFetchMock();
  const capture = {};
  const handler = buildHandler(capture, async () => null);
  try {
    const res = fakeRes();
    await handler({ body: { packageId: PKG_ID }, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(capture.sessionArgc, 1, "platform path must not pass a second (empty) options arg");
  } finally { mock.restore(); }
});

test("connected checkout calls sessions.create WITH options carrying stripeAccount", async () => {
  const mock = installFetchMock();
  const capture = {};
  const handler = buildHandler(capture, async () => ({ accountId: "acct_live_1", chargesEnabled: true }));
  try {
    const res = fakeRes();
    await handler({ body: { packageId: PKG_ID }, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(capture.sessionArgc, 2);
    assert.equal(capture.sessionOpts.stripeAccount, "acct_live_1");
  } finally { mock.restore(); }
});

test("a connect routing failure falls OPEN to the platform charge (never blocks the sale)", async () => {
  const mock = installFetchMock();
  const capture = {};
  const handler = buildHandler(capture, async () => { throw new Error("routing exploded"); });
  try {
    const res = fakeRes();
    await handler({ body: { packageId: PKG_ID }, headers: {} }, res);
    assert.equal(res.statusCode, 200, "the sale still completes on the platform account");
    assert.equal(res.body.connected, false);
    assert.equal(capture.sessionOpts, undefined);
  } finally { mock.restore(); }
});

// ===========================================================================
// Account-scoped customer mapping (e2e rerun MAJOR, 2026-07-22): a platform
// customer id is NOT usable on a connected account. The connected path must
// ignore stripe_customers (platform mapping) entirely and use the
// account-scoped stripe_connect_customers table (migration 0034).
// ===========================================================================

test("connected checkout NEVER reuses a platform customer: creates on the connected account and maps in stripe_connect_customers", async () => {
  const realFetch = global.fetch;
  const posts = [];
  const gets = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    if (u.includes("/rest/v1/athletes") && method === "GET") {
      return okr([{ id: ATHLETE_ID, parent_email: "parent@example.com" }]);
    }
    if (u.includes("/rest/v1/stripe_connect_customers") && method === "GET") { gets.push(u); return okr([]); }
    if (u.includes("/rest/v1/stripe_connect_customers") && method === "POST") { posts.push(JSON.parse(opts.body)); return okr(null, 201); }
    if (u.includes("/rest/v1/stripe_customers") && method === "GET") {
      // A stale PLATFORM mapping exists for this (coach, athlete) pair.
      return okr([{ stripe_customer_id: "cus_platform_stale" }]);
    }
    return okr([]);
  };
  const capture = {};
  const handler = buildHandler(capture, async () => ({ accountId: "acct_live_1", chargesEnabled: true }));
  try {
    const res = fakeRes();
    await handler({ body: { packageId: PKG_ID }, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(capture.customerOpts, "a NEW customer must be created (the platform mapping is not reusable)");
    assert.equal(capture.customerOpts.stripeAccount, "acct_live_1", "created ON the connected account");
    assert.equal(gets.length, 1, "lookup hits the account-scoped table");
    assert.ok(gets[0].includes("stripe_account_id=eq.acct_live_1"), "lookup filters by the connected account");
    assert.equal(posts.length, 1, "mapping stored in stripe_connect_customers");
    assert.equal(posts[0].stripe_account_id, "acct_live_1");
  } finally { global.fetch = realFetch; }
});
