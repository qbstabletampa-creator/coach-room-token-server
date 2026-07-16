const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "service-key";
delete process.env.STRIPE_SECRET_KEY;

const protection = require("../lib/protection");
const { stripeWebhookHandler } = require("../lib/stripe-webhook");

const COACH = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ATHLETE = "33333333-3333-4333-8333-333333333333";
const SLOT = "44444444-4444-4444-8444-444444444444";
const TYPE = "55555555-5555-4555-8555-555555555555";
const INVITE = "66666666-6666-4666-8666-666666666666";
const CHARGE = "77777777-7777-4777-8777-777777777777";
const CREATED = "2026-07-16T12:00:00.000Z";

function response(json, status = 200, detail = "") {
  return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => detail };
}

function mockFetch(handler) {
  const old = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const call = {
      url: String(url), method: String(opts.method || "GET").toUpperCase(),
      body: opts.body ? JSON.parse(opts.body) : null,
    };
    calls.push(call);
    return handler(call, calls);
  };
  return { calls, restore: () => { global.fetch = old; } };
}

function req({ params = {}, query = {}, body = {} } = {}) { return { params, query, body, headers: {} }; }
function res() {
  return {
    statusCode: 200, payload: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
  };
}

function coachAuth(id = COACH, role = "coach") {
  return async () => ({ user: { id, user_metadata: { role } } });
}

function handler(overrides = {}) {
  return protection.buildProtectionHandlers({
    requireSupabaseUser: overrides.requireSupabaseUser || coachAuth(),
    notify: overrides.notify || (async () => {}),
    mirrorStripePayment: overrides.mirrorStripePayment || (async () => ({ inserted: true })),
    getStripeSecretKey: overrides.getStripeSecretKey || (() => undefined),
    createStripe: overrides.createStripe,
    waitlistFill: overrides.waitlistFill,
  });
}

test("real booking gate uses the slot type and returns setup_url for a substituted client type", async () => {
  const CLIENT_TYPE = OTHER;
  const mock = mockFetch(({ url }) => {
    if (url.includes("bookable_slots")) return response([{ id: SLOT, session_type_id: TYPE }]);
    if (url.includes("session_types") && url.includes(`id=eq.${TYPE}`)) return response([{ id: TYPE, price_cents: 6000 }]);
    if (url.includes("session_types") && url.includes(`id=eq.${CLIENT_TYPE}`)) return response([{ id: CLIENT_TYPE, price_cents: 0 }]);
    if (url.includes("protection_policies") && url.includes(`session_type_id=eq.${TYPE}`)) {
      return response([policyRow({ session_type_id: TYPE, require_card: true })]);
    }
    if (url.includes("protection_policies")) return response([policyRow({ enabled: false })]);
    if (url.includes("athlete_payment_methods")) return response([]);
    if (url.includes("stripe_customers")) return response([{ stripe_customer_id: "cus_existing" }]);
    return response([]);
  });
  try {
    handler(); // reset the protection runtime to simulated Stripe mode
    const result = await protection.assessBookingGate({
      coachId: COACH,
      athleteId: ATHLETE,
      slotId: SLOT,
      sessionTypeId: CLIENT_TYPE,
      setupContext: { email: "p@example.com", returnPath: `/book/${INVITE}` },
    });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.status, "requires_card");
    assert.strictEqual(result.sessionTypeId, TYPE);
    assert.match(result.setup_url, /^https:\/\/checkout\.stripe\.com\//);
    assert.deepStrictEqual(Object.keys(result), ["allowed", "status", "sessionTypeId", "setup_url"]);
    assert.ok(!mock.calls.some((c) => c.url.includes("protection_policies") && c.url.includes(`session_type_id=eq.${CLIENT_TYPE}`)));
  } finally { mock.restore(); }
});

test("required-card setup mint failure blocks with a retryable unavailable result", async () => {
  const mock = mockFetch(({ url }) => {
    if (url.includes("bookable_slots")) return response([{ id: SLOT, session_type_id: TYPE }]);
    if (url.includes("session_types")) return response([{ id: TYPE, price_cents: 6000 }]);
    if (url.includes("protection_policies")) return response([policyRow({ session_type_id: TYPE })]);
    if (url.includes("athlete_payment_methods")) return response([]);
    if (url.includes("stripe_customers")) return response([{ stripe_customer_id: "cus_existing" }]);
    return response([]);
  });
  try {
    handler({
      getStripeSecretKey: () => "sk_test_failure",
      createStripe: () => ({
        checkout: { sessions: { create: async () => { throw new Error("stripe timeout"); } } },
      }),
    });
    const result = await protection.assessBookingGate({
      coachId: COACH,
      athleteId: ATHLETE,
      slotId: SLOT,
      setupContext: { email: "p@example.com", returnPath: `/book/${INVITE}` },
    });
    assert.deepStrictEqual(result, {
      allowed: false,
      status: "card_setup_unavailable",
      sessionTypeId: TYPE,
    });
  } finally {
    handler();
    mock.restore();
  }
});

