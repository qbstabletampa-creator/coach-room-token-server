const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const { createSessionHandler } = require("../lib/checkout");
const { buildBillingHandlers, subscriptionDto } = require("../lib/billing");

const COACH = "11111111-1111-4111-8111-111111111111";
const ATHLETE = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const PACKAGE = "44444444-4444-4444-8444-444444444444";
const ENROLLMENT = "55555555-5555-4555-8555-555555555555";

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "service";

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function ok(body = []) {
  return { ok: true, status: 200, json: async () => body, text: async () => "" };
}

function checkoutDeps(pkg, capture) {
  return {
    requireSupabaseUser: async () => ({ user: { id: USER, email: "buyer@example.com" } }),
    getPackage: async () => pkg,
    getStripeSecretKey: () => "sk_test_fake",
    billingEnabled: true,
    getUrls: () => ({ successUrl: "https://ok.test/success", cancelUrl: "https://ok.test/cancel" }),
    getStripeClient: () => ({
      customers: { create: async () => { throw new Error("existing customer should be reused"); } },
      checkout: { sessions: { create: async (params) => { capture.push(params); return { id: "cs_1", url: "https://checkout.stripe.test/1" }; } } },
    }),
  };
}

test("checkout emits exact one-time, membership, and plain-installment shapes", async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/athletes?")) return ok([{ id: ATHLETE, parent_email: "buyer@example.com" }]);
    if (u.includes("/stripe_customers?")) return ok([{ stripe_customer_id: "cus_shared" }]);
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const base = { id: PACKAGE, coach_id: COACH, name: "Plan", price_cents: 12000, active: true };
    const cases = [
      { pkg: { ...base, billing_type: "one_time" }, mode: "payment", amount: 12000 },
      { pkg: { ...base, billing_type: "subscription", billing_interval: "month", max_cycles: null, carry_forward: false, trial_days: 7, grace_days: 3 }, mode: "subscription", amount: 12000 },
      { pkg: { ...base, billing_type: "installment", billing_interval: "month", installment_count: 4, carry_forward: false, grace_days: 3 }, mode: "subscription", amount: 3000 },
    ];
    for (const c of cases) {
      const calls = [];
      const req = { body: { packageId: PACKAGE } };
      const res = response();
      await createSessionHandler(checkoutDeps(c.pkg, calls))(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.amountCents, c.amount);
      assert.equal(res.body.billing_type, c.pkg.billing_type);
      assert.equal(calls[0].mode, c.mode);
      assert.equal(calls[0].customer, "cus_shared");
      assert.equal(calls[0].line_items[0].price_data.unit_amount, c.amount);
      assert.deepEqual(calls[0].metadata, {
        package_id: PACKAGE, coach_id: COACH, athlete_id: ATHLETE,
        user_id: USER, billing_type: c.pkg.billing_type,
      });
      if (c.pkg.billing_type === "one_time") {
        assert.equal(calls[0].subscription_data, undefined);
        assert.equal(calls[0].line_items[0].price_data.recurring, undefined);
      } else {
        assert.deepEqual(calls[0].line_items[0].price_data.recurring, { interval: "month" });
        assert.equal(calls[0].subscription_data.metadata.package_id, PACKAGE);
        assert.equal(calls[0].subscription_data.metadata.installments_total,
          c.pkg.billing_type === "installment" ? "4" : "");
        assert.equal(calls[0].subscription_data.metadata.max_cycles,
          c.pkg.billing_type === "installment" ? "4" : "");
      }
    }
  } finally {
    global.fetch = realFetch;
  }
});

test("checkout rejects client price, disabled recurring, and non-divisible installments", async () => {
  const pkg = { id: PACKAGE, coach_id: COACH, name: "Split", price_cents: 10001, active: true,
    billing_type: "installment", billing_interval: "month", installment_count: 4 };
  let res = response();
  await createSessionHandler({ ...checkoutDeps(pkg, []), getStripeSecretKey: () => undefined })
    ({ body: { packageId: PACKAGE, price_cents: 1 } }, res);
  assert.equal(res.statusCode, 400);

  res = response();
  await createSessionHandler({ ...checkoutDeps(pkg, []), billingEnabled: false, getStripeSecretKey: () => undefined })
    ({ body: { packageId: PACKAGE } }, res);
  assert.deepEqual([res.statusCode, res.body.error], [404, "billing_not_enabled"]);

  res = response();
  await createSessionHandler({ ...checkoutDeps(pkg, []), getStripeSecretKey: () => undefined })
    ({ body: { packageId: PACKAGE } }, res);
  assert.deepEqual([res.statusCode, res.body.error], [400, "installment_price_not_divisible"]);
});

test("index package authority selects every frozen billing field", () => {
  const source = fs.readFileSync(require.resolve("../index"), "utf8");
  assert.match(source,
    /select=id,coach_id,name,price_cents,credits,active,billing_type,billing_interval,installment_count,auto_renew,max_cycles,carry_forward,trial_days,grace_days&limit=1/);
  assert.match(source, /getPackage\(packageId, userId\)/);
  assert.match(source, /coach_id=eq\.\$\{encodeURIComponent\(coachId\)\}/);
});

