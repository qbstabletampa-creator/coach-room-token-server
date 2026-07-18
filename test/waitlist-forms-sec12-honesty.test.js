const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { buildSchedulingHandlers } = require("../lib/scheduling");
const { buildProtectionHandlers } = require("../lib/protection");
const { buildWaitlistHandlers } = require("../lib/waitlist");

process.env.SUPABASE_URL = "https://sec12.test";
process.env.SUPABASE_SERVICE_KEY = "sec12-service-key";
delete process.env.STRIPE_SECRET_KEY;

const TOKEN = "11111111-1111-4111-8111-111111111111";
const SLOT = "22222222-2222-4222-8222-222222222222";
const COACH = "33333333-3333-4333-8333-333333333333";
const ATHLETE = "44444444-4444-4444-8444-444444444444";
const OLD_PURCHASE = "55555555-5555-4555-8555-555555555555";
const TYPE = "66666666-6666-4666-8666-666666666666";
const ENTRY = "77777777-7777-4777-8777-777777777777";
const OFFER = "88888888-8888-4888-8888-888888888888";
const NEXT_ATHLETE = "99999999-9999-4999-8999-999999999999";
const NEXT_ENTRY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEXT_OFFER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NEXT_TOKEN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RIVAL = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RIVAL_PURCHASE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CHARGE = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const NOW = "2026-07-17T16:00:00.000Z";
const FUTURE = "2099-07-18T16:00:00.000Z";

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  };
}

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function withFetch(fetchImpl, run) {
  const saved = global.fetch;
  global.fetch = fetchImpl;
  try { return await run(); } finally { global.fetch = saved; }
}

function methodOf(init) {
  return String(init.method || "GET").toUpperCase();
}

function bodyOf(init) {
  return init.body === undefined ? undefined : JSON.parse(init.body);
}

function normalizedProtectionWrites(writes) {
  return writes.map(([table, body]) => {
    if (!body || !Object.hasOwn(body, "updated_at")) return [table, body];
    assert.ok(Number.isFinite(Date.parse(body.updated_at)), `${table}.updated_at must be an ISO timestamp`);
    const { updated_at, ...stable } = body;
    return [table, { ...stable, updated_at: "<iso>" }];
  });
}

function inviteRequest() {
  return { params: { inviteToken: TOKEN }, body: { slotId: SLOT }, headers: {} };
}

test("§12 invite cancel-vs-book race: rival booking between reopen and refund cannot steal the pinned refund", async () => {
  const state = {
    slot: { status: "booked", booked_by: ATHLETE },
    deductions: [{ purchase_id: OLD_PURCHASE, coach_id: COACH, athlete_id: ATHLETE }],
    purchases: {
      [OLD_PURCHASE]: { id: OLD_PURCHASE, credits_remaining: 0, credits_total: 4, status: "exhausted" },
      [RIVAL_PURCHASE]: { id: RIVAL_PURCHASE, credits_remaining: 2, credits_total: 4, status: "active" },
    },
    refundRows: [],
  };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url), method = methodOf(init), body = bodyOf(init);
    if (u.includes("/booking_invites?") && method === "GET") return response([{
      token: TOKEN, coach_id: COACH, athlete_id: ATHLETE, status: "accepted", expires_at: FUTURE,
      athletes: { name: "Cancelled athlete" },
    }]);
    if (u.includes("/credit_deductions?") && method === "GET") {
      return response([state.deductions[state.deductions.length - 1]]);
    }
    if (u.includes("/bookable_slots?") && method === "PATCH") {
      assert.equal(state.slot.booked_by, ATHLETE);
      assert.deepEqual(body, { status: "open", booked_by: null, booked_at: null });
      // The cancellation flip exposes the slot. A rival immediately claims it and
      // appends a newer deduction before refundBookingCredit resumes.
      state.slot = { status: "booked", booked_by: RIVAL };
      state.deductions.push({ purchase_id: RIVAL_PURCHASE, coach_id: COACH, athlete_id: RIVAL });
      return response([{ id: SLOT, coach_id: COACH, status: "open", starts_at: FUTURE, ends_at: FUTURE, timezone: "UTC", session_type_id: null, ...body }]);
    }
    if (u.includes("/package_purchases?") && method === "GET") {
      const match = /[?&]id=eq\.([0-9a-f-]+)/.exec(u);
      if (!match) return response([{ credits_remaining: state.purchases[OLD_PURCHASE].credits_remaining }]);
      return response([state.purchases[match[1]]]);
    }
    if (u.includes("/package_purchases?") && method === "PATCH") {
      const id = /[?&]id=eq\.([0-9a-f-]+)/.exec(u)[1];
      state.purchases[id] = { ...state.purchases[id], ...body };
      return response([]);
    }
    if (u.endsWith("/credit_deductions") && method === "POST") {
      state.refundRows.push(body);
      return response([]);
    }
    return response([]);
  };

  await withFetch(fetchImpl, async () => {
    const out = res();
    await buildSchedulingHandlers({ notify: async () => {} }).cancelBooking(inviteRequest(), out);
    assert.equal(out.statusCode, 200);
  });

  assert.deepEqual(state.slot, { status: "booked", booked_by: RIVAL }, "the rival booking survives");
  assert.deepEqual(state.purchases[OLD_PURCHASE], { id: OLD_PURCHASE, credits_remaining: 1, credits_total: 4, status: "active" });
  assert.deepEqual(state.purchases[RIVAL_PURCHASE], { id: RIVAL_PURCHASE, credits_remaining: 2, credits_total: 4, status: "active" });
  assert.deepEqual(state.refundRows, [{
    coach_id: COACH, purchase_id: OLD_PURCHASE, slot_id: SLOT,
    action: "refund", amount: 1, reason: "cancellation",
  }]);
});

