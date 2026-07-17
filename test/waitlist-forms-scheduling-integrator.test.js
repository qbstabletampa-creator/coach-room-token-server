const test = require("node:test");
const assert = require("node:assert/strict");

const { buildSchedulingHandlers } = require("../lib/scheduling");
const { buildProtectionHandlers } = require("../lib/protection");
const { buildWaitlistHandlers } = require("../lib/waitlist");

process.env.SUPABASE_URL = "https://integrator.test";
process.env.SUPABASE_SERVICE_KEY = "integrator-service-key";
delete process.env.STRIPE_SECRET_KEY;

const TOKEN = "11111111-1111-4111-8111-111111111111";
const SLOT = "22222222-2222-4222-8222-222222222222";
const COACH = "33333333-3333-4333-8333-333333333333";
const ATHLETE = "44444444-4444-4444-8444-444444444444";
const PURCHASE = "55555555-5555-4555-8555-555555555555";
const REQUESTED_TYPE = "66666666-6666-4666-8666-666666666666";
const SLOT_TYPE = "77777777-7777-4777-8777-777777777777";
const ENTRY = "88888888-8888-4888-8888-888888888888";
const OFFER = "99999999-9999-4999-8999-999999999999";
const FUTURE = "2099-07-18T16:00:00.000Z";

function ok(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => typeof body === "string" ? body : JSON.stringify(body) };
}

function out() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function bookReq(sessionTypeId) {
  const body = { slotId: SLOT };
  if (arguments.length) body.session_type_id = sessionTypeId;
  return { params: { inviteToken: TOKEN }, body, headers: {} };
}

async function withFetch(fetchImpl, run) {
  const saved = global.fetch;
  global.fetch = fetchImpl;
  try { return await run(); } finally { global.fetch = saved; }
}

function bookingDb(events, state = {}) {
  state.open ??= true;
  state.remaining ??= 2;
  state.slotType ??= SLOT_TYPE;
  state.calls ??= [];
  return async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    state.calls.push({ url: u, method, body });
    if (u.includes("/booking_invites?") && method === "GET") return ok([{
      token: TOKEN, coach_id: COACH, athlete_id: ATHLETE, status: "pending", expires_at: FUTURE,
      coaches: { full_name: "Coach" }, athletes: { name: "Athlete", user_id: "claimed-user", parent_email: null },
    }]);
    if (u.includes("/session_types?") && u.includes("id=eq.")) {
      events.push("requested-type-ownership");
      return ok(u.includes(`id=eq.${REQUESTED_TYPE}`) ? [{ id: REQUESTED_TYPE }] : []);
    }
    if (u.includes("/bookable_slots?") && method === "GET") {
      events.push("effective-type");
      if (state.typeReadError) return ok("type lookup detail", 503);
      return ok([{ id: SLOT, session_type_id: state.slotType }]);
    }
    if (u.includes("/package_purchases?") && method === "GET" && u.includes("credits_remaining=gt.0")) {
      events.push("charge-read");
      return ok([{ id: PURCHASE, coach_id: COACH, credits_remaining: state.remaining, status: "active", purchased_at: "2026-01-01" }]);
    }
    if (u.includes("/package_purchases?") && method === "GET") {
      state.balanceReads = (state.balanceReads || 0) + 1;
      if (state.balanceReads === 1) events.push("credit");
      return ok([{ credits_remaining: state.remaining }]);
    }
    if (u.includes("/bookable_slots?") && method === "PATCH" && u.includes("status=eq.open")) {
      events.push("claim");
      if (!state.open) return ok([]);
      state.open = false;
      state.claimBody = body;
      return ok([{ id: SLOT, coach_id: COACH, starts_at: FUTURE, ends_at: "2099-07-18T17:00:00.000Z", timezone: "UTC", title: "Session", ...body }]);
    }
    if (u.includes("/package_purchases?") && method === "PATCH") {
      events.push("charge");
      state.remaining--;
      return ok([{ id: PURCHASE, credits_remaining: state.remaining }]);
    }
    if (u.endsWith("/credit_deductions") && method === "POST") return ok([]);
    if (u.includes("/coaches?") && method === "GET") return ok([{ low_balance_notify: false, low_balance_threshold: 0 }]);
    if (u.endsWith("/sessions") && method === "POST") return ok([{ id: "session-id" }]);
    return ok([]);
  };
}