test("booking approval policy is an anchored future hook and currently allows a normal booked claim", async () => {
  const mock = mockFetch(({ url }) => {
    if (url.includes("bookable_slots")) return response([{ id: SLOT, session_type_id: TYPE }]);
    if (url.includes("session_types")) return response([{ id: TYPE, price_cents: 6000 }]);
    if (url.includes("protection_policies")) {
      return response([policyRow({ session_type_id: TYPE, require_card: false, booking_approval: true })]);
    }
    return response([]);
  });
  try {
    const result = await protection.assessBookingGate({ coachId: COACH, athleteId: ATHLETE, slotId: SLOT });
    assert.deepStrictEqual(result, { allowed: true, status: "allowed", sessionTypeId: TYPE });
  } finally { mock.restore(); }
});

function policyRow(extra = {}) {
  return {
    id: "88888888-8888-4888-8888-888888888888", coach_id: COACH,
    session_type_id: null, enabled: true, require_card: true,
    free_cancel_hours: 24, late_cancel_fee_type: "percent", late_cancel_fee_value: 50,
    no_show_fee_type: "percent", no_show_fee_value: 50, booking_approval: false,
    ...extra,
  };
}

test("public policy DTO is exact and service override wins over coach default", async () => {
  const mock = mockFetch(({ url }) => {
    if (url.includes("/coaches?")) return response([{ id: COACH, slug: "coach-one" }]);
    if (url.includes("/session_types?")) return response([{ id: TYPE, price_cents: 6000 }]);
    if (url.includes("session_type_id=eq.")) return response([policyRow({ session_type_id: TYPE, no_show_fee_value: 25 })]);
    if (url.includes("session_type_id=is.null")) return response([policyRow()]);
    return response([]);
  });
  try {
    const out = res();
    await handler().getSlugPolicy(req({ params: { slug: "coach-one" }, query: { session_type_id: TYPE } }), out);
    assert.strictEqual(out.statusCode, 200);
    assert.deepStrictEqual(Object.keys(out.payload.policy), [
      "enabled", "require_card", "has_card", "free_cancel_hours", "late_cancel_fee",
      "no_show_fee", "booking_approval", "copy",
    ]);
    assert.deepStrictEqual(out.payload.policy.no_show_fee, { type: "percent", value: 25 });
    assert.strictEqual(out.payload.policy.has_card, null);
    assert.ok(mock.calls.every((c) => !c.url.includes("session_types?") || c.url.includes(`coach_id=eq.${COACH}`)));
  } finally { mock.restore(); }
});

test("policy falls back to coach default; absent policy returns frozen off DTO", async () => {
  let absent = false;
  const mock = mockFetch(({ url }) => {
    if (url.includes("/coaches?")) return response([{ id: COACH }]);
    if (url.includes("/session_types?")) return response([]); // cross-tenant id is ignored
    if (url.includes("protection_policies")) return response(absent ? [] : [policyRow()]);
    return response([]);
  });
  try {
    let out = res();
    await handler().getSlugPolicy(req({ params: { slug: "coach-one" }, query: { session_type_id: TYPE } }), out);
    assert.match(out.payload.policy.copy, /^This coach protects their time\./);
    absent = true;
    out = res();
    await handler().getSlugPolicy(req({ params: { slug: "coach-one" } }), out);
    assert.deepStrictEqual(out.payload.policy, {
      enabled: false, require_card: false, has_card: null, free_cancel_hours: 24,
      late_cancel_fee: { type: "none", value: 0 }, no_show_fee: { type: "none", value: 0 },
      booking_approval: false, copy: "",
    });
  } finally { mock.restore(); }
});

