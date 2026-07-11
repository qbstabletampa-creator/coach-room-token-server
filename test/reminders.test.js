// Reminder-cron unit tests. Tests lib/reminders.js DIRECTLY (no index.js — the
// PM wires GET /cron/reminders registration after this lands). The handler talks
// to Supabase over global.fetch, so we mock fetch with a STATEFUL notification_log
// store to prove dedup across two consecutive sweeps, and pass a stub notify() so
// we can count fan-outs and force a failure. Each test FILE runs in its own
// process under `node --test`, so this env is isolated.

const test = require("node:test");
const assert = require("node:assert");

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
process.env.CRON_SECRET = "test-cron-secret";

const {
  buildRemindersHandler,
  windowForSlot,
  REMINDER_WINDOWS,
} = require("../lib/reminders.js");

const COACH_ID = "33333333-3333-4333-8333-333333333333";
const ATHLETE_USER = "44444444-4444-4444-8444-444444444444";
const SLOT_A = "22222222-2222-4222-8222-222222222222";
const SLOT_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// ---- tiny req/res doubles --------------------------------------------------
function makeReq(headers = {}) {
  const lower = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  return { headers: lower, get: (h) => lower[String(h).toLowerCase()] };
}
function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(o) {
      this.body = o;
      return this;
    },
  };
}