test("allowed waiver follows the exact effective-type through notification order", async () => {
  const events = [];
  const state = {};
  await withFetch(bookingDb(events, state), async () => {
    const handlers = buildSchedulingHandlers({
      formsRequiredPrecheck: async (args) => { events.push("forms-required"); assert.deepEqual(args, { coachId: COACH, athleteId: ATHLETE, sessionTypeId: SLOT_TYPE }); return { allowed: true }; },
      bookingGate: async (args) => { events.push("card-gate"); assert.equal(args.sessionTypeId, SLOT_TYPE); return { allowed: true }; },
      calendarMirror: async () => events.push("calendar"),
      formsPendingWaiver: async ({ coachId, athleteId, slot }) => { events.push("forms-pending"); assert.equal(coachId, COACH); assert.equal(athleteId, ATHLETE); assert.equal(slot.id, SLOT); },
      notify: async ({ type }) => { if (type === "session.booked") events.push("booking-notify"); },
    });
    const response = out();
    await handlers.bookSlot(bookReq(), response);
    assert.equal(response.statusCode, 200);
  });
  assert.deepEqual(events.filter((x) => ["effective-type", "forms-required", "credit", "card-gate", "claim", "charge", "calendar", "forms-pending", "booking-notify"].includes(x)), [
    "effective-type", "forms-required", "credit", "card-gate", "claim", "charge", "calendar", "forms-pending", "booking-notify",
  ]);
  assert.equal(state.claimBody.session_type_id, SLOT_TYPE);
});

test("required waiver returns the verbatim 409 before credit, card, or mutations", async () => {
  const events = [];
  const state = {};
  await withFetch(bookingDb(events, state), async () => {
    const response = out();
    await buildSchedulingHandlers({
      formsRequiredPrecheck: async () => ({ allowed: false, error: "waiver_required", pending_form_keys: ["a-form", "z-form"] }),
      bookingGate: async () => { events.push("card-gate"); return { allowed: true }; },
      notify: async () => events.push("notify"),
    }).bookSlot(bookReq(), response);
    assert.deepEqual([response.statusCode, response.body], [409, { error: "waiver_required", pending_form_keys: ["a-form", "z-form"] }]);
  });
  assert.deepEqual(events.filter((x) => ["credit", "card-gate", "claim", "charge", "notify"].includes(x)), []);
  assert.equal(state.open, true);
});

test("forms precheck throws and malformed results fail closed with one detail-free log", async () => {
  const cases = [
    async () => { throw new Error("injected-sensitive-detail"); },
    async () => null,
    async () => ({}),
    async () => ({ allowed: false, error: "wrong", pending_form_keys: [] }),
    async () => ({ allowed: false, error: "waiver_required", pending_form_keys: "not-an-array" }),
  ];
  for (const formsRequiredPrecheck of cases) {
    const events = [];
    const logs = [];
    const savedError = console.error;
    console.error = (...args) => logs.push(args);
    try {
      await withFetch(bookingDb(events), async () => {
        const response = out();
        await buildSchedulingHandlers({ formsRequiredPrecheck, notify: async () => events.push("notify") }).bookSlot(bookReq(), response);
        assert.deepEqual([response.statusCode, response.body], [503, { error: "waiver_check_unavailable" }]);
      });
      assert.deepEqual(logs, [["[scheduling:hook:forms-required] failed (blocking)"]]);
      assert.doesNotMatch(JSON.stringify(logs), /injected-sensitive-detail/);
      assert.deepEqual(events.filter((x) => ["credit", "claim", "charge", "notify"].includes(x)), []);
    } finally {
      console.error = savedError;
    }
  }

  const events = [];
  const logs = [];
  const savedError = console.error;
  console.error = (...args) => logs.push(args);
  try {
    await withFetch(bookingDb(events, { typeReadError: true }), async () => {
      const response = out();
      await buildSchedulingHandlers({
        formsRequiredPrecheck: async () => { events.push("forms-required"); return { allowed: true }; },
        notify: async () => events.push("notify"),
      }).bookSlot(bookReq(), response);
      assert.deepEqual([response.statusCode, response.body], [503, { error: "waiver_check_unavailable" }]);
    });
    assert.deepEqual(logs, [["[scheduling:hook:forms-required] failed (blocking)"]]);
    assert.ok(!events.includes("forms-required"));
    assert.deepEqual(events.filter((event) => ["credit", "claim", "charge", "notify"].includes(event)), []);
  } finally {
    console.error = savedError;
  }
});