test("policy preserves free-cancel boundaries and defaults invalid read values with a warning", async () => {
  let freeCancelHours = 0;
  const warnings = [];
  const oldWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  const mock = mockFetch(({ url }) => {
    if (url.includes("/coaches?")) return response([{ id: COACH }]);
    if (url.includes("protection_policies")) return response([policyRow({ free_cancel_hours: freeCancelHours })]);
    return response([]);
  });
  try {
    for (const boundary of [0, 168]) {
      freeCancelHours = boundary;
      const out = res();
      await handler().getSlugPolicy(req({ params: { slug: "coach-one" } }), out);
      assert.strictEqual(out.payload.policy.free_cancel_hours, boundary);
    }
    for (const invalid of [-1, 169]) {
      freeCancelHours = invalid;
      const out = res();
      await handler().getSlugPolicy(req({ params: { slug: "coach-one" } }), out);
      assert.strictEqual(out.payload.policy.free_cancel_hours, 24);
    }
    assert.strictEqual(warnings.length, 2);
    assert.ok(warnings.every(([message]) => /invalid free_cancel_hours.*default 24/.test(message)));
  } finally {
    console.warn = oldWarn;
    mock.restore();
  }
});

test("disabled policy row returns the frozen protection-off public DTO", async () => {
  const mock = mockFetch(({ url }) => {
    if (url.includes("/coaches?")) return response([{ id: COACH }]);
    if (url.includes("protection_policies")) return response([policyRow({
      enabled: false,
      require_card: true,
      free_cancel_hours: 168,
      no_show_fee_value: 100,
    })]);
    return response([]);
  });
  try {
    const out = res();
    await handler().getSlugPolicy(req({ params: { slug: "coach-one" } }), out);
    assert.deepStrictEqual(out.payload.policy, {
      enabled: false, require_card: false, has_card: null, free_cancel_hours: 24,
      late_cancel_fee: { type: "none", value: 0 }, no_show_fee: { type: "none", value: 0 },
      booking_approval: false, copy: "",
    });
  } finally { mock.restore(); }
});

test("invite policy binds athlete context and reports real has_card", async () => {
  const mock = mockFetch(({ url }) => {
    if (url.includes("booking_invites")) return response([{
      token: INVITE, coach_id: COACH, athlete_id: ATHLETE, expires_at: "2099-01-01T00:00:00Z",
    }]);
    if (url.includes("protection_policies")) return response([policyRow()]);
    if (url.includes("athlete_payment_methods")) return response([{ id: "card" }]);
    return response([]);
  });
  try {
    const out = res();
    await handler().getInvitePolicy(req({ params: { inviteToken: INVITE } }), out);
    assert.strictEqual(out.payload.policy.has_card, true);
    assert.ok(mock.calls.find((c) => c.url.includes("athlete_payment_methods") && c.url.includes(`coach_id=eq.${COACH}`)));
  } finally { mock.restore(); }
});

test("setup-intent tenant lock rejects an invite from another slug tenant", async () => {
  const mock = mockFetch(({ url }) => {
    if (url.includes("/coaches?")) return response([{ id: COACH }]);
    if (url.includes("booking_invites") && url.includes(`coach_id=eq.${COACH}`)) return response([]);
    return response([]);
  });
  try {
    const out = res();
    await handler().postSetupIntent(req({
      params: { slug: "coach-one" },
      body: { context: { kind: "invite", invite_token: INVITE }, session_type_id: null },
    }), out);
    assert.strictEqual(out.statusCode, 404);
    assert.deepStrictEqual(out.payload, { error: "not_found" });
    assert.ok(mock.calls.find((c) => c.url.includes(`coach_id=eq.${COACH}`)));
  } finally { mock.restore(); }
});