test("§12 invite cancel-vs-book race: failed pre-read uses the legacy self-read and still refunds", async () => {
  let deductionReads = 0;
  const writes = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url), method = methodOf(init), body = bodyOf(init);
    if (u.includes("/booking_invites?") && method === "GET") return response([{
      token: TOKEN, coach_id: COACH, athlete_id: ATHLETE, status: "accepted", expires_at: FUTURE,
      athletes: { name: "Athlete" },
    }]);
    if (u.includes("/credit_deductions?") && method === "GET") {
      deductionReads++;
      return deductionReads === 1
        ? response("temporary read failure", 503)
        : response([{ purchase_id: OLD_PURCHASE, coach_id: COACH }]);
    }
    if (u.includes("/bookable_slots?") && method === "PATCH") {
      writes.push(["slot", body]);
      return response([{ id: SLOT, coach_id: COACH, status: "open", starts_at: FUTURE, session_type_id: null, ...body }]);
    }
    if (u.includes("/package_purchases?") && method === "GET") {
      if (u.includes("id=eq.")) return response([{ id: OLD_PURCHASE, credits_remaining: 0, credits_total: 2, status: "exhausted" }]);
      return response([{ credits_remaining: 1 }]);
    }
    if (u.includes("/package_purchases?") && method === "PATCH") {
      writes.push(["purchase", body]);
      return response([]);
    }
    if (u.endsWith("/credit_deductions") && method === "POST") {
      writes.push(["refund", body]);
      return response([]);
    }
    return response([]);
  };

  await withFetch(fetchImpl, async () => {
    const out = res();
    await buildSchedulingHandlers({ notify: async () => {} }).cancelBooking(inviteRequest(), out);
    assert.equal(out.statusCode, 200);
  });

  assert.equal(deductionReads, 2, "undefined pin tells refundBookingCredit to perform its legacy read");
  assert.deepEqual(writes, [
    ["slot", { status: "open", booked_by: null, booked_at: null }],
    ["purchase", { credits_remaining: 1, status: "active" }],
    ["refund", { coach_id: COACH, purchase_id: OLD_PURCHASE, slot_id: SLOT, action: "refund", amount: 1, reason: "cancellation" }],
  ]);
});

