const test = require("node:test");
const assert = require("node:assert");
const { buildSchedulingHandlers } = require("../lib/scheduling");

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";

const TOKEN = "11111111-1111-4111-8111-111111111111";
const SLOT = "22222222-2222-4222-8222-222222222222";
const COACH = "33333333-3333-4333-8333-333333333333";
const ATHLETE = "44444444-4444-4444-8444-444444444444";
const PURCHASE = "55555555-5555-4555-8555-555555555555";
const FUTURE = new Date(Date.now() + 86400000).toISOString();

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function bookingFetch(events, state = {}) {
  state.open ??= true;
  state.remaining ??= 2;
  return async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => "" });
    if (u.includes("/booking_invites") && method === "GET") return ok([{
      token: TOKEN, coach_id: COACH, athlete_id: ATHLETE, status: "pending", expires_at: FUTURE,
      coaches: { full_name: "Coach" }, athletes: { name: "Athlete", user_id: "claimed-user" },
    }]);
    if (u.includes("/package_purchases") && method === "GET" && u.includes("credits_remaining=gt.0")) {
      return ok([{ id: PURCHASE, coach_id: COACH, credits_remaining: state.remaining, status: "active", created_at: "2026-01-01" }]);
    }
    if (u.includes("/package_purchases") && method === "GET") return ok([{ credits_remaining: state.remaining }]);
    if (u.includes("/bookable_slots") && method === "PATCH" && u.includes("status=eq.open")) {
      events.push("claim");
      if (!state.open) return ok([]);
      state.open = false;
      state.claimBody = body;
      return ok([{ id: SLOT, coach_id: COACH, starts_at: FUTURE, ends_at: FUTURE, title: "Session", ...body }]);
    }
    if (u.includes("/package_purchases") && method === "PATCH") {
      state.remaining -= 1;
      state.deducted = true;
      return ok([{ id: PURCHASE, credits_remaining: state.remaining }]);
    }
    if (u.includes("/credit_deductions") && method === "POST") return ok([{ id: "deduct" }]);
    if (u.includes("/coaches") && method === "GET") {
      state.lowBalanceReads = (state.lowBalanceReads || 0) + 1;
      if (state.lowBalanceFailure) throw new Error("low-balance settings unavailable");
      return ok([{ low_balance_notify: true, low_balance_threshold: 2 }]);
    }
    if (u.includes("/sessions") && method === "POST") return ok([{ id: "session-id" }]);
    return ok([]);
  };
}

function req() {
  return { params: { inviteToken: TOKEN }, body: { slotId: SLOT } };
}

const OTHER_TYPE = "66666666-6666-4666-8666-666666666666";

test("booking gate precedes the atomic claim and post-claim hooks keep decreed order", async () => {
  const events = [];
  const realFetch = global.fetch;
  global.fetch = bookingFetch(events);
  try {
    const handlers = buildSchedulingHandlers({
      bookingGate: async () => { events.push("gate"); return { allowed: true, status: "allowed" }; },
      notify: async ({ type }) => { if (type === "credits.low_balance") events.push("low-credit"); },
      calendarMirror: async () => events.push("calendar"),
      formsPendingWaiver: async () => events.push("forms"),
    });
    const res = response();
    await handlers.bookSlot(req(), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(events.slice(0, 5), ["gate", "claim", "low-credit", "calendar", "forms"]);
  } finally { global.fetch = realFetch; }
});

test("a throwing post-claim hook cannot unwind the booking or credit deduction", async () => {
  const events = [];
  const state = {};
  const realFetch = global.fetch;
  global.fetch = bookingFetch(events, state);
  try {
    const handlers = buildSchedulingHandlers({
      bookingGate: async () => ({ allowed: true }),
      notify: async () => {},
      calendarMirror: () => { throw new Error("injected synchronous calendar failure"); },
      formsPendingWaiver: async () => events.push("forms-after-failure"),
    });
    const res = response();
    await handlers.bookSlot(req(), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.open, false);
    assert.strictEqual(state.deducted, true);
    assert.ok(events.includes("forms-after-failure"));
  } finally { global.fetch = realFetch; }
});

test("concurrent booking attempts preserve a single atomic-claim winner", async () => {
  const events = [];
  const realFetch = global.fetch;
  global.fetch = bookingFetch(events);
  try {
    const handlers = buildSchedulingHandlers({ bookingGate: async () => ({ allowed: true }), notify: async () => {} });
    const a = response();
    const b = response();
    await Promise.all([handlers.bookSlot(req(), a), handlers.bookSlot(req(), b)]);
    assert.deepStrictEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  } finally { global.fetch = realFetch; }
});

test("flags-off invite booking validates and persists a supplied coach-owned type", async () => {
  const events = [];
  const state = {};
  const realFetch = global.fetch;
  const baseFetch = bookingFetch(events, state);
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/session_types") && u.includes("id=eq.")) {
      return { ok: true, status: 200, json: async () => [{ id: OTHER_TYPE }], text: async () => "" };
    }
    if (u.includes("/bookable_slots") && (opts.method || "GET") === "GET") {
      throw new Error("flags-off slot-type lookup must not run");
    }
    return baseFetch(url, opts);
  };
  try {
    const handlers = buildSchedulingHandlers({ notify: async () => {} });
    const res = response();
    const input = req();
    input.body.session_type_id = OTHER_TYPE;
    await handlers.bookSlot(input, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.claimBody.session_type_id, OTHER_TYPE);
    assert.deepStrictEqual(events.filter((e) => e === "gate"), []);
  } finally { global.fetch = realFetch; }
});