test("setup-intent reuses tenant customer and returns exact simulated DTO", async () => {
  const mock = mockFetch(({ url }) => {
    if (url.includes("/coaches?")) return response([{ id: COACH }]);
    if (url.includes("/athletes?") && url.includes("or=")) return response([{ id: ATHLETE }]);
    if (url.includes("protection_policies")) return response([policyRow()]);
    if (url.includes("athlete_payment_methods")) return response([]);
    if (url.includes("stripe_customers")) return response([{ stripe_customer_id: "cus_existing" }]);
    return response([]);
  });
  try {
    const out = res();
    await handler().postSetupIntent(req({ params: { slug: "coach-one" }, body: {
      context: { kind: "guest", email: "Person@example.com", name: "Jordan" },
      session_type_id: null, return_path: "/coach/coach-one",
    } }), out);
    assert.strictEqual(out.statusCode, 200);
    assert.deepStrictEqual(Object.keys(out.payload), ["simulated", "url", "session_id"]);
    assert.strictEqual(out.payload.simulated, true);
    assert.match(out.payload.url, /^https:\/\/checkout\.stripe\.com\//);
    assert.strictEqual(mock.calls.filter((c) => c.url.includes("stripe_customers") && c.method === "POST").length, 0);
  } finally { mock.restore(); }
});

test("setup-intent real mode sends the exact hosted Checkout parameters", async () => {
  let checkoutArgs;
  const fakeStripe = {
    checkout: { sessions: { create: async (args) => { checkoutArgs = args; return { id: "cs_test", url: "https://checkout.stripe.com/c/pay" }; } } },
  };
  const mock = mockFetch(({ url }) => {
    if (url.includes("/coaches?")) return response([{ id: COACH }]);
    if (url.includes("/athletes?") && url.includes("or=")) return response([{ id: ATHLETE }]);
    if (url.includes("protection_policies")) return response([policyRow()]);
    if (url.includes("athlete_payment_methods")) return response([]);
    if (url.includes("stripe_customers")) return response([{ stripe_customer_id: "cus_existing" }]);
    return response([]);
  });
  try {
    const out = res();
    await handler({ getStripeSecretKey: () => "sk_test_fake", createStripe: () => fakeStripe }).postSetupIntent(req({
      params: { slug: "coach-one" }, body: { context: { kind: "guest", email: "p@example.com", name: "Jordan" } },
    }), out);
    assert.strictEqual(out.statusCode, 200);
    assert.deepStrictEqual(checkoutArgs, {
      mode: "setup", customer: "cus_existing", payment_method_types: ["card"],
      success_url: "https://coachtime.app/coach/coach-one?setup=success",
      cancel_url: "https://coachtime.app/coach/coach-one?setup=cancel",
      metadata: { purpose: "protection_setup", coach_id: COACH, athlete_id: ATHLETE },
      setup_intent_data: { metadata: { purpose: "protection_setup", coach_id: COACH, athlete_id: ATHLETE } },
    });
  } finally { mock.restore(); }
});

function noShowDb({
  feeType = "percent", feeValue = 50, priceCents = 6000, status = "booked",
  hasCard = true, policyEnabled = true, policyPresent = true,
} = {}) {
  let charge = null;
  const calls = [];
  const fetchMock = mockFetch((call) => {
    calls.push(call);
    const { url, method, body } = call;
    if (url.includes("bookable_slots") && method === "GET") return response([{
      id: SLOT, coach_id: COACH, status, booked_by: ATHLETE, session_type_id: TYPE,
      ends_at: "2020-01-01T00:00:00Z",
    }]);
    if (url.includes("booking_charges") && method === "GET") {
      if (url.includes("slot_id=eq.")) return response(charge ? [charge] : []);
      return response(charge ? [charge] : []);
    }
    if (url.includes("session_types")) return response([{ id: TYPE, price_cents: priceCents }]);
    if (url.includes("protection_policies") && url.includes("session_type_id=eq.")) return response([]);
    if (url.includes("protection_policies")) return response(policyPresent ? [policyRow({
      enabled: policyEnabled,
      no_show_fee_type: feeType,
      no_show_fee_value: feeValue,
    })] : []);
    if (url.includes("athlete_payment_methods")) return response(hasCard ? [{
      stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_1",
    }] : []);
    if (url.endsWith("/rest/v1/booking_charges") && method === "POST") {
      charge = { id: CHARGE, ...body, created_at: CREATED };
      return response([charge], 201);
    }
    if (url.includes("booking_charges") && method === "PATCH") {
      charge = { ...charge, ...body };
      return response([charge]);
    }
    if (url.includes("bookable_slots") && method === "PATCH") return response([{ id: SLOT, status: "completed" }]);
    if (url.includes("/athletes?") && method === "GET") return response([{ id: ATHLETE, name: "Jordan", user_id: ATHLETE }]);
    return response([]);
  });
  return { ...fetchMock, calls, getCharge: () => charge };
}

test("no-show computes 50%, uses exact off-session PI + idempotency key, and mirrors", async () => {
  let piCall;
  const mirrors = [];
  const db = noShowDb();
  const fakeStripe = { paymentIntents: { create: async (...args) => {
    piCall = args;
    return { id: "pi_1", amount: 3000, amount_received: 3000, currency: "usd", created: 1, status: "succeeded", metadata: args[0].metadata };
  } } };
  try {
    const out = res();
    await handler({
      getStripeSecretKey: () => "sk_test_fake", createStripe: () => fakeStripe,
      mirrorStripePayment: async (args) => { mirrors.push(args); return { inserted: true }; },
    }).postNoShow(req({ body: { slot_id: SLOT } }), out);
    assert.strictEqual(out.statusCode, 200);
    assert.strictEqual(out.payload.charge.amount_cents, 3000);
    assert.strictEqual(out.payload.charge.status, "succeeded");
    assert.deepStrictEqual(piCall, [{
      amount: 3000, currency: "usd", customer: "cus_1", payment_method: "pm_1",
      off_session: true, confirm: true,
      metadata: { booking_charge_id: CHARGE, coach_id: COACH, athlete_id: ATHLETE, slot_id: SLOT, kind: "no_show_fee" },
    }, { idempotencyKey: `booking-charge:${CHARGE}` }]);
    assert.strictEqual(mirrors.length, 1);
    assert.strictEqual(mirrors[0].stripe_payment_intent_id, "pi_1");
    assert.strictEqual(Object.hasOwn(mirrors[0], "stripe_invoice_id"), false);
  } finally { db.restore(); }
});

test("no-show flat cents work and simulated mode is keyless with a mirror row", async () => {
  const mirrors = [];
  const db = noShowDb({ feeType: "flat", feeValue: 1750 });
  try {
    const out = res();
    await handler({ mirrorStripePayment: async (args) => { mirrors.push(args); return { inserted: true }; } })
      .postNoShow(req({ body: { slot_id: SLOT } }), out);
    assert.strictEqual(out.statusCode, 200);
    assert.strictEqual(out.payload.charge.amount_cents, 1750);
    assert.match(out.payload.charge.stripe_payment_intent_id, /^pi_simulated_/);
    assert.strictEqual(mirrors.length, 1);
  } finally { db.restore(); }
});

test("no-show rounds an odd-price percent fee and keeps a flat fee exact", async () => {
  for (const [options, expected] of [
    [{ priceCents: 8501, feeType: "percent", feeValue: 50 }, 4251],
    [{ priceCents: 8501, feeType: "flat", feeValue: 1777 }, 1777],
  ]) {
    const db = noShowDb(options);
    try {
      const out = res();
      await handler().postNoShow(req({ body: { slot_id: SLOT } }), out);
      assert.strictEqual(out.statusCode, 200);
      assert.strictEqual(out.payload.charge.amount_cents, expected);
    } finally { db.restore(); }
  }
});

test("no-show duplicate taps return the original incident without a second PI or mirror", async () => {
  const mirrors = [];
  const db = noShowDb();
  try {
    const h = handler({ mirrorStripePayment: async (args) => { mirrors.push(args); return { inserted: true }; } });
    let out = res();
    await h.postNoShow(req({ body: { slot_id: SLOT } }), out);
    const first = out.payload.charge;
    out = res();
    await h.postNoShow(req({ body: { slot_id: SLOT } }), out);
    assert.deepStrictEqual(out.payload.charge, first);
    assert.strictEqual(db.calls.filter((c) => c.url.endsWith("/rest/v1/booking_charges") && c.method === "POST").length, 1);
    assert.strictEqual(mirrors.length, 1);
  } finally { db.restore(); }
});

test("no-show retries a failed pending insert with one ledger row and one Stripe idempotency key", async () => {
  const db = noShowDb();
  let attempts = 0;
  const keys = [];
  const fakeStripe = { paymentIntents: { create: async (args, options) => {
    attempts++;
    keys.push(options.idempotencyKey);
    if (attempts === 1) throw new Error("Stripe timed out after insert");
    return {
      id: "pi_retry", amount: args.amount, amount_received: args.amount,
      currency: "usd", created: 1, status: "succeeded", metadata: args.metadata,
    };
  } } };
  try {
    const h = handler({
      getStripeSecretKey: () => "sk_test_fake",
      createStripe: () => fakeStripe,
    });
    let out = res();
    await h.postNoShow(req({ body: { slot_id: SLOT } }), out);
    assert.strictEqual(out.statusCode, 502);
    assert.strictEqual(db.getCharge().status, "failed", "the coach-visible row is never left falsely pending");

    out = res();
    await h.postNoShow(req({ body: { slot_id: SLOT } }), out);
    assert.strictEqual(out.statusCode, 200);
    assert.strictEqual(out.payload.charge.status, "succeeded");
    assert.strictEqual(attempts, 2);
    assert.deepStrictEqual(keys, [`booking-charge:${CHARGE}`, `booking-charge:${CHARGE}`]);
    assert.strictEqual(
      db.calls.filter((c) => c.url.endsWith("/rest/v1/booking_charges") && c.method === "POST").length,
      1,
      "retry reuses the incident row",
    );
  } finally { db.restore(); }
});

test("no-show reaches waitlist seam after charged, failed, requires-action, no-card, no-fee, and waived-policy outcomes", async () => {
  const cases = [
    { name: "charged", options: {}, stripe: null, status: 200 },
    { name: "failed", options: {}, stripe: { paymentIntents: { create: async () => { throw new Error("timeout"); } } }, status: 502 },
    { name: "requires-action", options: {}, stripe: { paymentIntents: { create: async (args) => {
      const err = new Error("action");
      err.payment_intent = { id: "pi_action_seam", status: "requires_action", amount: args.amount, currency: "usd", metadata: args.metadata };
      throw err;
    } } }, status: 402 },
    { name: "no-card", options: { hasCard: false }, stripe: null, status: 409 },
    { name: "no-fee", options: { feeType: "none", feeValue: 0 }, stripe: null, status: 409 },
    { name: "waived-policy", options: { policyEnabled: false }, stripe: null, status: 409 },
  ];
  for (const c of cases) {
    const db = noShowDb(c.options);
    const seams = [];
    try {
      const out = res();
      await handler({
        getStripeSecretKey: c.stripe ? () => "sk_test_fake" : undefined,
        createStripe: c.stripe ? () => c.stripe : undefined,
        waitlistFill: () => seams.push(c.name),
      }).postNoShow(req({ body: { slot_id: SLOT } }), out);
      assert.strictEqual(out.statusCode, c.status, c.name);
      assert.deepStrictEqual(seams, [c.name], c.name);
    } finally { db.restore(); }
  }
});

test("no-show reports protection_off, no_fee, and no_payment_method without creating a charge", async () => {
  const cases = [
    [{ policyPresent: false }, "protection_off"],
    [{ policyEnabled: false }, "protection_off"],
    [{ feeType: "none", feeValue: 0 }, "no_fee"],
    [{ hasCard: false }, "no_payment_method"],
  ];
  for (const [options, expected] of cases) {
    const db = noShowDb(options);
    try {
      const out = res();
      await handler().postNoShow(req({ body: { slot_id: SLOT } }), out);
      assert.deepStrictEqual([out.statusCode, out.payload.error], [409, expected]);
      assert.strictEqual(db.calls.filter((c) => c.url.endsWith("/rest/v1/booking_charges") && c.method === "POST").length, 0);
    } finally { db.restore(); }
  }
});

test("no-show returns the pinned 402 requires_action DTO when off-session confirmation needs authentication", async () => {
  const db = noShowDb();
  const fakeStripe = { paymentIntents: { create: async (args) => {
    const error = new Error("authentication required");
    error.payment_intent = {
      id: "pi_action", status: "requires_action", amount: args.amount, currency: "usd",
      metadata: args.metadata,
    };
    throw error;
  } } };
  try {
    const out = res();
    await handler({ getStripeSecretKey: () => "sk_test_fake", createStripe: () => fakeStripe })
      .postNoShow(req({ body: { slot_id: SLOT } }), out);
    assert.strictEqual(out.statusCode, 402);
    assert.strictEqual(out.payload.error, "requires_action");
    assert.strictEqual(out.payload.charge.status, "requires_action");
    assert.strictEqual(out.payload.charge.stripe_payment_intent_id, "pi_action");
    assert.deepStrictEqual(Object.keys(out.payload.charge), [
      "id", "athlete_id", "slot_id", "session_type_id", "kind", "amount_cents",
      "status", "stripe_payment_intent_id", "reason", "created_at",
    ]);
  } finally { db.restore(); }
});

test("no-show enforces coach role, cross-tenant ownership, and eligible state", async () => {
  let db = noShowDb();
  try {
    let out = res();
    await handler({ requireSupabaseUser: coachAuth(COACH, "athlete") }).postNoShow(req({ body: { slot_id: SLOT } }), out);
    assert.deepStrictEqual([out.statusCode, out.payload.error], [403, "coach_access_required"]);
  } finally { db.restore(); }

  const mock = mockFetch(() => response([]));
  try {
    const out = res();
    await handler().postNoShow(req({ body: { slot_id: SLOT } }), out);
    assert.deepStrictEqual([out.statusCode, out.payload.error], [403, "cross_tenant"]);
  } finally { mock.restore(); }

  db = noShowDb({ status: "open" });
  try {
    const out = res();
    await handler().postNoShow(req({ body: { slot_id: SLOT } }), out);
    assert.deepStrictEqual([out.statusCode, out.payload.error], [409, "slot_not_eligible"]);
  } finally { db.restore(); }
});

test("waive pending cancels/waives; succeeded refunds and voids the PI mirror", async () => {
  let current = { id: CHARGE, coach_id: COACH, athlete_id: ATHLETE, slot_id: SLOT, session_type_id: TYPE,
    kind: "no_show_fee", amount_cents: 3000, status: "pending", stripe_payment_intent_id: "pi_1",
    reason: "No-show fee", created_at: CREATED };
  const cancelled = [], refunded = [], notifications = [];
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("booking_charges") && method === "GET") return response([current]);
    if (url.includes("booking_charges") && method === "PATCH") { current = { ...current, ...body }; return response([current]); }
    if (url.includes("payments") && method === "PATCH") return response([{ id: "pay", ...body }]);
    if (url.includes("athletes")) return response([{ id: ATHLETE, user_id: ATHLETE }]);
    return response([]);
  });
  const fakeStripe = {
    paymentIntents: { cancel: async (id) => { cancelled.push(id); } },
    refunds: { create: async (args) => { refunded.push(args); return { id: "re_1" }; } },
  };
  try {
    const h = handler({
      getStripeSecretKey: () => "sk_test_fake", createStripe: () => fakeStripe,
      notify: async (args) => { notifications.push(args); },
    });
    let out = res();
    await h.postWaive(req({ params: { id: CHARGE } }), out);
    assert.strictEqual(out.payload.charge.status, "waived");
    assert.deepStrictEqual(cancelled, ["pi_1"]);
    assert.ok(notifications.every((n) => n.dedupeKey === `charge.waived:${CHARGE}`));

    current.status = "succeeded";
    out = res();
    await h.postWaive(req({ params: { id: CHARGE } }), out);
    assert.strictEqual(out.payload.charge.status, "refunded");
    assert.deepStrictEqual(refunded, [{ payment_intent: "pi_1" }]);
    assert.ok(mock.calls.find((c) => c.url.includes("payments") && c.url.includes(`coach_id=eq.${COACH}`) && c.body.status === "void"));
  } finally { mock.restore(); }
});

