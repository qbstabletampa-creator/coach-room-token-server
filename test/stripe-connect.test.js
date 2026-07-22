// Stripe Connect Standard module unit tests. No index.js and no live Stripe:
// global.fetch is mocked to route Supabase PostgREST by URL+method, and the
// Stripe SDK is injected via deps (getStripeSecretKey / getStripeClient). Covers
// account create + reuse, onboarding link, live status refresh, the account.updated
// webhook coach-resolution by connected-account id, routingForCheckout eligibility,
// and the coach-authed route handler auth gate.

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
delete process.env.STRIPE_SECRET_KEY; // default => simulated

const connect = require("../lib/stripe-connect.js");

const COACH_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function okr(json, status = 200) {
  return { ok: status < 400, status, json: async () => json, text: async () => "" };
}

// Mock global.fetch against a route table; record every call so a test can assert
// what was written. Unmatched calls return an empty ok so incidental reads pass.
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

function fakeStripe(capture, over = {}) {
  return {
    accounts: {
      create: async (params) => { capture.accountsCreate.push(params); return { id: over.newAccountId || "acct_live_1" }; },
      retrieve: async (id) => { capture.accountsRetrieve.push(id); return over.retrieveReturn || { id, charges_enabled: true, details_submitted: true, payouts_enabled: true }; },
    },
    accountLinks: {
      create: async (params) => { capture.linksCreate.push(params); return { url: over.linkUrl || "https://connect.stripe.com/setup/acct_live_1" }; },
    },
  };
}
function newCapture() { return { accountsCreate: [], accountsRetrieve: [], linksCreate: [] }; }
const realDeps = (capture, over) => ({
  getStripeSecretKey: () => "sk_test_x",
  getStripeClient: () => fakeStripe(capture, over),
});

// ---------------------------------------------------------------------------
// createConnectAccount
// ---------------------------------------------------------------------------

test("createConnectAccount (simulated) mints a stable fake id and persists pending", async () => {
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && u.includes("id=eq.") && m === "GET", reply: () => okr([{ id: COACH_ID, stripe_account_id: null, connect_status: null }]) },
    { test: (u, m) => u.includes("/coaches") && m === "PATCH", reply: () => okr(null, 204) },
  ]);
  try {
    const out = await connect.createConnectAccount({ coachId: COACH_ID });
    assert.equal(out.simulated, true);
    assert.equal(out.reused, false);
    assert.match(out.accountId, /^acct_sim_/);
    assert.equal(out.connectStatus, "pending");
    const patch = mock.calls.find((c) => c.u.includes("/coaches") && c.method === "PATCH");
    assert.equal(patch.body.stripe_account_id, out.accountId);
    assert.equal(patch.body.connect_status, "pending");
  } finally { mock.restore(); }
});

test("createConnectAccount is idempotent — an existing account is reused, never re-created", async () => {
  const capture = newCapture();
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && u.includes("id=eq.") && m === "GET", reply: () => okr([{ id: COACH_ID, stripe_account_id: "acct_existing", connect_status: "enabled" }]) },
    { test: (u, m) => u.includes("/coaches") && m === "PATCH", reply: () => okr(null, 204) },
  ]);
  try {
    const out = await connect.createConnectAccount({ coachId: COACH_ID }, realDeps(capture));
    assert.equal(out.reused, true);
    assert.equal(out.accountId, "acct_existing");
    assert.equal(capture.accountsCreate.length, 0, "no new Stripe account is created");
  } finally { mock.restore(); }
});

test("createConnectAccount (real) creates a type=standard account and persists it", async () => {
  const capture = newCapture();
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && u.includes("id=eq.") && m === "GET", reply: () => okr([{ id: COACH_ID, stripe_account_id: null, connect_status: null }]) },
    { test: (u, m) => u.includes("/coaches") && m === "PATCH", reply: () => okr(null, 204) },
  ]);
  try {
    const out = await connect.createConnectAccount({ coachId: COACH_ID }, realDeps(capture));
    assert.equal(out.simulated, false);
    assert.equal(out.accountId, "acct_live_1");
    assert.equal(capture.accountsCreate[0].type, "standard");
    assert.equal(capture.accountsCreate[0].metadata.coach_id, COACH_ID);
    const patch = mock.calls.find((c) => c.u.includes("/coaches") && c.method === "PATCH");
    assert.equal(patch.body.stripe_account_id, "acct_live_1");
    assert.equal(patch.body.connect_status, "pending");
  } finally { mock.restore(); }
});