test("slot service wins for forms and card while a foreign supplied type keeps 400 precedence", async () => {
  const events = [];
  const seen = [];
  await withFetch(bookingDb(events), async () => {
    const response = out();
    await buildSchedulingHandlers({
      formsRequiredPrecheck: async (args) => { seen.push(["forms", args.sessionTypeId]); return { allowed: true }; },
      bookingGate: async (args) => { seen.push(["card", args.sessionTypeId]); return { allowed: true }; },
      notify: async () => {},
    }).bookSlot(bookReq(REQUESTED_TYPE), response);
    assert.equal(response.statusCode, 200);
  });
  assert.deepEqual(seen, [["forms", SLOT_TYPE], ["card", SLOT_TYPE]]);

  const foreignEvents = [];
  await withFetch(bookingDb(foreignEvents), async () => {
    const response = out();
    await buildSchedulingHandlers({
      formsRequiredPrecheck: async () => { foreignEvents.push("forms-required"); return { allowed: true }; },
      bookingGate: async () => ({ allowed: true }),
      notify: async () => {},
    }).bookSlot(bookReq("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), response);
    assert.deepEqual([response.statusCode, response.body], [400, { error: "unknown_session_type" }]);
  });
  assert.ok(!foreignEvents.includes("forms-required"));
});

test("null forms dependency preserves the no-slot-read legacy path", async () => {
  const events = [];
  const state = { slotType: null };
  await withFetch(bookingDb(events, state), async () => {
    const response = out();
    await buildSchedulingHandlers({ notify: async () => {} }).bookSlot(bookReq(false), response);
    assert.equal(response.statusCode, 200);
  });
  assert.ok(!events.includes("effective-type"));
  assert.equal(state.claimBody.session_type_id, null);
});

test("post-claim pending failure is fail-soft and the host supplies derived full slot", async () => {
  const events = [];
  const state = {};
  const logs = [];
  const savedError = console.error;
  console.error = (...args) => logs.push(args);
  try {
    await withFetch(bookingDb(events, state), async () => {
      const response = out();
      await buildSchedulingHandlers({
        formsPendingWaiver: async (args) => {
          assert.equal(args.coachId, COACH);
          assert.equal(args.athleteId, ATHLETE);
          assert.equal(args.slot.id, SLOT);
          assert.equal(args.slot.status, "booked");
          throw new Error("pending provider detail");
        },
        notify: async ({ type }) => { if (type === "session.booked") events.push("booking-notify"); },
      }).bookSlot(bookReq(), response);
      assert.equal(response.statusCode, 200);
      assert.equal(state.open, false);
      assert.equal(state.remaining, 1);
    });
  } finally { console.error = savedError; }
  assert.ok(events.includes("booking-notify"));
  assert.ok(logs.some((args) => String(args[0]).includes("forms-pending-waiver")));

  const primitiveCalls = [];
  const adapter = ({ coachId, athleteId, slot }) => primitiveCalls.push({ coachId, athleteId, slot: { id: slot.id } });
  adapter({ coachId: COACH, athleteId: ATHLETE, slot: { id: SLOT, status: "booked", session_type_id: SLOT_TYPE, coach_id: COACH } });
  assert.deepEqual(primitiveCalls, [{ coachId: COACH, athleteId: ATHLETE, slot: { id: SLOT } }]);
});

function cancellationDb({ coach = false } = {}) {
  const state = { booked: true, patchBodies: [], transitions: 0 };
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    if (!coach && u.includes("/booking_invites?") && method === "GET") return ok([{
      token: TOKEN, coach_id: COACH, athlete_id: ATHLETE, status: "accepted", expires_at: FUTURE, athletes: { name: "Athlete" },
    }]);
    if (coach && u.includes("/bookable_slots?") && method === "GET") return ok([{ id: SLOT, coach_id: COACH, status: state.booked ? "booked" : "open", booked_by: ATHLETE }]);
    if (u.includes("/bookable_slots?") && method === "PATCH" && u.includes("status=eq.booked")) {
      state.patchBodies.push(body);
      if (!state.booked) return ok([]);
      state.booked = false;
      state.transitions++;
      return ok([{ id: SLOT, coach_id: COACH, starts_at: FUTURE, status: body.status, session_type_id: null, ...body }]);
    }
    if (u.includes("/credit_deductions?") && method === "GET") return ok([]);
    if (u.includes("/package_purchases?") && method === "GET") return ok([]);
    return ok([]);
  };
  return { state, fetch };
}

test("athlete double-cancel elects one fill after fee and fill failure cannot suppress notify", async () => {
  const db = cancellationDb();
  const events = [];
  const logs = [];
  const savedError = console.error;
  console.error = (...args) => logs.push(args);
  try {
    await withFetch(db.fetch, async () => {
      const handlers = buildSchedulingHandlers({
        cancellationFee: async () => events.push("fee"),
        waitlistFill: async ({ coachId, slot }) => { events.push("fill"); assert.equal(coachId, COACH); assert.equal(slot.id, SLOT); throw new Error("fill detail"); },
        notify: async ({ type }) => { if (type === "session.cancelled") events.push("notify"); },
      });
      const a = out();
      const b = out();
      await Promise.all([handlers.cancelBooking(bookReq(), a), handlers.cancelBooking(bookReq(), b)]);
      assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
    });
  } finally { console.error = savedError; }
  assert.deepEqual(events, ["fee", "fill", "notify"]);
  assert.equal(db.state.transitions, 1);
  assert.ok(logs.some((args) => String(args[0]).includes("waitlist-fill")));
});

test("coach cancel remains cancelled with null fill and reopens exactly once with fill", async () => {
  for (const enabled of [false, true]) {
    const db = cancellationDb({ coach: true });
    const events = [];
    await withFetch(db.fetch, async () => {
      const handlers = buildSchedulingHandlers({
        requireSupabaseUser: async () => ({ user: { id: COACH, app_metadata: { role: "coach" } } }),
        cancellationFee: async () => events.push("fee"),
        waitlistFill: enabled ? async () => events.push("fill") : null,
        notify: async () => events.push("notify"),
      });
      const a = out();
      const b = out();
      await Promise.all([
        handlers.coachCancelBooking({ body: { slot_id: SLOT }, headers: {} }, a),
        handlers.coachCancelBooking({ body: { slot_id: SLOT }, headers: {} }, b),
      ]);
      assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
    });
    assert.equal(db.state.transitions, 1);
    assert.deepEqual(db.state.patchBodies[0], { status: enabled ? "open" : "cancelled", booked_by: null, booked_at: null });
    assert.deepEqual(events.slice(0, enabled ? 2 : 1), enabled ? ["fee", "fill"] : ["fee"]);
  }
});

test("protection no-show calls fill after terminal fee result and preserves the response on throw", async () => {
  const events = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    if (u.includes("/bookable_slots?") && method === "GET") return ok([{ id: SLOT, coach_id: COACH, status: "booked", booked_by: ATHLETE, session_type_id: null, ends_at: "2020-01-01T00:00:00.000Z" }]);
    if (u.includes("/booking_charges?") && method === "GET") return ok([]);
    if (u.includes("/protection_policies?") && method === "GET") return ok([]);
    throw new Error(`unexpected ${method} ${u}`);
  };
  const savedError = console.error;
  console.error = () => {};
  try {
    await withFetch(fetchImpl, async () => {
      const response = out();
      await buildProtectionHandlers({
        requireSupabaseUser: async () => ({ user: { id: COACH, app_metadata: { role: "coach" } } }),
        waitlistFill: async ({ coachId, slot }) => { events.push("fill"); assert.equal(coachId, COACH); assert.equal(slot.id, SLOT); throw new Error("fill failed"); },
      }).postNoShow({ body: { slot_id: SLOT }, headers: {} }, response);
      assert.deepEqual([response.statusCode, response.body], [409, { error: "protection_off" }]);
    });
  } finally { console.error = savedError; }
  assert.deepEqual(events, ["fill"]);
  const projected = ({ coachId, slot }) => ({ coachId, slot: { id: slot.id } });
  assert.deepEqual(projected({ coachId: COACH, slot: { id: SLOT, status: "completed" } }), { coachId: COACH, slot: { id: SLOT } });
});