test("waive cross-tenant lookup is a 403 and never mutates", async () => {
  const mock = mockFetch(() => response([]));
  try {
    const out = res();
    await handler().postWaive(req({ params: { id: CHARGE } }), out);
    assert.deepStrictEqual([out.statusCode, out.payload.error], [403, "cross_tenant"]);
    assert.strictEqual(mock.calls.filter((c) => c.method !== "GET").length, 0);
  } finally { mock.restore(); }
});

test("setup webhook replay idempotently upserts one active display card", async () => {
  const posts = [];
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("athletes") && method === "GET") return response([{ id: ATHLETE, parent_email: "p@example.com" }]);
    if (method === "POST") { posts.push({ url, body }); return response([{ id: "row" }], 201); }
    if (method === "PATCH") return response([]);
    return response([]);
  });
  handler();
  const event = { data: { object: {
    id: "seti_1", object: "setup_intent", customer: "cus_1",
    payment_method: { id: "pm_1", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } },
    metadata: { purpose: "protection_setup", coach_id: COACH, athlete_id: ATHLETE },
  } } };
  try {
    await protection.handleSetupIntentSucceeded(event);
    await protection.handleSetupIntentSucceeded(event);
    const cardPosts = posts.filter((p) => p.url.includes("athlete_payment_methods"));
    assert.strictEqual(cardPosts.length, 2, "each replay performs the same database upsert");
    assert.ok(cardPosts.every((p) => p.url.includes("on_conflict=stripe_payment_method_id")));
    assert.ok(mock.calls.every((c) => !c.url.includes("athletes?") || c.url.includes(`coach_id=eq.${COACH}`)));
  } finally { mock.restore(); }
});

