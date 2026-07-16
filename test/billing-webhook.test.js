const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  handleBillingCheckoutCompleted,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
} = require("../lib/billing");
const { stripeWebhookHandler } = require("../lib/stripe-webhook");

const COACH = "11111111-1111-4111-8111-111111111111";
const ATHLETE = "22222222-2222-4222-8222-222222222222";
const PACKAGE = "33333333-3333-4333-8333-333333333333";
const ENROLLMENT = "44444444-4444-4444-8444-444444444444";
const s = { url: "https://test.supabase.co", headers: { authorization: "Bearer service" } };

function ok(body = [], status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => status === 409 ? "23505" : "",
  };
}

function baseEnrollment(overrides = {}) {
  return {
    id: ENROLLMENT,
    coach_id: COACH,
    package_id: PACKAGE,
    athlete_id: ATHLETE,
    purchaser_email: "payer@example.com",
    billing_type: "subscription",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    status: "active",
    carry_forward: false,
    cycles_completed: 0,
    max_cycles: null,
    grace_days: 3,
    current_period_end: null,
    grace_until: null,
    cancel_at_period_end: false,
    ...overrides,
  };
}

function subscription(metadata = {}) {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    current_period_end: 1788134400,
    cancel_at_period_end: false,
    metadata: {
      coach_id: COACH,
      athlete_id: ATHLETE,
      package_id: PACKAGE,
      billing_type: "subscription",
      installments_total: "",
      max_cycles: "",
      carry_forward: "false",
      grace_days: "3",
      ...metadata,
    },
  };
}

function invoice(id, amount, sub = subscription(), created = 1785542400) {
  return { id, amount_paid: amount, currency: "USD", created, subscription: sub };
}

function installDb(state) {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ u, method, body });

    if (method === "GET" && u.includes("/billing_subscriptions?")) {
      return ok(state.enrollment ? [{ ...state.enrollment }] : []);
    }
    if (method === "GET" && u.includes("/packages?")) {
      return ok([{
        id: PACKAGE,
        credits: state.credits ?? 8,
        expires_days: state.expiresDays ?? null,
        billing_type: state.packageBillingType || "subscription",
        carry_forward: false,
        max_cycles: null,
        installment_count: state.installmentCount || null,
        grace_days: 3,
      }]);
    }
    if (method === "GET" && u.includes("/stripe_customers?")) {
      return ok(state.customerExists === false ? [] : [{ stripe_customer_id: "cus_1" }]);
    }
    if (method === "GET" && u.includes("/athletes?")) {
      return ok(state.athleteInTenant === false ? [] :
        [{ id: ATHLETE, user_id: "athlete-user", parent_email: "parent@example.com" }]);
    }
    if (method === "POST" && u.endsWith("/stripe_customers")) {
      state.customerInserts = (state.customerInserts || 0) + 1;
      return ok([body], 201);
    }
    if (method === "POST" && u.endsWith("/billing_subscriptions")) {
      state.enrollment = { id: ENROLLMENT, ...body };
      state.enrollmentInserts = (state.enrollmentInserts || 0) + 1;
      return ok([state.enrollment], 201);
    }
    if (method === "POST" && u.endsWith("/rpc/mint_billing_cycle")) {
      if (state.mintRpcStatus) return ok({ message: "mint RPC unavailable" }, state.mintRpcStatus);
      let result;
      if (state.mintResults?.length) {
        result = state.mintResults.shift();
      } else {
        const cycle = Number(state.enrollment.cycles_completed || 0) + 1;
        result = {
          minted: true,
          purchase_id: `purchase-${cycle}`,
          cycle,
          completed: state.enrollment.max_cycles != null && cycle >= state.enrollment.max_cycles,
        };
      }
      if (result.minted) {
        state.enrollment.cycles_completed = result.cycle;
        if (result.completed) state.enrollment.status = "completed";
      }
      return ok(result);
    }
    if (method === "POST" && u.endsWith("/rpc/freeze_subscription_credits")) {
      if (state.freezeRpcStatus) return ok({ message: "freeze RPC unavailable" }, state.freezeRpcStatus);
      const result = state.freezeResults?.length
        ? state.freezeResults.shift()
        : { frozen: state.enrollment.status === "canceled" ? 0 : 1,
            already: state.enrollment.status === "canceled" };
      state.enrollment.status = "canceled";
      return ok(result);
    }
    if (method === "PATCH" && u.includes("/billing_subscriptions?")) {
      state.enrollment = { ...state.enrollment, ...body };
      return ok([{ ...state.enrollment }]);
    }
    throw new Error(`unexpected DB call ${method} ${u}`);
  };
  return { calls, restore: () => { global.fetch = realFetch; } };
}