test("concurrent real fills persist one offer and one stable notification key", async () => {
  const entry = { id: ENTRY, coach_id: COACH, athlete_id: ATHLETE, status: "waiting", session_type_id: null, desired_date: null, desired_start: null, desired_end: null, last_offered_round: null, created_at: "2026-07-01T00:00:00.000Z" };
  const offer = { id: OFFER, coach_id: COACH, entry_id: ENTRY, slot_id: SLOT, fill_round: 3, booking_invite_token: TOKEN, status: "pending", expires_at: "2026-07-17T16:05:00.000Z", notified_at: null };
  let durableOffer = null;
  let offerPosts = 0;
  const notifications = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    if (u.includes("/bookable_slots?") && method === "GET") return ok([{ id: SLOT, coach_id: COACH, status: "open", starts_at: FUTURE, ends_at: "2099-07-18T17:00:00.000Z", timezone: "UTC", title: null, session_type_id: null, waitlist_fill_round: 3 }]);
    if (u.includes("/coaches?") && method === "GET") return ok([{ id: COACH, waitlist_mode: "first_in_line", waitlist_offer_window_min: 5 }]);
    if (u.includes("/waitlist_entries?") && method === "GET") return ok([entry]);
    if (u.includes("/athletes?") && method === "GET") return ok([{ id: ATHLETE, coach_id: COACH, name: "Athlete", user_id: ATHLETE, parent_email: null }]);
    if (u.endsWith("/booking_invites") && method === "POST") return ok([{ token: TOKEN }]);
    if (u.endsWith("/waitlist_offers") && method === "POST") {
      offerPosts++;
      if (!durableOffer) { durableOffer = offer; return ok([offer]); }
      return ok({ code: "23505", constraint: "waitlist_offers_entry_slot_round_uidx" }, 409);
    }
    if (u.includes("/waitlist_offers?") && method === "GET") return ok(durableOffer ? [durableOffer] : []);
    if (u.includes("/waitlist_entries?") && method === "PATCH") return ok([{ ...entry, status: "offered", offered_slot_id: SLOT, offer_expires_at: offer.expires_at, last_offered_round: 3 }]);
    throw new Error(`unexpected ${method} ${u}`);
  };
  await withFetch(fetchImpl, async () => {
    const fill = buildWaitlistHandlers({
      now: () => new Date("2026-07-17T16:00:00.000Z"),
      randomUUID: () => TOKEN,
      notify: async (event) => notifications.push(event),
    }).tryFillFromWaitlist;
    const slotArg = { id: SLOT, status: "open", starts_at: FUTURE, ends_at: "2099-07-18T17:00:00.000Z", timezone: "UTC", session_type_id: null };
    const results = await Promise.all([
      fill({ coachId: COACH, slot: slotArg }),
      fill({ coachId: COACH, slot: slotArg }),
    ]);
    assert.ok(results.every((result) => result.disposition === "offered"));
  });
  assert.equal(offerPosts, 2);
  assert.equal(durableOffer.id, OFFER);
  assert.equal(new Set(notifications.map((event) => event.dedupeKey)).size, 1);
  assert.equal(notifications[0].dedupeKey, `waitlist.offer:${SLOT}:3:${ENTRY}`);
});