function noShowHarness({ policy = "on", feeType = "flat", feeValue = 1500, hasCard = true, prior = null } = {}) {
  let charge = prior ? { ...prior } : null;
  const writes = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url), method = methodOf(init), body = bodyOf(init);
    if (u.includes("/bookable_slots?") && method === "GET") return response([{
      id: SLOT, coach_id: COACH, status: "booked", booked_by: ATHLETE,
      session_type_id: TYPE, ends_at: "2020-01-01T00:00:00.000Z",
    }]);
    if (u.includes("/bookable_slots?") && method === "PATCH") {
      writes.push(["bookable_slots", body]);
      return response([{ id: SLOT, status: "completed", ...body }]);
    }
    if (u.includes("/session_types?") && method === "GET") return response([{ id: TYPE, price_cents: 6000 }]);
    if (u.includes("/protection_policies?") && method === "GET") {
      if (u.includes("session_type_id=eq.")) return response([]);
      if (policy === "missing") return response([]);
      return response([{ enabled: policy === "on", no_show_fee_type: feeType, no_show_fee_value: feeValue }]);
    }
    if (u.includes("/athlete_payment_methods?") && method === "GET") {
      return response(hasCard ? [{ stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_1" }] : []);
    }
    if (u.includes("/booking_charges?") && method === "GET") return response(charge ? [charge] : []);
    if (u.endsWith("/booking_charges") && method === "POST") {
      charge = { id: CHARGE, created_at: NOW, ...body };
      writes.push(["booking_charges", body]);
      return response([charge], 201);
    }
    if (u.includes("/booking_charges?") && method === "PATCH") {
      charge = { ...charge, ...body };
      writes.push(["booking_charges", body]);
      return response([charge]);
    }
    if (u.includes("/athletes?") && method === "GET") return response([{ id: ATHLETE, user_id: ATHLETE, name: "Athlete" }]);
    return response([]);
  };
  return { fetchImpl, writes, getCharge: () => charge };
}

const coachAuth = async () => ({ user: { id: COACH, app_metadata: { role: "coach" } } });

test("§12 no-show fee terminal matrix writes the exact durable state for every outcome", async (t) => {
  const baseInsert = {
    coach_id: COACH, athlete_id: ATHLETE, slot_id: SLOT, session_type_id: TYPE,
    kind: "no_show_fee", amount_cents: 1500, status: "pending",
    stripe_payment_intent_id: null, reason: "No-show fee",
  };

  for (const [name, options, expectedError] of [
    ["protection off", { policy: "missing" }, "protection_off"],
    ["fee waived by policy", { feeType: "none", feeValue: 0 }, "no_fee"],
    ["protection has no saved card", { hasCard: false }, "no_payment_method"],
  ]) {
    await t.test(name, async () => {
      const db = noShowHarness(options);
      await withFetch(db.fetchImpl, async () => {
        const out = res();
        await buildProtectionHandlers({ requireSupabaseUser: coachAuth, notify: async () => {} })
          .postNoShow({ body: { slot_id: SLOT }, headers: {} }, out);
        assert.deepEqual([out.statusCode, out.body], [409, { error: expectedError }]);
      });
      assert.deepEqual(db.writes, []);
    });
  }

  await t.test("already-waived terminal incident is preserved", async () => {
    const waived = { id: CHARGE, ...baseInsert, status: "waived" };
    const db = noShowHarness({ prior: waived });
    await withFetch(db.fetchImpl, async () => {
      const out = res();
      await buildProtectionHandlers({ requireSupabaseUser: coachAuth, notify: async () => {} })
        .postNoShow({ body: { slot_id: SLOT }, headers: {} }, out);
      assert.equal(out.statusCode, 200);
      assert.equal(out.body.charge.status, "waived");
    });
    assert.deepEqual(db.writes, []);
  });

  await t.test("charged successfully", async () => {
    const db = noShowHarness();
    await withFetch(db.fetchImpl, async () => {
      const out = res();
      await buildProtectionHandlers({
        requireSupabaseUser: coachAuth,
        notify: async () => {},
        mirrorStripePayment: async () => ({ inserted: true }),
      }).postNoShow({ body: { slot_id: SLOT }, headers: {} }, out);
      assert.equal(out.statusCode, 200);
      assert.equal(out.body.charge.status, "succeeded");
    });
    assert.deepEqual(normalizedProtectionWrites(db.writes), [
      ["booking_charges", baseInsert],
      ["bookable_slots", { status: "completed" }],
      ["booking_charges", { stripe_payment_intent_id: `pi_simulated_${CHARGE}`, status: "succeeded", updated_at: "<iso>" }],
      ["booking_charges", { status: "succeeded", stripe_payment_intent_id: `pi_simulated_${CHARGE}`, updated_at: "<iso>" }],
    ]);
  });

  await t.test("card requires action", async () => {
    const db = noShowHarness();
    const stripe = { paymentIntents: { create: async (args) => {
      const error = new Error("authentication required");
      error.payment_intent = { id: "pi_action", status: "requires_action", amount: args.amount, metadata: args.metadata };
      throw error;
    } } };
    await withFetch(db.fetchImpl, async () => {
      const out = res();
      await buildProtectionHandlers({
        requireSupabaseUser: coachAuth, notify: async () => {},
        getStripeSecretKey: () => "sk_test", createStripe: () => stripe,
      }).postNoShow({ body: { slot_id: SLOT }, headers: {} }, out);
      assert.deepEqual([out.statusCode, out.body.error], [402, "requires_action"]);
    });
    assert.deepEqual(normalizedProtectionWrites(db.writes), [
      ["booking_charges", baseInsert],
      ["bookable_slots", { status: "completed" }],
      ["booking_charges", { status: "requires_action", stripe_payment_intent_id: "pi_action", updated_at: "<iso>" }],
    ]);
  });

  await t.test("payment intent fails", async () => {
    const db = noShowHarness();
    const stripe = { paymentIntents: { create: async (args) => {
      const error = new Error("declined");
      error.payment_intent = { id: "pi_failed", status: "requires_payment_method", amount: args.amount, metadata: args.metadata };
      throw error;
    } } };
    await withFetch(db.fetchImpl, async () => {
      const out = res();
      await buildProtectionHandlers({
        requireSupabaseUser: coachAuth, notify: async () => {},
        getStripeSecretKey: () => "sk_test", createStripe: () => stripe,
      }).postNoShow({ body: { slot_id: SLOT }, headers: {} }, out);
      assert.deepEqual([out.statusCode, out.body.error], [402, "payment_failed"]);
    });
    assert.deepEqual(normalizedProtectionWrites(db.writes), [
      ["booking_charges", baseInsert],
      ["bookable_slots", { status: "completed" }],
      ["booking_charges", { status: "failed", stripe_payment_intent_id: "pi_failed", updated_at: "<iso>" }],
      ["booking_charges", { status: "failed", stripe_payment_intent_id: "pi_failed", updated_at: "<iso>" }],
    ]);
  });

  await t.test("provider fails without a payment intent", async () => {
    const db = noShowHarness();
    const stripe = { paymentIntents: { create: async () => { throw new Error("provider unavailable"); } } };
    await withFetch(db.fetchImpl, async () => {
      const out = res();
      await buildProtectionHandlers({
        requireSupabaseUser: coachAuth, notify: async () => {},
        getStripeSecretKey: () => "sk_test", createStripe: () => stripe,
      }).postNoShow({ body: { slot_id: SLOT }, headers: {} }, out);
      assert.deepEqual([out.statusCode, out.body], [502, { error: "payment_provider_error" }]);
    });
    assert.deepEqual(normalizedProtectionWrites(db.writes), [
      ["booking_charges", baseInsert],
      ["bookable_slots", { status: "completed" }],
      ["booking_charges", { status: "failed", updated_at: "<iso>" }],
    ]);
  });
});

test("§12 unclaimed-athlete fill notification emails the parent and marks the offer channel row", async () => {
  const emails = [], notifications = [], writes = [];
  const entry = {
    id: ENTRY, coach_id: COACH, athlete_id: ATHLETE, status: "waiting",
    session_type_id: null, desired_date: null, desired_start: null, desired_end: null,
    last_offered_round: null, created_at: NOW,
  };
  const offer = {
    id: OFFER, coach_id: COACH, entry_id: ENTRY, slot_id: SLOT, fill_round: 4,
    booking_invite_token: TOKEN, status: "pending", expires_at: "2026-07-17T16:10:00.000Z", notified_at: null,
  };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url), method = methodOf(init), body = bodyOf(init);
    if (u.includes("/bookable_slots?") && method === "GET") return response([{
      id: SLOT, coach_id: COACH, status: "open", starts_at: FUTURE, ends_at: FUTURE,
      timezone: "UTC", title: "Opening", session_type_id: null, waitlist_fill_round: 4,
    }]);
    if (u.includes("/coaches?") && method === "GET") return response([{ id: COACH, waitlist_mode: "first_in_line", waitlist_offer_window_min: 10 }]);
    if (u.includes("/waitlist_entries?") && method === "GET") return response([entry]);
    if (u.includes("/athletes?") && method === "GET") return response([{
      id: ATHLETE, coach_id: COACH, name: "Unclaimed athlete", user_id: null, parent_email: "parent@example.test",
    }]);
    if (u.endsWith("/booking_invites") && method === "POST") return response([{ token: TOKEN, ...body }], 201);
    if (u.endsWith("/waitlist_offers") && method === "POST") return response([offer], 201);
    if (u.includes("/waitlist_entries?") && method === "PATCH") {
      writes.push(["entry", u, body]);
      return response([{ ...entry, ...body }]);
    }
    if (u.includes("/waitlist_offers?") && method === "PATCH") {
      writes.push(["offer", u, body]);
      return response([{ ...offer, ...body }]);
    }
    throw new Error(`unexpected ${method} ${u}`);
  };

  await withFetch(fetchImpl, async () => {
    const result = await buildWaitlistHandlers({
      now: () => new Date(NOW), randomUUID: () => TOKEN,
      getBookBaseUrl: () => "https://book.example.test",
      notify: async (event) => notifications.push(event),
      sendEmail: async (email) => emails.push(email),
    }).tryFillFromWaitlist({
      coachId: COACH,
      slot: { id: SLOT, status: "open", starts_at: FUTURE, ends_at: FUTURE, timezone: "UTC", session_type_id: null },
    });
    assert.equal(result.disposition, "offered");
  });

  assert.equal(notifications.length, 0, "there is no auth user for an in-app notification row");
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, "parent@example.test");
  assert.equal(emails[0].subject, "A session opened up");
  assert.match(emails[0].text, new RegExp(`https://book\\.example\\.test/book/${TOKEN}`));
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1][2], { status: "notified", notified_at: NOW });
  assert.match(writes[1][1], new RegExp(`waitlist_offers\\?id=eq\\.${OFFER}.*notified_at=is\\.null`));
});

