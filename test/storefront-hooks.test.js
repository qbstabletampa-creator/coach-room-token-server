const test = require("node:test");
const assert = require("node:assert");
const { buildStorefrontHandlers } = require("../lib/storefront");

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "service-key";

const COACH = "11111111-1111-4111-8111-111111111111";
const ATHLETE = "22222222-2222-4222-8222-222222222222";
const SLOT = "33333333-3333-4333-8333-333333333333";
const TYPE = "44444444-4444-4444-8444-444444444444";
const SOFT_TYPE = "55555555-5555-4555-8555-555555555555";
const START = "2099-01-01T12:00:00.000Z";
const END = "2099-01-01T13:00:00.000Z";

function response(json) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

function res() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function request(overrides = {}) {
  return {
    params: { slug: "coach-one" },
    body: {
      slot_id: SLOT,
      session_type_id: SOFT_TYPE,
      name: "Jordan",
      email: "parent@example.com",
      ...overrides,
    },
  };
}

function installFetch({
  slotType = TYPE,
  activeTypes = [
    { id: TYPE, name: "Protected private", price_cents: 7500 },
    { id: SOFT_TYPE, name: "Consult", price_cents: 0 },
  ],
} = {}) {
  const old = global.fetch;
  const calls = [];
  let open = true;
  global.fetch = async (url, opts = {}) => {
    const call = {
      url: String(url),
      method: String(opts.method || "GET").toUpperCase(),
      body: opts.body ? JSON.parse(opts.body) : null,
    };
    calls.push(call);
    if (call.url.includes("/coaches?")) {
      return response([{ id: COACH, full_name: "Coach One" }]);
    }
    if (call.url.includes("/bookable_slots") && call.method === "GET") {
      return response([{ id: SLOT, session_type_id: slotType }]);
    }
    if (call.url.includes("/athletes?") && call.method === "GET") {
      return response([{ id: ATHLETE, user_id: "claimed-user" }]);
    }
    if (call.url.includes("/bookable_slots") && call.method === "PATCH" && call.url.includes("status=eq.open")) {
      if (!open) return response([]);
      open = false;
      return response([{
        id: SLOT, title: "Private", status: "booked", starts_at: START,
        ends_at: END, timezone: "UTC", ...call.body,
      }]);
    }
    if (call.url.includes("/session_types?") && call.method === "GET") {
      const idMatch = call.url.match(/[?&]id=eq\.([^&]+)/);
      return response(idMatch
        ? activeTypes.filter((type) => type.id === decodeURIComponent(idMatch[1]))
        : activeTypes);
    }
    if (call.url.endsWith("/rest/v1/sessions") && call.method === "POST") return response([]);
    return response([]);
  };
  return { calls, restore() { global.fetch = old; } };
}

test("bookGuest blocks on its pre-claim gate and returns the live setup_url contract", async () => {
  const mock = installFetch();
  const gateCalls = [];
  try {
    const handlers = buildStorefrontHandlers({
      bookingGate: (args) => {
        gateCalls.push(args);
        return { allowed: false, status: "requires_card", setup_url: "https://checkout.stripe.com/setup/test" };
      },
      notify: async () => {},
    });
    const out = res();
    await handlers.bookGuest(request(), out);
    assert.strictEqual(out.statusCode, 402);
    assert.deepStrictEqual(out.payload, {
      error: "needs_card",
      setup_url: "https://checkout.stripe.com/setup/test",
    });
    assert.strictEqual(gateCalls.length, 1);
    assert.strictEqual(gateCalls[0].sessionTypeId, TYPE, "slot truth beats the substituted client type");
    assert.ok(!mock.calls.some((c) => c.method === "PATCH"), "blocking gate runs before claim");
  } finally { mock.restore(); }
});

test("bookGuest retries a failed owed-charge insert, keeps the booking, and loudly notifies", async () => {
  const mock = installFetch();
  const chargeCalls = [];
  const notices = [];
  try {
    const handlers = buildStorefrontHandlers({
      bookingGate: (args) => ({ allowed: true, sessionTypeId: args.sessionTypeId }),
      guestCharge: (args) => {
        chargeCalls.push(args);
        throw new Error("insert unavailable");
      },
      notify: async (args) => notices.push(args),
    });
    const out = res();
    await handlers.bookGuest(request(), out);
    assert.strictEqual(out.statusCode, 200);
    assert.strictEqual(out.payload.booked, true);
    assert.strictEqual(chargeCalls.length, 3, "initial insert plus two in-request retries");
    assert.strictEqual(chargeCalls[0].amount_cents, 7500);
    assert.strictEqual(chargeCalls[0].slot_id, SLOT);
    const loud = notices.find((notice) => notice.type === "payments.charge_log_failed");
    assert.ok(loud, "the coach receives the manual Payments warning");
    assert.match(loud.body, /athlete Jordan, slot .* amount \$75\.00; record it manually in Payments\./);
    const claims = mock.calls.filter((c) => c.url.includes("/bookable_slots") && c.method === "PATCH" && c.url.includes("status=eq.open"));
    assert.strictEqual(claims.length, 1);
  } finally { mock.restore(); }
});

test("a second guest booking loses the atomic claim without retrying the charge hook", async () => {
  const mock = installFetch();
  let chargeCalls = 0;
  try {
    const handlers = buildStorefrontHandlers({
      guestCharge: async () => { chargeCalls += 1; return { charge: { id: "charge-1" } }; },
      notify: async () => {},
    });
    const first = res();
    const second = res();
    await handlers.bookGuest(request(), first);
    await handlers.bookGuest(request(), second);
    assert.strictEqual(first.statusCode, 200);
    assert.strictEqual(second.statusCode, 409);
    assert.strictEqual(chargeCalls, 1);
  } finally { mock.restore(); }
});