// ---- fetch mock: serves the crafted slot rows + a live notification_log store
// so a second sweep sees the first sweep's log rows (real dedup proof). --------
function qparam(u, name) {
  const m = u.match(new RegExp(`[?&]${name}=eq\\.([^&]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function ok(json) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}
function installMock({ slots }) {
  const real = global.fetch;
  const log = []; // notification_log rows, persists across sweeps in one test
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const m = (opts.method || "GET").toUpperCase();
    if (u.includes("/bookable_slots") && m === "GET") return ok(slots);
    if (u.includes("/notification_log") && m === "GET") {
      const uid = qparam(u, "user_id");
      const type = qparam(u, "type");
      const ref = qparam(u, "reference_id");
      const hit = log.find(
        (r) => r.user_id === uid && r.type === type && r.reference_id === ref,
      );
      return ok(hit ? [{ id: "log-1" }] : []);
    }
    if (u.includes("/notification_log") && m === "POST") {
      const body = JSON.parse(opts.body);
      log.push(body);
      return { ok: true, status: 201, json: async () => [body], text: async () => "" };
    }
    return ok([]);
  };
  return {
    log,
    restore() {
      global.fetch = real;
    },
  };
}

// A booked slot whose start is `deltaMs` from now, with the coach + a claimed
// athlete pinned on it (booked_by embedded as `athlete`).
function slotAt(id, deltaMs, { athleteUser = ATHLETE_USER } = {}) {
  const starts = new Date(Date.now() + deltaMs);
  return {
    id,
    coach_id: COACH_ID,
    booked_by: "athlete-row-id",
    starts_at: starts.toISOString(),
    ends_at: new Date(starts.getTime() + 60 * 60 * 1000).toISOString(),
    timezone: "America/New_York",
    title: "Live coaching session",
    session_id: null,
    athlete: athleteUser
      ? { user_id: athleteUser, name: "Athlete A", parent_email: "parent@x.com" }
      : { user_id: null, name: "Athlete A", parent_email: "parent@x.com" },
  };
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// ===========================================================================
// 1. AUTH — the cron secret gate
// ===========================================================================

test("401 when no x-cron-secret header is sent", async () => {
  let notifyCalls = 0;
  const handler = buildRemindersHandler({ notify: async () => notifyCalls++ });
  const res = makeRes();
  await handler(makeReq({}), res);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(notifyCalls, 0, "nothing is done on a rejected call");
});

test("401 when the x-cron-secret header is wrong", async () => {
  const handler = buildRemindersHandler({ notify: async () => {} });
  const res = makeRes();
  await handler(makeReq({ "x-cron-secret": "nope" }), res);
  assert.strictEqual(res.statusCode, 401);
});

test("401 even with a matching header when CRON_SECRET is unset (fail closed)", async () => {
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    const handler = buildRemindersHandler({ notify: async () => {} });
    const res = makeRes();
    // Send the value the secret used to be — must still 401 because it is unset.
    await handler(makeReq({ "x-cron-secret": saved }), res);
    assert.strictEqual(res.statusCode, 401, "unset secret is never client-callable");
  } finally {
    process.env.CRON_SECRET = saved;
  }
});

// ===========================================================================
// 2. Window selection math (pure helper: inside/outside both windows)
// ===========================================================================

test("windowForSlot classifies inside/outside both reminder windows", () => {
  const now = 1_000_000_000_000;
  const w24 = REMINDER_WINDOWS.find((w) => w.key === "24h");
  const w30 = REMINDER_WINDOWS.find((w) => w.key === "30m");

  // Dead-center of each band.
  assert.strictEqual(windowForSlot(now + 24 * HOUR, now), w24, "24h center -> 24h");
  assert.strictEqual(windowForSlot(now + 30 * MIN, now), w30, "30m center -> 30m");

  // Just inside each band edge (band is 30 min wide, +/-15 min).
  assert.strictEqual(windowForSlot(now + 24 * HOUR + 14 * MIN, now), w24, "inside 24h upper");
  assert.strictEqual(windowForSlot(now + 30 * MIN - 14 * MIN, now), w30, "inside 30m lower");

  // Outside both: between the bands, past the far edge, and already started.
  assert.strictEqual(windowForSlot(now + 3 * HOUR, now), null, "3h is between windows");
  assert.strictEqual(windowForSlot(now + 25 * HOUR, now), null, "25h is past the 24h band");
  assert.strictEqual(windowForSlot(now + 5 * MIN, now), null, "5m is inside neither band");
  assert.strictEqual(windowForSlot(now - 10 * MIN, now), null, "already started -> null");
});

// ===========================================================================
// 3. Dedup — no double-send across two consecutive sweeps (MANDATORY)
// ===========================================================================

test("two consecutive sweeps send once each, never twice, for the same slot+window", async () => {
  const notifyCalls = [];
  const handler = buildRemindersHandler({
    notify: async (args) => {
      notifyCalls.push(args);
    },
  });
  // One booked slot 30 min out: coach + claimed athlete = two recipients.
  const mock = installMock({ slots: [slotAt(SLOT_A, 30 * MIN)] });
  try {
    // Sweep 1: both recipients are fresh -> two sends, two log rows.
    const res1 = makeRes();
    await handler(makeReq({ "x-cron-secret": "test-cron-secret" }), res1);
    assert.strictEqual(res1.statusCode, 200);
    assert.deepStrictEqual(res1.body, { scanned: 1, sent: 2 });
    assert.strictEqual(notifyCalls.length, 2, "first sweep fires both recipients");
    assert.strictEqual(mock.log.length, 2, "two notification_log rows recorded");
    // Both fired against the 30m key, one to the coach, one to the athlete user.
    assert.ok(notifyCalls.every((c) => c.type === "session.reminder.30m"));
    assert.ok(notifyCalls.some((c) => c.userId === COACH_ID));
    assert.ok(notifyCalls.some((c) => c.userId === ATHLETE_USER));
    assert.ok(notifyCalls.every((c) => c.dedupeKey === SLOT_A));

    // Sweep 2: the log now has both rows -> zero new sends.
    const res2 = makeRes();
    await handler(makeReq({ "x-cron-secret": "test-cron-secret" }), res2);
    assert.strictEqual(res2.statusCode, 200);
    assert.deepStrictEqual(res2.body, { scanned: 1, sent: 0 }, "no double-send on the second sweep");
    assert.strictEqual(notifyCalls.length, 2, "notify was not called again");
    assert.strictEqual(mock.log.length, 2, "no extra log rows on the second sweep");
  } finally {
    mock.restore();
  }
});

// ===========================================================================
// 4. A single failing notify() does not stop the sweep
// ===========================================================================

test("one failing notify() is skipped; the sweep finishes the rest", async () => {
  const attempts = [];
  let first = true;
  const handler = buildRemindersHandler({
    notify: async (args) => {
      attempts.push(args);
      if (first) {
        first = false;
        throw new Error("simulated push/email blowup");
      }
    },
  });
  // Two 30m slots, each coach + athlete = four recipients. The first notify
  // (slot A, coach) throws; the other three must still fire.
  const mock = installMock({ slots: [slotAt(SLOT_A, 30 * MIN), slotAt(SLOT_B, 30 * MIN)] });
  try {
    const res = makeRes();
    await handler(makeReq({ "x-cron-secret": "test-cron-secret" }), res);
    assert.strictEqual(res.statusCode, 200, "a notify failure never 500s the response");
    assert.strictEqual(res.body.scanned, 2);
    assert.strictEqual(res.body.sent, 3, "three of four recipients delivered");
    assert.strictEqual(attempts.length, 4, "all four recipients were attempted");
    // The failed send left NO log row, so it can retry next sweep.
    assert.strictEqual(mock.log.length, 3, "only the successful sends are logged");
  } finally {
    mock.restore();
  }
});

// ===========================================================================
// 5. { scanned, sent } counts — a slot outside every window is scanned, not sent
// ===========================================================================

test("scanned counts every booked slot examined; sent counts only in-window fan-outs", async () => {
  const notifyCalls = [];
  const handler = buildRemindersHandler({
    notify: async (args) => notifyCalls.push(args),
  });
  // Slot A is in the 30m window (2 recipients); slot B is 3h out — scanned but
  // matches no window, so it produces zero sends.
  const mock = installMock({
    slots: [slotAt(SLOT_A, 30 * MIN), slotAt(SLOT_B, 3 * HOUR)],
  });
  try {
    const res = makeRes();
    await handler(makeReq({ "x-cron-secret": "test-cron-secret" }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { scanned: 2, sent: 2 });
    assert.ok(
      notifyCalls.every((c) => c.data.slotId === SLOT_A),
      "only the in-window slot fanned out",
    );
  } finally {
    mock.restore();
  }
});

// ===========================================================================
// 6. An unclaimed athlete (no auth user) only reminds the coach
// ===========================================================================

test("an unclaimed athlete yields only the coach recipient", async () => {
  const notifyCalls = [];
  const handler = buildRemindersHandler({
    notify: async (args) => notifyCalls.push(args),
  });
  const mock = installMock({
    slots: [slotAt(SLOT_A, 24 * HOUR, { athleteUser: null })],
  });
  try {
    const res = makeRes();
    await handler(makeReq({ "x-cron-secret": "test-cron-secret" }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { scanned: 1, sent: 1 }, "coach only");
    assert.strictEqual(notifyCalls.length, 1);
    assert.strictEqual(notifyCalls[0].userId, COACH_ID);
    assert.strictEqual(notifyCalls[0].type, "session.reminder.24h");
  } finally {
    mock.restore();
  }
});