test("PI webhook replay repairs status/mirror with pinned dedupe key; subscription PI is ignored", async () => {
  let row = { id: CHARGE, coach_id: COACH, athlete_id: ATHLETE, slot_id: SLOT, session_type_id: TYPE,
    kind: "no_show_fee", amount_cents: 3000, status: "pending", created_at: CREATED };
  const mirrors = [], notifications = [];
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("stripe_payment_intent_id=eq.pi_subscription")) return response([]);
    if (url.includes("booking_charges") && method === "GET") return response([row]);
    if (url.includes("booking_charges") && method === "PATCH") { row = { ...row, ...body }; return response([row]); }
    if (url.includes("athletes")) return response([{ id: ATHLETE, user_id: ATHLETE }]);
    return response([]);
  });
  handler({
    mirrorStripePayment: async (args) => { mirrors.push(args); return { inserted: mirrors.length === 1 }; },
    notify: async (args) => { notifications.push(args); },
  });
  const pi = { id: "pi_1", amount: 3000, amount_received: 3000, currency: "usd", created: 1,
    metadata: { booking_charge_id: CHARGE, coach_id: COACH } };
  try {
    await protection.handleProtectionPaymentIntentSucceeded({ data: { object: pi } });
    await protection.handleProtectionPaymentIntentSucceeded({ data: { object: pi } });
    assert.strictEqual(mirrors.length, 2, "exactly one mirror call per delivery");
    assert.ok(mirrors.every((m) => m.stripe_payment_intent_id === "pi_1"));
    assert.ok(notifications.every((n) => n.dedupeKey === "payment_intent.succeeded:pi_1"));
    const before = mirrors.length;
    await protection.handleProtectionPaymentIntentSucceeded({ data: { object: {
      id: "pi_subscription", metadata: { subscription_id: "sub_1", coach_id: COACH },
    } } });
    assert.strictEqual(mirrors.length, before);
  } finally { mock.restore(); }
});