test("guest booking rejects a supplied cross-tenant type on an untyped slot", async () => {
  const mock = installFetch({ slotType: null, activeTypes: [{ id: TYPE, price_cents: 7500 }] });
  try {
    const handlers = buildStorefrontHandlers({ bookingGate: async () => ({ allowed: true }), notify: async () => {} });
    const out = res();
    await handlers.bookGuest(request(), out);
    assert.strictEqual(out.statusCode, 400);
    assert.deepStrictEqual(out.payload, { error: "unknown_session_type" });
    assert.ok(!mock.calls.some((call) => call.method === "PATCH"));
  } finally { mock.restore(); }
});

test("guest booking rejects every supplied garbage type when protection is enabled", async () => {
  for (const supplied of [false, 0, "", "not-a-uuid"]) {
    const mock = installFetch();
    try {
      const handlers = buildStorefrontHandlers({ bookingGate: async () => ({ allowed: true }), notify: async () => {} });
      const out = res();
      await handlers.bookGuest(request({ session_type_id: supplied }), out);
      assert.strictEqual(out.statusCode, 400);
      assert.deepStrictEqual(out.payload, { error: "unknown_session_type" });
      assert.ok(!mock.calls.some((call) => call.method === "PATCH"));
    } finally { mock.restore(); }
  }
});

test("guest booking returns retryable 503 before claim when type ownership lookup fails", async () => {
  const mock = installFetch();
  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes("/session_types") && String(url).includes("id=eq.")) {
      return { ok: false, status: 503, json: async () => ({}), text: async () => "ownership down" };
    }
    return originalFetch(url, opts);
  };
  try {
    const handlers = buildStorefrontHandlers({ bookingGate: async () => ({ allowed: true }), notify: async () => {} });
    const out = res();
    await handlers.bookGuest(request(), out);
    assert.strictEqual(out.statusCode, 503);
    assert.deepStrictEqual(out.payload, { error: "session_type_unavailable" });
    assert.ok(!mock.calls.some((call) => call.method === "PATCH"));
  } finally {
    global.fetch = originalFetch;
    mock.restore();
  }
});

test("guest booking requires a type for an untyped slot when the coach has active types", async () => {
  const mock = installFetch({ slotType: null });
  try {
    const handlers = buildStorefrontHandlers({ guestCharge: async () => ({ charge: {} }), notify: async () => {} });
    const out = res();
    await handlers.bookGuest(request({ session_type_id: null }), out);
    assert.strictEqual(out.statusCode, 400);
    assert.deepStrictEqual(out.payload, { error: "session type required" });
    assert.ok(!mock.calls.some((call) => call.method === "PATCH"));
  } finally { mock.restore(); }
});

test("flags-off guest booking validates and persists a supplied coach-owned type", async () => {
  const mock = installFetch();
  try {
    const handlers = buildStorefrontHandlers({ notify: async () => {} });
    const out = res();
    await handlers.bookGuest(request(), out);
    assert.strictEqual(out.statusCode, 200);
    const claim = mock.calls.find((call) => call.url.includes("/bookable_slots") && call.method === "PATCH");
    assert.strictEqual(claim.body.session_type_id, SOFT_TYPE);
    assert.strictEqual(mock.calls.filter((call) => call.url.includes("/session_types")).length, 1);
    assert.ok(!mock.calls.some((call) => call.url.includes("/bookable_slots") && call.method === "GET"));
  } finally { mock.restore(); }
});

test("flags-off guest booking retains master's falsey-type behavior", async () => {
  for (const supplied of [false, 0, ""]) {
    const mock = installFetch();
    try {
      const handlers = buildStorefrontHandlers({ notify: async () => {} });
      const out = res();
      await handlers.bookGuest(request({ session_type_id: supplied }), out);
      assert.strictEqual(out.statusCode, 200);
      const claim = mock.calls.find((call) => call.url.includes("/bookable_slots") && call.method === "PATCH");
      assert.strictEqual(claim.body.session_type_id, null);
      assert.ok(!mock.calls.some((call) => call.url.includes("/session_types")));
    } finally { mock.restore(); }
  }
});

test("guest pricing read failure stays booked and loudly notifies the coach", async () => {
  const mock = installFetch();
  const notices = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes("/session_types") && String(url).includes("select=id,name,price_cents")) {
      return { ok: false, status: 503, json: async () => ({}), text: async () => "pricing down" };
    }
    return originalFetch(url, opts);
  };
  try {
    const handlers = buildStorefrontHandlers({
      guestCharge: async () => { throw new Error("must be skipped"); },
      notify: async (args) => notices.push(args),
    });
    const out = res();
    await handlers.bookGuest(request(), out);
    assert.strictEqual(out.statusCode, 200);
    assert.ok(notices.some((notice) => notice.type === "payments.charge_log_failed"));
  } finally {
    global.fetch = originalFetch;
    mock.restore();
  }
});

test("guest booking returns retryable 503 without claiming when setup mint is unavailable", async () => {
  const mock = installFetch();
  try {
    const handlers = buildStorefrontHandlers({
      bookingGate: async () => ({ allowed: false, status: "card_setup_unavailable" }),
      notify: async () => {},
    });
    const out = res();
    await handlers.bookGuest(request(), out);
    assert.strictEqual(out.statusCode, 503);
    assert.deepStrictEqual(out.payload, { error: "card_setup_unavailable" });
    assert.ok(!mock.calls.some((call) => call.method === "PATCH"));
  } finally { mock.restore(); }
});