test("flags-off invite booking retains master's falsey-type behavior", async () => {
  for (const supplied of [false, 0, ""]) {
    const events = [];
    const state = {};
    const realFetch = global.fetch;
    global.fetch = bookingFetch(events, state);
    try {
      const handlers = buildSchedulingHandlers({ notify: async () => {} });
      const input = req();
      input.body.session_type_id = supplied;
      const out = response();
      await handlers.bookSlot(input, out);
      assert.strictEqual(out.statusCode, 200);
      assert.strictEqual(state.claimBody.session_type_id, null);
    } finally { global.fetch = realFetch; }
  }
});

test("invite booking rejects a supplied cross-tenant type before claim", async () => {
  const events = [];
  const realFetch = global.fetch;
  global.fetch = bookingFetch(events);
  try {
    const handlers = buildSchedulingHandlers({ bookingGate: async () => ({ allowed: true }), notify: async () => {} });
    const input = req();
    input.body.session_type_id = OTHER_TYPE;
    const out = response();
    await handlers.bookSlot(input, out);
    assert.strictEqual(out.statusCode, 400);
    assert.deepStrictEqual(out.body, { error: "unknown_session_type" });
    assert.ok(!events.includes("claim"));
  } finally { global.fetch = realFetch; }
});

test("invite booking rejects every supplied garbage type when protection is enabled", async () => {
  for (const supplied of [false, 0, "", "not-a-uuid"]) {
    const events = [];
    const realFetch = global.fetch;
    global.fetch = bookingFetch(events);
    try {
      const handlers = buildSchedulingHandlers({ bookingGate: async () => ({ allowed: true }), notify: async () => {} });
      const input = req();
      input.body.session_type_id = supplied;
      const out = response();
      await handlers.bookSlot(input, out);
      assert.strictEqual(out.statusCode, 400);
      assert.deepStrictEqual(out.body, { error: "unknown_session_type" });
      assert.ok(!events.includes("claim"));
    } finally { global.fetch = realFetch; }
  }
});

test("invite booking returns retryable 503 before claim when type ownership lookup fails", async () => {
  const events = [];
  const realFetch = global.fetch;
  const baseFetch = bookingFetch(events);
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes("/session_types") && String(url).includes("id=eq.")) {
      return { ok: false, status: 503, json: async () => ({}), text: async () => "ownership down" };
    }
    return baseFetch(url, opts);
  };
  try {
    const handlers = buildSchedulingHandlers({ bookingGate: async () => ({ allowed: true }), notify: async () => {} });
    const input = req();
    input.body.session_type_id = OTHER_TYPE;
    const out = response();
    await handlers.bookSlot(input, out);
    assert.strictEqual(out.statusCode, 503);
    assert.deepStrictEqual(out.body, { error: "session_type_unavailable" });
    assert.ok(!events.includes("claim"));
  } finally { global.fetch = realFetch; }
});