test("refund webhook replay marks charge refunded and voids ledger with pinned notification key", async () => {
  let row = { id: CHARGE, coach_id: COACH, athlete_id: ATHLETE, slot_id: SLOT, session_type_id: TYPE,
    kind: "no_show_fee", amount_cents: 3000, status: "succeeded", stripe_payment_intent_id: "pi_1", created_at: CREATED };
  const notifications = [];
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("booking_charges") && method === "GET") return response([row]);
    if (url.includes("booking_charges") && method === "PATCH") { row = { ...row, ...body }; return response([row]); }
    if (url.includes("payments") && method === "PATCH") return response([{ id: "pay", ...body }]);
    if (url.includes("athletes")) return response([{ id: ATHLETE, user_id: ATHLETE }]);
    return response([]);
  });
  handler({ notify: async (args) => { notifications.push(args); } });
  const event = { data: { object: { id: "ch_1", payment_intent: "pi_1", metadata: { coach_id: COACH } } } };
  try {
    await protection.handleProtectionChargeRefunded(event);
    await protection.handleProtectionChargeRefunded(event);
    assert.strictEqual(row.status, "refunded");
    assert.strictEqual(mock.calls.filter((c) => c.url.includes("payments") && c.method === "PATCH").length, 2);
    assert.ok(notifications.every((n) => n.dedupeKey === "charge.refunded:ch_1"));
  } finally { mock.restore(); }
});