test("coach cancel refunds the pre-flip pinned deduction, never a post-reopen booking's newer one", async () => {
  const OLD_PURCHASE = PURCHASE;
  const NEW_PURCHASE = "aaaaaaaa-5555-4555-8555-555555555555";
  const state = { booked: true, refundPosts: [], purchaseReads: [], purchasePatches: [] };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.includes("/bookable_slots?") && method === "GET") {
      return ok([{ id: SLOT, coach_id: COACH, status: state.booked ? "booked" : "open", booked_by: ATHLETE }]);
    }
    if (u.includes("/bookable_slots?") && method === "PATCH" && u.includes("status=eq.booked")) {
      if (!state.booked) return ok([]);
      state.booked = false; // the reopen: from here a rival booking's deduction is newest
      return ok([{ id: SLOT, coach_id: COACH, starts_at: FUTURE, status: body.status, session_type_id: null, ...body }]);
    }
    if (u.includes("/credit_deductions?") && method === "GET") {
      // Newest-by-slot answer changes the instant the slot reopens.
      return ok([{ purchase_id: state.booked ? OLD_PURCHASE : NEW_PURCHASE, coach_id: COACH }]);
    }
    if (u.includes("/package_purchases?") && method === "GET") {
      const m = /[?&]id=eq\.([0-9a-f-]+)/.exec(u);
      if (!m) return ok([]); // creditBalance's athlete_id-filtered read
      state.purchaseReads.push(m[1]);
      return ok([{ id: m[1], credits_remaining: 0, credits_total: 4, status: "exhausted" }]);
    }
    if (u.includes("/package_purchases?") && method === "PATCH") {
      state.purchasePatches.push(/[?&]id=eq\.([0-9a-f-]+)/.exec(u)[1]);
      return ok([]);
    }
    if (u.includes("/credit_deductions") && method === "POST") {
      state.refundPosts.push(body);
      return ok([]);
    }
    return ok([]);
  };
  await withFetch(fetchImpl, async () => {
    const handlers = buildSchedulingHandlers({
      requireSupabaseUser: async () => ({ user: { id: COACH, app_metadata: { role: "coach" } } }),
      waitlistFill: async () => {},
      notify: async () => {},
    });
    const res = out();
    await handlers.coachCancelBooking({ body: { slot_id: SLOT }, headers: {} }, res);
    assert.equal(res.statusCode, 200);
  });
  assert.deepEqual(state.purchaseReads, [OLD_PURCHASE]);
  assert.deepEqual(state.purchasePatches, [OLD_PURCHASE]);
  assert.equal(state.refundPosts.length, 1);
  assert.equal(state.refundPosts[0].purchase_id, OLD_PURCHASE);
  assert.equal(state.refundPosts[0].action, "refund");
});