function rpcBodies(db, name) {
  return db.calls.filter((call) => call.u.endsWith(`/rpc/${name}`)).map((call) => call.body);
}

async function signedWebhook(type, object) {
  const secret = "whsec_billing";
  const body = JSON.stringify({ type, data: { object } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  await stripeWebhookHandler({
    body: Buffer.from(body),
    headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
  }, res);
  return res;
}

test("subscription checkout completion creates enrollment and mints no credits/payment", async () => {
  const state = { enrollment: null, customerExists: true };
  const db = installDb(state);
  try {
    await handleBillingCheckoutCompleted({ data: { object: {
      id: "cs_sub",
      mode: "subscription",
      customer: "cus_1",
      subscription: subscription(),
      customer_details: { email: "payer@example.com" },
      metadata: { package_id: PACKAGE, coach_id: COACH, athlete_id: ATHLETE,
        billing_type: "subscription" },
    } } }, { supabase: s, stripe: { subscriptions: {} } });
    assert.equal(state.enrollment.stripe_subscription_id, "sub_1");
    assert.equal(rpcBodies(db, "mint_billing_cycle").length, 0);
    assert.equal(db.calls.some((call) => call.u.includes("/payments")), false);
  } finally { db.restore(); }
});

test("cross-tenant metadata athlete creates an athlete-less enrollment and logs", async () => {
  const state = { enrollment: null, athleteInTenant: false, customerExists: false };
  const db = installDb(state);
  const realError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await handleBillingCheckoutCompleted({ data: { object: {
      id: "cs_cross",
      mode: "subscription",
      customer: "cus_1",
      subscription: subscription(),
      customer_details: { email: "payer@example.com" },
      metadata: { package_id: PACKAGE, coach_id: COACH, athlete_id: ATHLETE,
        billing_type: "subscription" },
    } } }, { supabase: s, stripe: { subscriptions: {} } });
    assert.equal(state.customerInserts || 0, 0);
    assert.equal(state.enrollmentInserts, 1);
    assert.equal(state.enrollment.athlete_id, null);
    assert.match(errors.join("\n"), /outside package tenant; creating without athlete link/);
    const athleteRead = db.calls.find((call) => call.method === "GET" && call.u.includes("/athletes?"));
    assert.ok(athleteRead.u.includes(`id=eq.${ATHLETE}`));
    assert.ok(athleteRead.u.includes(`coach_id=eq.${COACH}`));
  } finally {
    console.error = realError;
    db.restore();
  }
});

test("subscription cycle sends exact reset and expiry policy to mint RPC", async () => {
  const created = 1785542400;
  const now = 1790000000000;
  const realDateNow = Date.now;
  Date.now = () => now;
  const state = { enrollment: baseEnrollment(), credits: 12, expiresDays: 30 };
  const db = installDb(state);
  try {
    await handleInvoicePaid({ data: { object: invoice("in_sub", 2500, subscription(), created) } }, {
      supabase: s,
      stripe: { subscriptions: { update: async () => {} } },
      mirrorStripePayment: async () => {},
      notify: async () => {},
    });
    assert.deepEqual(rpcBodies(db, "mint_billing_cycle"), [{
      p_subscription_id: ENROLLMENT,
      p_stripe_invoice_id: "in_sub",
      p_amount_cents: 2500,
      p_credits: 12,
      p_source: "subscription",
      p_expires_at: new Date(now + 30 * 86400000).toISOString(),
      p_reset_prior: true,
      p_purchased_at: new Date(created * 1000).toISOString(),
    }]);
    assert.equal(db.calls.some((call) => call.method === "POST" &&
      call.u.endsWith("/package_purchases")), false);
    assert.equal(db.calls.some((call) => call.method === "PATCH" &&
      call.u.includes("/package_purchases?")), false);
  } finally {
    Date.now = realDateNow;
    db.restore();
  }
});

test("carry-forward preserves prior packs through the mint RPC policy", async () => {
  const state = { enrollment: baseEnrollment({ carry_forward: true }), credits: 7 };
  const db = installDb(state);
  try {
    await handleInvoicePaid({ data: { object: invoice("in_carry", 1800) } }, {
      supabase: s,
      stripe: { subscriptions: { update: async () => {} } },
      mirrorStripePayment: async () => {},
      notify: async () => {},
    });
    assert.equal(rpcBodies(db, "mint_billing_cycle")[0].p_reset_prior, false);
    assert.equal(rpcBodies(db, "mint_billing_cycle")[0].p_credits, 7);
    assert.equal(rpcBodies(db, "mint_billing_cycle")[0].p_expires_at, null);
  } finally { db.restore(); }
});

test("installment cycle one grants full credits and later cycles grant zero", async () => {
  for (const { completed, expectedCredits, id } of [
    { completed: 0, expectedCredits: 10, id: "in_installment_1" },
    { completed: 1, expectedCredits: 0, id: "in_installment_2" },
  ]) {
    const state = {
      enrollment: baseEnrollment({ billing_type: "installment", cycles_completed: completed,
        max_cycles: 3 }),
      credits: 10,
    };
    const db = installDb(state);
    try {
      const sub = subscription({ billing_type: "installment", installments_total: "3",
        max_cycles: "3" });
      await handleInvoicePaid({ data: { object: invoice(id, 4000, sub) } }, {
        supabase: s,
        stripe: { subscriptions: { update: async () => {} } },
        mirrorStripePayment: async () => {},
        notify: async () => {},
      });
      const params = rpcBodies(db, "mint_billing_cycle")[0];
      assert.equal(params.p_credits, expectedCredits);
      assert.equal(params.p_source, "installment");
      assert.equal(params.p_reset_prior, false);
    } finally { db.restore(); }
  }
});

test("completed invoice replay repairs its mirror without canceling or notifying", async () => {
  const state = {
    enrollment: baseEnrollment({ cycles_completed: 1 }),
    mintResults: [{ minted: false, reason: "replay", purchase_id: "purchase-1",
      cycle: 1, completed: true }],
  };
  const db = installDb(state);
  const mirrors = [];
  const notices = [];
  const stripeCalls = [];
  try {
    await handleInvoicePaid({ data: { object: invoice("in_replay", 2500) } }, {
      supabase: s,
      stripe: { subscriptions: { update: async (...args) => stripeCalls.push(args) } },
      mirrorStripePayment: async (value) => mirrors.push(value),
      notify: async (value) => notices.push(value),
    });
    assert.equal(mirrors.length, 1);
    assert.equal(mirrors[0].purchase_id, "purchase-1");
    assert.equal(mirrors[0].stripe_invoice_id, "in_replay");
    assert.equal(mirrors[0].stripe_session_id, undefined);
    assert.equal(mirrors[0].stripe_payment_intent_id, undefined);
    assert.equal(notices.length, 0);
    assert.deepEqual(stripeCalls, []);
  } finally { db.restore(); }
});

test("completed mint asks Stripe to cancel at period end", async () => {
  const state = {
    enrollment: baseEnrollment({ billing_type: "installment", cycles_completed: 2,
      max_cycles: 3 }),
    mintResults: [{ minted: true, purchase_id: "purchase-3", cycle: 3, completed: true }],
  };
  const db = installDb(state);
  const stripeCalls = [];
  try {
    await handleInvoicePaid({ data: { object: invoice("in_final", 4000,
      subscription({ billing_type: "installment", installments_total: "3", max_cycles: "3" })) } }, {
      supabase: s,
      stripe: { subscriptions: { update: async (...args) => stripeCalls.push(args) } },
      mirrorStripePayment: async () => {},
      notify: async () => {},
    });
    assert.deepEqual(stripeCalls, [["sub_1", { cancel_at_period_end: true }]]);
  } finally { db.restore(); }
});

test("invoice before checkout enrollment creates enrollment then calls mint RPC", async () => {
  const state = { enrollment: null, credits: 9, customerExists: true };
  const db = installDb(state);
  try {
    await handleInvoicePaid({ data: { object: invoice("in_before_enrollment", 2500) } }, {
      supabase: s,
      stripe: { subscriptions: { update: async () => {} } },
      mirrorStripePayment: async () => {},
      notify: async () => {},
    });
    assert.equal(state.enrollmentInserts, 1);
    assert.equal(rpcBodies(db, "mint_billing_cycle")[0].p_subscription_id, ENROLLMENT);
    assert.equal(rpcBodies(db, "mint_billing_cycle")[0].p_credits, 9);
  } finally { db.restore(); }
});

test("every paid invoice requires its mirror before notify, including zero-dollar invoices", async () => {
  const state = { enrollment: baseEnrollment() };
  const db = installDb(state);
  let notified = 0;
  try {
    await assert.rejects(() => handleInvoicePaid({ data: { object: invoice("in_zero", 0) } }, {
      supabase: s,
      stripe: { subscriptions: { update: async () => {} } },
      mirrorStripePayment: async () => { throw new Error("mirror down"); },
      notify: async () => { notified += 1; },
    }), /mirror down/);
    assert.equal(notified, 0);
    assert.equal(rpcBodies(db, "mint_billing_cycle").length, 1,
      "the committed RPC mint is repairable on Stripe retry");
  } finally { db.restore(); }
});

test("mint RPC non-2xx makes the webhook return 500 for Stripe retry", async () => {
  const state = { enrollment: baseEnrollment(), mintRpcStatus: 503 };
  const db = installDb(state);
  const oldSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const oldHandler = global.handleInvoicePaid;
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_billing";
  global.handleInvoicePaid = (event) => handleInvoicePaid(event, {
    supabase: s,
    stripe: { subscriptions: { update: async () => {} } },
    mirrorStripePayment: async () => {},
    notify: async () => {},
  });
  try {
    const res = await signedWebhook("invoice.paid", invoice("in_rpc_down", 2500));
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "webhook_handler_failed" });
  } finally {
    if (oldSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = oldSecret;
    if (oldHandler == null) delete global.handleInvoicePaid;
    else global.handleInvoicePaid = oldHandler;
    db.restore();
  }
});