test("simulated recurring checkout is keyless and returns the expanded DTO", async () => {
  const pkg = { id: PACKAGE, coach_id: COACH, name: "Monthly", price_cents: 2500, active: true,
    billing_type: "subscription", billing_interval: "month" };
  const res = response();
  await createSessionHandler({ ...checkoutDeps(pkg, []), getStripeSecretKey: () => undefined })
    ({ body: { packageId: PACKAGE } }, res);
  assert.deepEqual(Object.keys(res.body).sort(), [
    "amountCents", "billing_interval", "billing_type", "clientSecret", "installments_total",
    "packageId", "sessionId", "simulated", "url",
  ].sort());
  assert.equal(res.body.simulated, true);
  assert.equal(res.body.clientSecret, null);
});

test("real checkout rejects an athlete outside the package tenant with 403", async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("/athletes?")) return ok([]);
    throw new Error(`unexpected fetch ${url}`);
  };
  const pkg = { id: PACKAGE, coach_id: COACH, name: "Monthly", price_cents: 2500,
    active: true, billing_type: "subscription", billing_interval: "month" };
  try {
    const res = response();
    await createSessionHandler(checkoutDeps(pkg, []))({ body: { packageId: PACKAGE } }, res);
    assert.deepEqual([res.statusCode, res.body], [403, { error: "athlete_not_in_tenant" }]);
  } finally { global.fetch = realFetch; }
});

function enrollment(overrides = {}) {
  return {
    id: ENROLLMENT, package_id: PACKAGE, athlete_id: ATHLETE,
    purchaser_email: "buyer@example.com", billing_type: "subscription", status: "active",
    cycles_completed: 2, max_cycles: null, current_period_end: "2026-08-01T00:00:00.000Z",
    grace_until: null, cancel_at_period_end: false, stripe_subscription_id: "sub_1",
    packages: { name: "Monthly" }, athletes: { name: "Avery" }, ...overrides,
  };
}

test("billing DTO has the frozen exact keys", () => {
  assert.deepEqual(Object.keys(subscriptionDto(enrollment())), [
    "id", "package_id", "package_name", "athlete_id", "athlete_name", "purchaser_email",
    "billing_type", "status", "cycles_completed", "max_cycles", "current_period_end",
    "grace_until", "cancel_at_period_end",
  ]);
});

test("list returns exact DTO/empty state and manually tenant-scopes the service read", async () => {
  const realFetch = global.fetch;
  const urls = [];
  global.fetch = async (url) => { urls.push(String(url)); return ok([]); };
  try {
    const handlers = buildBillingHandlers({
      requireSupabaseUser: async () => ({ user: { id: COACH, app_metadata: { role: "coach" } } }),
    });
    const res = response();
    await handlers.getSubscriptions({}, res);
    assert.deepEqual(res.body, { subscriptions: [] });
    assert.ok(urls[0].includes(`coach_id=eq.${COACH}`));
  } finally { global.fetch = realFetch; }
});

test("billing management rejects non-coach callers with the frozen 403", async () => {
  const handlers = buildBillingHandlers({
    requireSupabaseUser: async () => ({ user: { id: USER, app_metadata: { role: "athlete" } } }),
  });
  const res = response();
  await handlers.getSubscriptions({}, res);
  assert.deepEqual([res.statusCode, res.body], [403, { error: "coach_access_required" }]);
});

test("pause/resume/cancel use exact Stripe params; a foreign id is locked before Stripe", async () => {
  const realFetch = global.fetch;
  const stripeCalls = [];
  let row = enrollment();
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if ((opts.method || "GET") === "GET" && u.includes("billing_subscriptions")) {
      return ok(u.includes(`coach_id=eq.${COACH}`) && row ? [row] : []);
    }
    if (opts.method === "PATCH") {
      row = { ...row, ...JSON.parse(opts.body) };
      return ok([row]);
    }
    if (u.includes("package_purchases")) return ok([]);
    throw new Error(`unexpected ${opts.method || "GET"} ${u}`);
  };
  const stripe = {
    subscriptions: {
      update: async (id, params) => { stripeCalls.push(["update", id, params]); return { status: "active" }; },
      cancel: async (id) => { stripeCalls.push(["cancel", id]); return {}; },
    },
  };
  try {
    const handlers = buildBillingHandlers({
      requireSupabaseUser: async () => ({ user: { id: COACH, app_metadata: { role: "coach" } } }),
      getStripeClient: () => stripe,
    });
    let res = response();
    await handlers.postPause({ body: { subscription_id: ENROLLMENT } }, res);
    assert.deepEqual(stripeCalls[0], ["update", "sub_1", { pause_collection: { behavior: "void" } }]);
    row.status = "paused";
    res = response();
    await handlers.postResume({ body: { subscription_id: ENROLLMENT } }, res);
    assert.deepEqual(stripeCalls[1], ["update", "sub_1", { pause_collection: "" }]);
    row.status = "active";
    res = response();
    await handlers.postCancel({ body: { subscription_id: ENROLLMENT } }, res);
    assert.deepEqual(stripeCalls[2], ["update", "sub_1", { cancel_at_period_end: true }]);

    row.status = "active";
    row.cancel_at_period_end = false;
    res = response();
    await handlers.postCancel({ body: { subscription_id: ENROLLMENT, when: "now" } }, res);
    assert.deepEqual(stripeCalls[3], ["cancel", "sub_1"]);
    assert.equal(res.body.subscription.status, "canceled");

    row = null;
    res = response();
    await handlers.postPause({ body: { subscription_id: "66666666-6666-4666-8666-666666666666" } }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(stripeCalls.length, 4, "cross-tenant/unknown ownership fails before Stripe");
  } finally { global.fetch = realFetch; }
});