test("§12 expiry roll-to-next-waiter expires the old offer and creates a five-minute successor", async () => {
  const expiry = "2026-07-17T15:59:00.000Z";
  const nextExpiry = "2026-07-17T16:05:00.000Z";
  const oldOffer = {
    id: OFFER, coach_id: COACH, entry_id: ENTRY, slot_id: SLOT, fill_round: 7,
    booking_invite_token: TOKEN, status: "notified", expires_at: expiry,
  };
  let oldEntry = {
    id: ENTRY, coach_id: COACH, athlete_id: ATHLETE, status: "offered", offered_slot_id: SLOT,
    offer_expires_at: expiry, last_offered_round: 7, session_type_id: null,
    desired_date: null, desired_start: null, desired_end: null, created_at: "2026-07-01T00:00:00.000Z",
  };
  let nextEntry = {
    id: NEXT_ENTRY, coach_id: COACH, athlete_id: NEXT_ATHLETE, status: "waiting",
    offered_slot_id: null, offer_expires_at: null, last_offered_round: null, session_type_id: null,
    desired_date: null, desired_start: null, desired_end: null, created_at: "2026-07-02T00:00:00.000Z",
  };
  const writes = [], posts = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url), method = methodOf(init), body = bodyOf(init);
    if (u.includes("/waitlist_offers?") && method === "GET") return response([oldOffer]);
    if (u.includes("/waitlist_offers?") && method === "PATCH") {
      writes.push(["offer", u, body]);
      if (u.includes(`id=eq.${OFFER}`)) return response([{ ...oldOffer, ...body }]);
      return response([{ id: NEXT_OFFER, coach_id: COACH, ...body }]);
    }
    if (u.includes("/booking_invites?") && method === "PATCH") {
      writes.push(["invite", u, body]);
      return response([{ token: TOKEN, status: body.status }]);
    }
    if (u.includes("/waitlist_entries?") && method === "PATCH") {
      writes.push(["entry", u, body]);
      if (u.includes(`id=eq.${ENTRY}`)) {
        oldEntry = { ...oldEntry, ...body };
        return response([oldEntry]);
      }
      nextEntry = { ...nextEntry, ...body };
      return response([nextEntry]);
    }
    if (u.includes("/bookable_slots?") && method === "GET") return response([{
      id: SLOT, coach_id: COACH, status: "open", starts_at: FUTURE, ends_at: FUTURE,
      timezone: "UTC", title: null, session_type_id: null, waitlist_fill_round: 7,
    }]);
    if (u.includes("/coaches?") && method === "GET") return response([{ id: COACH, waitlist_mode: "first_in_line", waitlist_offer_window_min: 5 }]);
    if (u.includes("/waitlist_entries?") && method === "GET") return response([oldEntry, nextEntry]);
    if (u.includes("/athletes?") && method === "GET") return response([{
      id: NEXT_ATHLETE, coach_id: COACH, name: "Next waiter", user_id: NEXT_ATHLETE, parent_email: null,
    }]);
    if (u.endsWith("/booking_invites") && method === "POST") {
      posts.push(["invite", body]);
      return response([{ token: NEXT_TOKEN, ...body }], 201);
    }
    if (u.endsWith("/waitlist_offers") && method === "POST") {
      posts.push(["offer", body]);
      return response([{ id: NEXT_OFFER, notified_at: null, ...body }], 201);
    }
    throw new Error(`unexpected ${method} ${u}`);
  };

  await withFetch(fetchImpl, async () => {
    const result = await buildWaitlistHandlers({
      now: () => new Date(NOW), randomUUID: () => NEXT_TOKEN, notify: async () => {},
    }).expireWaitlistOffers({ now: new Date(NOW), limit: 200 });
    assert.deepEqual(result, { examined: 1, expired: 1, rolled: 1 });
  });

  assert.deepEqual(writes.slice(0, 3).map(([table, , body]) => [table, body]), [
    ["offer", { status: "expired" }],
    ["invite", { status: "expired" }],
    ["entry", { status: "waiting", offer_expires_at: null }],
  ]);
  assert.deepEqual(posts, [
    ["invite", { token: NEXT_TOKEN, coach_id: COACH, athlete_id: NEXT_ATHLETE, slot_id: SLOT, email: null, status: "pending", expires_at: nextExpiry }],
    ["offer", { coach_id: COACH, entry_id: NEXT_ENTRY, slot_id: SLOT, fill_round: 7, booking_invite_token: NEXT_TOKEN, status: "pending", expires_at: nextExpiry }],
  ]);
  assert.equal(nextEntry.status, "offered");
  assert.equal(nextEntry.offer_expires_at, nextExpiry);
  assert.equal(oldEntry.status, "waiting");
  assert.equal(oldEntry.offer_expires_at, null);
});