test("mint subscription_not_found logs loudly and webhook ACKs 200", async () => {
  const state = {
    enrollment: baseEnrollment(),
    mintResults: [{ minted: false, reason: "subscription_not_found" }],
  };
  const db = installDb(state);
  const oldSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const oldHandler = global.handleInvoicePaid;
  const realError = console.error;
  const errors = [];
  let mirrors = 0;
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_billing";
  console.error = (...args) => errors.push(args.join(" "));
  global.handleInvoicePaid = (event) => handleInvoicePaid(event, {
    supabase: s,
    stripe: { subscriptions: { update: async () => {} } },
    mirrorStripePayment: async () => { mirrors += 1; },
    notify: async () => {},
  });
  try {
    const res = await signedWebhook("invoice.paid", invoice("in_orphan", 2500));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { received: true });
    assert.equal(mirrors, 0);
    assert.match(errors.join("\n"), /mint_billing_cycle orphaned subscription.*ACKing invoice in_orphan/);
  } finally {
    console.error = realError;
    if (oldSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = oldSecret;
    if (oldHandler == null) delete global.handleInvoicePaid;
    else global.handleInvoicePaid = oldHandler;
    db.restore();
  }
});

test("failed invoice uses event time for grace and notifies both sides with one dedupe key", async () => {
  const state = { enrollment: baseEnrollment({ grace_days: 3 }) };
  const db = installDb(state);
  const notices = [];
  const created = 1785542400;
  try {
    await handleInvoicePaymentFailed({ created, data: { object: invoice("in_fail", 2500) } }, {
      supabase: s,
      stripe: { subscriptions: {} },
      notify: async (value) => notices.push(value),
    });
    assert.equal(state.enrollment.status, "past_due");
    assert.equal(state.enrollment.grace_until,
      new Date((created + 3 * 86400) * 1000).toISOString());
    assert.equal(notices.length, 2);
    assert.deepEqual(new Set(notices.map((notice) => notice.dedupeKey)),
      new Set(["invoice.payment_failed:in_fail"]));
  } finally { db.restore(); }
});