// ---------------------------------------------------------------------------
// createOnboardingLink
// ---------------------------------------------------------------------------

test("createOnboardingLink (real) creates an account_onboarding link with env URLs", async () => {
  const capture = newCapture();
  process.env.CONNECT_REFRESH_URL = "https://x.app/refresh";
  process.env.CONNECT_RETURN_URL = "https://x.app/return";
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && u.includes("id=eq.") && m === "GET", reply: () => okr([{ id: COACH_ID, stripe_account_id: "acct_live_1", connect_status: "pending" }]) },
    { test: (u, m) => u.includes("/coaches") && m === "PATCH", reply: () => okr(null, 204) },
  ]);
  try {
    const out = await connect.createOnboardingLink({ coachId: COACH_ID }, realDeps(capture));
    assert.equal(out.accountId, "acct_live_1");
    assert.ok(out.url.startsWith("https://connect.stripe.com/"));
    assert.equal(capture.linksCreate[0].type, "account_onboarding");
    assert.equal(capture.linksCreate[0].account, "acct_live_1");
    assert.equal(capture.linksCreate[0].refresh_url, "https://x.app/refresh");
    assert.equal(capture.linksCreate[0].return_url, "https://x.app/return");
  } finally {
    delete process.env.CONNECT_REFRESH_URL;
    delete process.env.CONNECT_RETURN_URL;
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// getConnectStatus
// ---------------------------------------------------------------------------

test("getConnectStatus (real) reads Stripe, maps charges_enabled to 'enabled', persists it", async () => {
  const capture = newCapture();
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && u.includes("id=eq.") && m === "GET", reply: () => okr([{ id: COACH_ID, stripe_account_id: "acct_live_1", connect_status: "pending" }]) },
    { test: (u, m) => u.includes("/coaches") && m === "PATCH", reply: () => okr(null, 204) },
  ]);
  try {
    const out = await connect.getConnectStatus({ coachId: COACH_ID }, realDeps(capture));
    assert.equal(out.status, "enabled");
    assert.equal(out.charges_enabled, true);
    assert.equal(capture.accountsRetrieve[0], "acct_live_1");
    const patch = mock.calls.find((c) => c.u.includes("/coaches") && c.method === "PATCH");
    assert.equal(patch.body.connect_status, "enabled");
  } finally { mock.restore(); }
});

test("getConnectStatus maps details-without-charges to 'restricted'", async () => {
  const capture = newCapture();
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && u.includes("id=eq.") && m === "GET", reply: () => okr([{ id: COACH_ID, stripe_account_id: "acct_live_1", connect_status: "pending" }]) },
    { test: (u, m) => u.includes("/coaches") && m === "PATCH", reply: () => okr(null, 204) },
  ]);
  try {
    const out = await connect.getConnectStatus(
      { coachId: COACH_ID },
      realDeps(capture, { retrieveReturn: { id: "acct_live_1", charges_enabled: false, details_submitted: true, payouts_enabled: false } }),
    );
    assert.equal(out.status, "restricted");
    assert.equal(out.charges_enabled, false);
  } finally { mock.restore(); }
});

test("getConnectStatus returns 'none' when the coach has no connected account", async () => {
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && u.includes("id=eq.") && m === "GET", reply: () => okr([{ id: COACH_ID, stripe_account_id: null, connect_status: null }]) },
  ]);
  try {
    const out = await connect.getConnectStatus({ coachId: COACH_ID }, realDeps(newCapture()));
    assert.equal(out.status, "none");
    assert.equal(out.accountId, null);
  } finally { mock.restore(); }
});

// ---------------------------------------------------------------------------
// handleAccountUpdated (webhook) — resolves the coach by connected-account id
// ---------------------------------------------------------------------------

test("handleAccountUpdated refreshes connect_status keyed by the connected account id", async () => {
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && u.includes("stripe_account_id=eq.") && m === "PATCH", reply: () => okr(null, 204) },
  ]);
  try {
    await connect.handleAccountUpdated({
      account: "acct_live_1",
      data: { object: { id: "acct_live_1", charges_enabled: true, details_submitted: true, payouts_enabled: true } },
    });
    const patch = mock.calls.find((c) => c.u.includes("stripe_account_id=eq.") && c.method === "PATCH");
    assert.ok(patch, "the coach row is resolved by the connected account id");
    assert.match(patch.u, /stripe_account_id=eq\.acct_live_1/);
    assert.equal(patch.body.connect_status, "enabled");
  } finally { mock.restore(); }
});