test("required PI mirror failure makes webhook return 500 before notification", async () => {
  let row = { id: CHARGE, coach_id: COACH, athlete_id: ATHLETE, slot_id: SLOT, session_type_id: TYPE,
    kind: "no_show_fee", amount_cents: 3000, status: "pending", created_at: CREATED };
  const notifications = [];
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("booking_charges") && method === "GET") return response([row]);
    if (url.includes("booking_charges") && method === "PATCH") { row = { ...row, ...body }; return response([row]); }
    return response([]);
  });
  handler({
    mirrorStripePayment: async () => { throw new Error("mirror down"); },
    notify: async (args) => { notifications.push(args); },
  });
  const event = { id: "evt_1", type: "payment_intent.succeeded", data: { object: {
    id: "pi_1", amount: 3000, amount_received: 3000, currency: "usd", created: 1,
    metadata: { booking_charge_id: CHARGE, coach_id: COACH },
  } } };
  const raw = Buffer.from(JSON.stringify(event));
  const oldSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", "whsec_test").update(`${ts}.${raw}`).digest("hex");
  const out = res();
  try {
    await stripeWebhookHandler({ body: raw, headers: { "stripe-signature": `t=${ts},v1=${sig}` } }, out);
    assert.strictEqual(out.statusCode, 500);
    assert.deepStrictEqual(out.payload, { error: "webhook_handler_failed" });
    assert.strictEqual(notifications.length, 0);
  } finally {
    mock.restore();
    if (oldSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = oldSecret;
  }
});