test("successful invite bookings always read low-balance settings and that read is fail-soft", async () => {
  const realFetch = global.fetch;
  try {
    const successEvents = [];
    const successState = {};
    global.fetch = bookingFetch(successEvents, successState);
    const handlers = buildSchedulingHandlers({ notify: async () => {} });
    const success = response();
    await handlers.bookSlot(req(), success);
    assert.strictEqual(success.statusCode, 200);
    assert.strictEqual(successState.lowBalanceReads, 1);

    const failureEvents = [];
    const failureState = { lowBalanceFailure: true };
    global.fetch = bookingFetch(failureEvents, failureState);
    const failSoft = response();
    await handlers.bookSlot(req(), failSoft);
    assert.strictEqual(failSoft.statusCode, 200);
    assert.strictEqual(failureState.lowBalanceReads, 1);
    assert.ok(failureEvents.includes("claim"));
  } finally { global.fetch = realFetch; }
});

test("a protection policy-read failure logs loudly and still books", async () => {
  const events = [];
  const errors = [];
  const realFetch = global.fetch;
  const realError = console.error;
  global.fetch = bookingFetch(events);
  console.error = (...args) => errors.push(args);
  try {
    const handlers = buildSchedulingHandlers({
      bookingGate: async () => { throw new Error("policy database unavailable"); },
      notify: async () => {},
    });
    const out = response();
    await handlers.bookSlot(req(), out);
    assert.strictEqual(out.statusCode, 200);
    assert.ok(events.includes("claim"));
    assert.ok(errors.some((args) => String(args[0]).includes("policy read failed")));
  } finally {
    console.error = realError;
    global.fetch = realFetch;
  }
});

test("invite booking returns 503 and makes no claim when card setup is unavailable", async () => {
  const events = [];
  const realFetch = global.fetch;
  global.fetch = bookingFetch(events);
  try {
    const handlers = buildSchedulingHandlers({
      bookingGate: async () => ({ allowed: false, status: "card_setup_unavailable" }),
      notify: async () => {},
    });
    const out = response();
    await handlers.bookSlot(req(), out);
    assert.strictEqual(out.statusCode, 503);
    assert.deepStrictEqual(out.body, { error: "card_setup_unavailable" });
    assert.ok(!events.includes("claim"));
  } finally { global.fetch = realFetch; }
});

test("athlete cancellation assesses its fee before the waitlist-fill seam", async () => {
  const events = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => "" });
    if (u.includes("/booking_invites") && method === "GET") return ok([{
      token: TOKEN, coach_id: COACH, athlete_id: ATHLETE, status: "accepted", expires_at: FUTURE,
      athletes: { name: "Athlete" },
    }]);
    if (u.includes("/bookable_slots") && method === "PATCH") return ok([{ id: SLOT, starts_at: FUTURE }]);
    if (u.includes("/credit_deductions") && method === "GET") return ok([]);
    if (u.includes("/package_purchases") && method === "GET") return ok([]);
    return ok([]);
  };
  try {
    const handlers = buildSchedulingHandlers({
      cancellationFee: async () => events.push("fee"),
      waitlistFill: async () => events.push("fill"),
      notify: async () => {},
    });
    const res = response();
    await handlers.cancelBooking(req(), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(events, ["fee", "fill"]);
  } finally { global.fetch = realFetch; }
});

test("coach cancellation assesses its no-charge fee seam before waitlist fill", async () => {
  const events = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => "" });
    if (u.includes("/bookable_slots") && method === "GET") {
      return ok([{ id: SLOT, coach_id: COACH, status: "booked", booked_by: ATHLETE }]);
    }
    if (u.includes("/bookable_slots") && method === "PATCH") return ok([{ id: SLOT, status: "cancelled" }]);
    if (u.includes("/credit_deductions") && method === "GET") return ok([]);
    return ok([]);
  };
  try {
    const handlers = buildSchedulingHandlers({
      requireSupabaseUser: async () => ({ user: { id: COACH, app_metadata: { role: "coach" } } }),
      cancellationFee: () => { events.push("fee"); return { assessed: false, reason: "coach_cancelled" }; },
      waitlistFill: () => events.push("fill"),
      notify: async () => {},
    });
    const out = response();
    await handlers.coachCancelBooking({ body: { slot_id: SLOT }, headers: {} }, out);
    assert.strictEqual(out.statusCode, 200);
    assert.deepStrictEqual(events, ["fee", "fill"]);
  } finally { global.fetch = realFetch; }
});