test("terminal update and deleted replay freeze through RPC and notify only once", async () => {
  const state = {
    enrollment: baseEnrollment({ status: "past_due" }),
    freezeResults: [{ frozen: 1, already: false }, { frozen: 0, already: true }],
  };
  const db = installDb(state);
  const notices = [];
  const object = { ...subscription(), status: "unpaid" };
  try {
    await handleSubscriptionUpdated({ data: { object } }, {
      supabase: s,
      notify: async (value) => notices.push(value),
    });
    await handleSubscriptionDeleted({ data: { object: { ...object, status: "canceled" } } }, {
      supabase: s,
      notify: async (value) => notices.push(value),
    });
    assert.deepEqual(rpcBodies(db, "freeze_subscription_credits"), [
      { p_subscription_id: ENROLLMENT, p_reason: "billing_final_failure" },
      { p_subscription_id: ENROLLMENT, p_reason: "billing_final_failure" },
    ]);
    assert.equal(notices.length, 2, "one coach and one athlete notification, with no replay copies");
    assert.deepEqual(new Set(notices.map((notice) => notice.dedupeKey)),
      new Set(["billing.frozen:sub_1"]));
  } finally { db.restore(); }
});

test("freeze re-notify attempts carry the stable subscription dedupe key", async () => {
  const state = {
    enrollment: baseEnrollment({ status: "past_due" }),
    freezeResults: [{ frozen: 0, already: false }, { frozen: 0, already: false }],
  };
  const db = installDb(state);
  const notices = [];
  const object = { ...subscription(), status: "unpaid" };
  try {
    for (let i = 0; i < 2; i += 1) {
      await handleSubscriptionUpdated({ data: { object } }, {
        supabase: s,
        notify: async (value) => notices.push(value),
      });
    }
    assert.equal(notices.length, 4, "both deliveries attempt coach and athlete notifications");
    assert.ok(notices.every((notice) => notice.dedupeKey === "billing.frozen:sub_1"));
  } finally { db.restore(); }
});

test("freeze subscription_not_found logs loudly and webhook ACKs 200", async () => {
  const state = {
    enrollment: baseEnrollment({ status: "past_due" }),
    freezeResults: [{ frozen: 0, already: false, reason: "subscription_not_found" }],
  };
  const db = installDb(state);
  const oldSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const oldHandler = global.handleSubscriptionDeleted;
  const realError = console.error;
  const errors = [];
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_billing";
  console.error = (...args) => errors.push(args.join(" "));
  global.handleSubscriptionDeleted = (event) => handleSubscriptionDeleted(event, {
    supabase: s,
    notify: async () => { throw new Error("orphan must not notify"); },
  });
  try {
    const object = { ...subscription(), status: "canceled" };
    const res = await signedWebhook("customer.subscription.deleted", object);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { received: true });
    assert.match(errors.join("\n"), /freeze_subscription_credits orphaned subscription.*ACKing sub_1/);
  } finally {
    console.error = realError;
    if (oldSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = oldSecret;
    if (oldHandler == null) delete global.handleSubscriptionDeleted;
    else global.handleSubscriptionDeleted = oldHandler;
    db.restore();
  }
});