test("§12 PROTECTION on / WAITLIST off and waitlist-null matrix books and cancels without waitlist I/O", async () => {
  const probeEnv = { ...process.env };
  for (const key of ["SCHEDULING_ENABLED", "WAITLIST_ENABLED", "FORMS_ENABLED", "PROTECTION_ENABLED", "REMINDERS_EDITOR_ENABLED"]) {
    delete probeEnv[key];
  }
  Object.assign(probeEnv, {
    INTEGRATOR_PROBE: "1",
    SCHEDULING_ENABLED: "1",
    PROTECTION_ENABLED: "1",
    LIVEKIT_URL: "wss://test.invalid",
    LIVEKIT_API_KEY: "test-key",
    LIVEKIT_API_SECRET: "test-secret",
  });
  delete probeEnv.SUPABASE_URL;
  delete probeEnv.SUPABASE_SERVICE_KEY;
  const child = spawnSync(process.execPath, [path.join(__dirname, "waitlist-forms-integrator-off.test.js")], {
    cwd: path.resolve(__dirname, ".."), env: probeEnv, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const line = child.stdout.split(/\r?\n/).find((value) => value.startsWith("INTEGRATOR_PROBE:"));
  assert.ok(line, child.stdout);
  const wiring = JSON.parse(line.slice("INTEGRATOR_PROBE:".length));
  assert.equal(wiring.counts.protection, 1);
  assert.equal(wiring.counts.waitlist, 0);
  assert.equal(wiring.hooks.waitlistFill, false);
  assert.equal(wiring.hooks.noShowFill, false);
  assert.ok(wiring.routes.includes("POST /coach/bookings/no-show"));
  assert.ok(!wiring.routes.some((route) => route.includes("/waitlist")));

  const events = [], dbWrites = [], urls = [];
  let slot = { id: SLOT, coach_id: COACH, status: "open", booked_by: null, session_type_id: TYPE };
  let purchase = { id: OLD_PURCHASE, coach_id: COACH, credits_remaining: 2, credits_total: 4, status: "active", purchased_at: NOW };
  let deduction = null;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url), method = methodOf(init), body = bodyOf(init);
    urls.push(u);
    if (u.includes("/booking_invites?") && method === "GET") return response([{
      token: TOKEN, coach_id: COACH, athlete_id: ATHLETE,
      status: slot.status === "open" ? "pending" : "accepted", expires_at: FUTURE,
      coaches: { full_name: "Coach" }, athletes: { name: "Athlete", user_id: ATHLETE, parent_email: null },
    }]);
    if (u.includes("/bookable_slots?") && method === "GET") return response([slot]);
    if (u.includes("/bookable_slots?") && method === "PATCH") {
      slot = { ...slot, ...body };
      dbWrites.push(["slot", body]);
      return response([{ ...slot, starts_at: FUTURE, ends_at: FUTURE, timezone: "UTC", title: "Protected session" }]);
    }
    if (u.includes("/package_purchases?") && method === "GET") {
      if (u.includes("credits_remaining=gt.0") && purchase.credits_remaining <= 0) return response([]);
      return response([purchase]);
    }
    if (u.includes("/package_purchases?") && method === "PATCH") {
      purchase = { ...purchase, ...body };
      dbWrites.push(["purchase", body]);
      return response([purchase]);
    }
    if (u.includes("/credit_deductions?") && method === "GET") return response(deduction ? [deduction] : []);
    if (u.endsWith("/credit_deductions") && method === "POST") {
      deduction = body.action === "deduct" ? { purchase_id: body.purchase_id, coach_id: body.coach_id } : deduction;
      dbWrites.push(["ledger", body]);
      return response([]);
    }
    if (u.includes("/coaches?") && method === "GET") return response([{ low_balance_notify: false, low_balance_threshold: 0 }]);
    if (u.endsWith("/sessions") && method === "POST") return response([{ id: "session" }]);
    if (u.includes("/session_types?") && method === "GET") return response([{ id: TYPE }]);
    return response([]);
  };

  await withFetch(fetchImpl, async () => {
    const handlers = buildSchedulingHandlers({
      bookingGate: async () => { events.push("protection-booking-gate"); return { allowed: true }; },
      cancellationFee: async () => events.push("protection-cancel-fee"),
      waitlistFill: null,
      notify: async () => {},
    });
    let out = res();
    await handlers.bookSlot(inviteRequest(), out);
    assert.equal(out.statusCode, 200);
    assert.equal(slot.status, "booked");
    assert.equal(purchase.credits_remaining, 1);

    out = res();
    await handlers.cancelBooking(inviteRequest(), out);
    assert.equal(out.statusCode, 200);
    assert.equal(slot.status, "open");
    assert.equal(purchase.credits_remaining, 2);
  });

  assert.deepEqual(events, ["protection-booking-gate", "protection-cancel-fee"]);
  assert.deepEqual(dbWrites.map(([table, body]) => [table, body.action || body.status]), [
    ["slot", "booked"], ["purchase", "active"], ["ledger", "deduct"],
    ["slot", undefined],
    ["slot", "open"], ["purchase", "active"], ["ledger", "refund"],
  ]);
  assert.deepEqual(dbWrites[3], ["slot", { session_id: "session" }]);
  assert.ok(!urls.some((url) => /waitlist_entries|waitlist_offers/.test(url)), "null waitlist seam performs no waitlist reads or writes");
});