test("handleAccountUpdated with no account id is a safe no-op", async () => {
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && m === "PATCH", reply: () => okr(null, 204) },
  ]);
  try {
    await connect.handleAccountUpdated({ data: { object: {} } });
    assert.equal(mock.calls.some((c) => c.method === "PATCH"), false, "nothing is written without an account id");
  } finally { mock.restore(); }
});

// ---------------------------------------------------------------------------
// routingForCheckout — the eligibility the checkout handler consults
// ---------------------------------------------------------------------------

test("routingForCheckout returns null when CONNECT_ENABLED is off (platform path)", async () => {
  delete process.env.CONNECT_ENABLED;
  const mock = installFetchMock([]);
  try {
    const out = await connect.routingForCheckout({ coachId: COACH_ID });
    assert.equal(out, null);
  } finally { mock.restore(); }
});

test("routingForCheckout returns chargesEnabled true only for an 'enabled' account", async () => {
  process.env.CONNECT_ENABLED = "1";
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && u.includes("id=eq.") && m === "GET", reply: () => okr([{ id: COACH_ID, stripe_account_id: "acct_live_1", connect_status: "enabled" }]) },
  ]);
  try {
    const out = await connect.routingForCheckout({ coachId: COACH_ID });
    assert.deepEqual(out, { accountId: "acct_live_1", chargesEnabled: true });
  } finally { delete process.env.CONNECT_ENABLED; mock.restore(); }
});

test("routingForCheckout returns chargesEnabled false for a pending account (falls back to platform)", async () => {
  process.env.CONNECT_ENABLED = "1";
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && u.includes("id=eq.") && m === "GET", reply: () => okr([{ id: COACH_ID, stripe_account_id: "acct_live_1", connect_status: "pending" }]) },
  ]);
  try {
    const out = await connect.routingForCheckout({ coachId: COACH_ID });
    assert.deepEqual(out, { accountId: "acct_live_1", chargesEnabled: false });
  } finally { delete process.env.CONNECT_ENABLED; mock.restore(); }
});

test("routingForCheckout fails OPEN to platform (null) when the coach read throws", async () => {
  process.env.CONNECT_ENABLED = "1";
  const realFetch = global.fetch;
  global.fetch = async () => okr({ message: "db down" }, 503);
  try {
    const out = await connect.routingForCheckout({ coachId: COACH_ID });
    assert.equal(out, null, "a DB failure must never block a platform checkout");
  } finally { delete process.env.CONNECT_ENABLED; global.fetch = realFetch; }
});

// ---------------------------------------------------------------------------
// Route handler auth gate
// ---------------------------------------------------------------------------

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

test("connect route handler rejects a non-coach with 403", async () => {
  const handlers = connect.createConnectHandlers({
    requireSupabaseUser: async () => ({ user: { id: COACH_ID, app_metadata: { role: "athlete" } } }),
  });
  const res = fakeRes();
  await handlers.createAccount({}, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /coach role required/);
});

test("connect route handler propagates a 401 when the JWT is missing", async () => {
  const handlers = connect.createConnectHandlers({
    requireSupabaseUser: async () => ({ error: "unauthorized", status: 401 }),
  });
  const res = fakeRes();
  await handlers.status({}, res);
  assert.equal(res.statusCode, 401);
});

test("connect createAccount handler returns the account id for a coach", async () => {
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && u.includes("id=eq.") && m === "GET", reply: () => okr([{ id: COACH_ID, stripe_account_id: null, connect_status: null }]) },
    { test: (u, m) => u.includes("/coaches") && m === "PATCH", reply: () => okr(null, 204) },
  ]);
  try {
    const handlers = connect.createConnectHandlers({
      requireSupabaseUser: async () => ({ user: { id: COACH_ID, app_metadata: { role: "coach" } } }),
    });
    const res = fakeRes();
    await handlers.createAccount({}, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body.accountId, /^acct_sim_/);
    assert.equal(res.body.connectStatus, "pending");
  } finally { mock.restore(); }
});
