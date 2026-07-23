// avail-ux / server-slots tests: the days/weeks horizon contract, auto-generate
// window CRUD (overlap rejection + stale-slot cleanup), blackout dates (skip in
// expandWindows + close-open-in-range + reopen), multi-window-per-day + overlap
// duplication, and the rolling-horizon cron.
//
// Same harness style as scheduling-endpoints.test.js / api-rest.test.js: no
// network, no live creds; global.fetch is mocked to stand in for Supabase
// PostgREST. Each test FILE runs in its own process under `node --test`, so the
// env set here (both SCHEDULING and API surfaces enabled) is isolated.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
process.env.ROOM_TICKET_SECRET = "test-ticket-secret";
process.env.SCHEDULING_ENABLED = "1";
process.env.API_ENABLED = "1";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.RESEND_API_KEY;
delete process.env.CRON_SECRET;

const { app } = require("../index.js");
const {
  expandWindows,
  resolveHorizonDays,
  blackoutUtcBounds,
  timesOverlap,
} = require("../lib/scheduling.js");

// ---- tiny in-process HTTP harness ------------------------------------------
function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body);
    const h = { ...headers };
    if (payload && !h["content-type"]) h["content-type"] = "application/json";
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: h },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            json: (() => {
              try {
                return JSON.parse(data);
              } catch {
                return null;
              }
            })(),
            text: data,
          }),
        );
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function installFetchMock(routes) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ u, method, body: opts.body ? JSON.parse(opts.body) : null });
    for (const r of routes) {
      if (r.test(u, method)) return r.reply(u, method, opts);
    }
    return { ok: true, status: 200, json: async () => [], text: async () => "" };
  };
  return {
    calls,
    restore() {
      global.fetch = realFetch;
    },
  };
}

function ok(json) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

const COACH_ID = "33333333-3333-4333-8333-333333333333";
const KEY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VALID_KEY = "ctk_" + "a".repeat(64);
const WINDOW_ID = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
const BLACKOUT_ID = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb";
const SLOT_A = "cccccccc-3333-4ccc-8ccc-cccccccccccc";
const SLOT_B = "dddddddd-4444-4ddd-8ddd-dddddddddddd";
const BOOKED_SLOT = "eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee";

const coachAuthRoute = {
  test: (u) => u.includes("/auth/v1/user"),
  reply: () => ok({ id: COACH_ID, user_metadata: { role: "coach" } }),
};
const liveKeyRoute = {
  test: (u, m) => u.includes("/api_keys") && u.includes("key_hash=eq.") && m === "GET",
  reply: () => ok([{ id: KEY_ID, coach_id: COACH_ID, rate_limit: 600, scopes: [] }]),
};
// A window on EVERY weekday, so a horizon of N days yields ~N distinct dates.
function everyWeekdayWindows() {
  return [0, 1, 2, 3, 4, 5, 6].map((dow, i) => ({
    id: `${i}0000000-0000-4000-8000-000000000000`,
    coach_id: COACH_ID,
    day_of_week: dow,
    start_time: "12:00:00",
    end_time: "13:00:00",
    timezone: "UTC",
    slot_minutes: 60,
  }));
}
// Collect every bookable_slots row the handler inserted across POST batches.
function insertedSlots(calls) {
  const rows = [];
  for (const c of calls) {
    if (c.u.includes("/bookable_slots") && c.method === "POST" && Array.isArray(c.body)) {
      rows.push(...c.body);
    }
  }
  return rows;
}
function distinctDates(rows) {
  return new Set(rows.map((r) => String(r.starts_at).slice(0, 10))).size;
}

// ===========================================================================
// PART A — pure horizon contract (resolveHorizonDays + expandWindows days)
// ===========================================================================

test("resolveHorizonDays: days is primary, weeks is legacy fallback, else 28", () => {
  assert.strictEqual(resolveHorizonDays({ days: 14 }), 14, "days wins");
  assert.strictEqual(resolveHorizonDays({ days: 14, weeks: 4 }), 14, "days beats weeks");
  assert.strictEqual(resolveHorizonDays({ weeks: 4 }), 28, "weeks*7 when no days");
  assert.strictEqual(resolveHorizonDays({ weeks: 2 }), 14, "weeks*7");
  assert.strictEqual(resolveHorizonDays({}), 28, "default horizon");
  assert.strictEqual(resolveHorizonDays({ days: 0 }), 28, "days out of range -> fallback");
  assert.strictEqual(resolveHorizonDays({ days: 999 }), 28, "days above cap -> fallback");
  assert.strictEqual(resolveHorizonDays({ days: 84 }), 84, "84 is the cap and honored");
});

test("expandWindows honors days=14 as a 14-day horizon (not the legacy weeks default)", () => {
  const now = new Date("2026-07-13T00:00:00.000Z"); // Monday
  const win = [{
    id: WINDOW_ID, coach_id: COACH_ID, day_of_week: 1, // Monday
    start_time: "15:00:00", end_time: "16:00:00", timezone: "UTC", slot_minutes: 60,
  }];
  // 14 days from Monday 07-13 covers Mondays 07-13 and 07-20 -> exactly 2.
  const got14 = expandWindows({ windows: win, days: 14, now, coachId: COACH_ID });
  assert.strictEqual(got14.rows.length, 2, "days=14 spans two Mondays");
  // The legacy weeks default (28) would span four Mondays; prove days!=weeks.
  const got28 = expandWindows({ windows: win, days: 28, now, coachId: COACH_ID });
  assert.strictEqual(got28.rows.length, 4, "days=28 spans four Mondays");
  // 7 days spans one Monday.
  const got7 = expandWindows({ windows: win, days: 7, now, coachId: COACH_ID });
  assert.strictEqual(got7.rows.length, 1, "days=7 spans one Monday");
});

test("expandWindows: legacy weeks still works when days is absent (back-compat)", () => {
  const now = new Date("2026-07-13T00:00:00.000Z");
  const win = [{
    id: WINDOW_ID, coach_id: COACH_ID, day_of_week: 1,
    start_time: "15:00:00", end_time: "16:00:00", timezone: "UTC", slot_minutes: 60,
  }];
  const gotWeeks2 = expandWindows({ windows: win, weeks: 2, now, coachId: COACH_ID });
  assert.strictEqual(gotWeeks2.rows.length, 2, "weeks:2 -> 14-day horizon -> two Mondays");
});

// ===========================================================================
// PART B — blackout skip in expandWindows (MUTATION TARGET #3)
// ===========================================================================

test("expandWindows skips slots on blacked-out calendar dates", () => {
  const now = new Date("2026-07-13T00:00:00.000Z"); // Monday
  const win = [{
    id: WINDOW_ID, coach_id: COACH_ID, day_of_week: 1,
    start_time: "15:00:00", end_time: "16:00:00", timezone: "UTC", slot_minutes: 60,
  }];
  // Baseline: two Mondays (07-13, 07-20).
  const base = expandWindows({ windows: win, days: 14, now, coachId: COACH_ID });
  assert.strictEqual(base.rows.length, 2, "baseline two Mondays");

  // Black out 07-20 -> only 07-13 survives.
  const withBlackout = expandWindows({
    windows: win, days: 14, now, coachId: COACH_ID,
    blackoutRanges: [{ start: "2026-07-20", end: "2026-07-20" }],
  });
  assert.strictEqual(withBlackout.rows.length, 1, "the blacked-out Monday generates no slot");
  assert.strictEqual(
    String(withBlackout.rows[0].starts_at).slice(0, 10),
    "2026-07-13",
    "only the non-blacked-out Monday remains",
  );

  // A multi-day range blacks out both -> zero slots.
  const both = expandWindows({
    windows: win, days: 14, now, coachId: COACH_ID,
    blackoutRanges: [{ start: "2026-07-13", end: "2026-07-20" }],
  });
  assert.strictEqual(both.rows.length, 0, "a range covering both Mondays generates nothing");
});

// ===========================================================================
// PART C — multi-window-per-day + overlap duplication (piece 4)
// ===========================================================================

test("expandWindows handles two NON-overlapping windows on the same day", () => {
  const now = new Date("2026-07-13T00:00:00.000Z");
  const windows = [
    { id: "morning0-0000-4000-8000-000000000000", coach_id: COACH_ID, day_of_week: 1,
      start_time: "09:00:00", end_time: "10:00:00", timezone: "UTC", slot_minutes: 60 },
    { id: "evening0-0000-4000-8000-000000000000", coach_id: COACH_ID, day_of_week: 1,
      start_time: "18:00:00", end_time: "19:00:00", timezone: "UTC", slot_minutes: 60 },
  ];
  const { rows } = expandWindows({ windows, days: 7, now, coachId: COACH_ID });
  // One Monday in 7 days, two distinct windows -> two slots at distinct times.
  assert.strictEqual(rows.length, 2, "both same-day windows expand");
  const starts = rows.map((r) => new Date(r.starts_at).getUTCHours()).sort((a, b) => a - b);
  assert.deepStrictEqual(starts, [9, 18], "9am and 6pm slots, no collision");
});

test("expandWindows OVERLAP: two overlapping windows mint duplicate wall-clock slots (the (window_id,starts_at) index is per-window and cannot dedupe them)", () => {
  const now = new Date("2026-07-13T00:00:00.000Z");
  const windows = [
    { id: "aaaa1111-0000-4000-8000-000000000000", coach_id: COACH_ID, day_of_week: 1,
      start_time: "15:00:00", end_time: "17:00:00", timezone: "UTC", slot_minutes: 60 },
    { id: "bbbb2222-0000-4000-8000-000000000000", coach_id: COACH_ID, day_of_week: 1,
      start_time: "16:00:00", end_time: "18:00:00", timezone: "UTC", slot_minutes: 60 },
  ];
  const { rows } = expandWindows({ windows, days: 7, now, coachId: COACH_ID });
  // At 16:00Z on the Monday BOTH windows produce a [16:00,17:00) slot under
  // different window_id keys -> a duplicate wall-clock start the per-window
  // unique index (window_id, starts_at) does NOT catch. This is exactly why the
  // window CRUD rejects overlaps rather than relying on the DB index.
  const at16 = rows.filter((r) => new Date(r.starts_at).getUTCHours() === 16);
  assert.strictEqual(at16.length, 2, "two rows share the 16:00 wall-clock start");
  assert.notStrictEqual(at16[0].window_id, at16[1].window_id, "under different window_id keys");
  assert.strictEqual(at16[0].starts_at, at16[1].starts_at, "identical starts_at instant");
});

test("timesOverlap: half-open, touching edges do not overlap", () => {
  assert.strictEqual(timesOverlap("15:00:00", "17:00:00", "16:00:00", "18:00:00"), true);
  assert.strictEqual(timesOverlap("15:00:00", "16:00:00", "16:00:00", "17:00:00"), false, "edge touch");
  assert.strictEqual(timesOverlap("09:00:00", "10:00:00", "18:00:00", "19:00:00"), false, "disjoint");
});

// ===========================================================================
// PART D — days contract on BOTH server route lanes (MUTATION TARGET #1)
// ===========================================================================

test("scheduling lane: POST /coach/slots/generate {days:14} yields a 14-day horizon", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    coachAuthRoute,
    { test: (u, m) => u.includes("/availability_windows") && m === "GET",
      reply: () => ok(everyWeekdayWindows()) },
    { test: (u, m) => u.includes("/bookable_slots") && u.includes("window_id=not.is.null") && m === "GET",
      reply: () => ok([]) },
    { test: (u, m) => u.includes("/blackout_dates") && m === "GET", reply: () => ok([]) },
    { test: (u, m) => u.includes("/bookable_slots") && m === "POST",
      reply: (u, m, opts) => ok(JSON.parse(opts.body)) },
  ]);
  try {
    const res = await request(port, {
      method: "POST", path: "/coach/slots/generate",
      headers: { authorization: "Bearer coach-jwt" },
      body: JSON.stringify({ days: 14 }),
    });
    assert.strictEqual(res.status, 200);
    const rows = insertedSlots(mock.calls);
    const dd = distinctDates(rows);
    assert.ok(dd >= 13 && dd <= 14, `14-day horizon spans ~14 distinct dates, got ${dd}`);
    // A weeks-default (28) horizon would span ~28 distinct dates.
    assert.ok(dd < 20, `not the legacy 28-day default, got ${dd}`);
  } finally {
    mock.restore();
    server.close();
  }
});

test("open-API lane: POST /api/v1/slots/generate {days:14} yields a 14-day horizon", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    liveKeyRoute,
    { test: (u, m) => u.includes("/availability_windows") && m === "GET",
      reply: () => ok(everyWeekdayWindows()) },
    { test: (u, m) => u.includes("/bookable_slots") && u.includes("window_id=not.is.null") && m === "GET",
      reply: () => ok([]) },
    { test: (u, m) => u.includes("/blackout_dates") && m === "GET", reply: () => ok([]) },
    { test: (u, m) => u.includes("/bookable_slots") && m === "POST",
      reply: (u, m, opts) => ok(JSON.parse(opts.body)) },
  ]);
  try {
    const res = await request(port, {
      method: "POST", path: "/api/v1/slots/generate",
      headers: { authorization: `Bearer ${VALID_KEY}` },
      body: JSON.stringify({ days: 14 }),
    });
    assert.strictEqual(res.status, 200);
    const rows = insertedSlots(mock.calls);
    const dd = distinctDates(rows);
    assert.ok(dd >= 13 && dd <= 14, `open-API 14-day horizon spans ~14 dates, got ${dd}`);
    assert.ok(dd < 20, `open-API lane is not the legacy 28-day default, got ${dd}`);
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// PART E — window CRUD: overlap rejection + stale-slot cleanup
// ===========================================================================

test("POST /coach/availability-windows rejects a window overlapping an active same-day window (409)", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    coachAuthRoute,
    { // overlap probe: an existing active window on the same day that overlaps.
      test: (u, m) => u.includes("/availability_windows") && u.includes("day_of_week=eq.1") && m === "GET",
      reply: () => ok([{ id: WINDOW_ID, day_of_week: 1, start_time: "16:00:00", end_time: "18:00:00" }]) },
  ]);
  try {
    const res = await request(port, {
      method: "POST", path: "/coach/availability-windows",
      headers: { authorization: "Bearer coach-jwt" },
      body: JSON.stringify({ day_of_week: 1, start_time: "17:00", end_time: "19:00", timezone: "UTC" }),
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.json.error, "window_overlap");
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/availability_windows") && c.method === "POST"),
      "no window is inserted when it overlaps",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

test("POST /coach/availability-windows creates a non-overlapping window and regenerates slots", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    coachAuthRoute,
    { test: (u, m) => u.includes("/availability_windows") && u.includes("day_of_week=eq.1") && m === "GET",
      reply: () => ok([]) }, // no clash
    { test: (u, m) => u.includes("/availability_windows") && m === "POST",
      reply: (u, m, opts) => ok([{ id: WINDOW_ID, ...JSON.parse(opts.body) }]) },
    { test: (u, m) => u.includes("/availability_windows") && m === "GET",
      reply: () => ok([{ id: WINDOW_ID, coach_id: COACH_ID, day_of_week: 1,
        start_time: "17:00:00", end_time: "18:00:00", timezone: "UTC", slot_minutes: 60 }]) },
    { test: (u, m) => u.includes("/bookable_slots") && u.includes("window_id=not.is.null") && m === "GET",
      reply: () => ok([]) },
    { test: (u, m) => u.includes("/blackout_dates") && m === "GET", reply: () => ok([]) },
    { test: (u, m) => u.includes("/bookable_slots") && m === "POST",
      reply: (u, m, opts) => ok(JSON.parse(opts.body)) },
  ]);
  try {
    const res = await request(port, {
      method: "POST", path: "/coach/availability-windows",
      headers: { authorization: "Bearer coach-jwt" },
      body: JSON.stringify({ day_of_week: 1, start_time: "17:00", end_time: "18:00", timezone: "UTC", days: 14 }),
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.json.window.id, WINDOW_ID);
    assert.ok(res.json.generated.created >= 1, "slots were generated for the new window");
    // The insert normalized HH:MM -> HH:MM:SS.
    const ins = mock.calls.find((c) => c.u.includes("/availability_windows") && c.method === "POST");
    assert.strictEqual(ins.body.start_time, "17:00:00");
    assert.strictEqual(ins.body.coach_id, COACH_ID);
  } finally {
    mock.restore();
    server.close();
  }
});

test("PATCH /coach/availability-windows/:id prunes ONLY open slots (never booked / calendar rows) then regenerates (MUTATION TARGET #2)", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    coachAuthRoute,
    { // current row read (tenant).
      test: (u, m) => u.includes("/availability_windows") && u.includes(`id=eq.${WINDOW_ID}`) && m === "GET",
      reply: () => ok([{ id: WINDOW_ID, coach_id: COACH_ID, day_of_week: 1,
        start_time: "15:00:00", end_time: "16:00:00", timezone: "UTC", slot_minutes: 60, active: true }]) },
    { // overlap probe -> none.
      test: (u, m) => u.includes("/availability_windows") && u.includes("day_of_week=eq.1") && m === "GET",
      reply: () => ok([]) },
    { test: (u, m) => u.includes("/availability_windows") && m === "PATCH",
      reply: (u, m, opts) => ok([{ id: WINDOW_ID, coach_id: COACH_ID, ...JSON.parse(opts.body) }]) },
    { // prune DELETE returns the pruned open rows.
      test: (u, m) => u.includes("/bookable_slots") && m === "DELETE",
      reply: () => ok([{ id: SLOT_A }, { id: SLOT_B }]) },
    { test: (u, m) => u.includes("/availability_windows") && m === "GET",
      reply: () => ok([{ id: WINDOW_ID, coach_id: COACH_ID, day_of_week: 1,
        start_time: "17:00:00", end_time: "18:00:00", timezone: "UTC", slot_minutes: 60 }]) },
    { test: (u, m) => u.includes("/bookable_slots") && u.includes("window_id=not.is.null") && m === "GET",
      reply: () => ok([]) },
    { test: (u, m) => u.includes("/blackout_dates") && m === "GET", reply: () => ok([]) },
    { test: (u, m) => u.includes("/bookable_slots") && m === "POST",
      reply: (u, m, opts) => ok(JSON.parse(opts.body)) },
  ]);
  try {
    const res = await request(port, {
      method: "PATCH", path: `/coach/availability-windows/${WINDOW_ID}`,
      headers: { authorization: "Bearer coach-jwt" },
      body: JSON.stringify({ start_time: "17:00", end_time: "18:00", days: 14 }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.pruned_open, 2, "two stale open slots pruned");

    const del = mock.calls.find((c) => c.u.includes("/bookable_slots") && c.method === "DELETE");
    assert.ok(del, "a prune DELETE fired");
    // The cleanup targets ONLY open, non-calendar-blocked rows for this window.
    assert.ok(del.u.includes("status=eq.open"), "prune is scoped to status=open");
    assert.ok(del.u.includes("calendar_blocked=eq.false"), "prune never touches calendar-blocked rows");
    assert.ok(del.u.includes(`window_id=eq.${WINDOW_ID}`), "prune is scoped to this window");
    assert.ok(!del.u.includes("status=eq.booked"), "prune never targets booked rows");
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// PART F — blackout CRUD: close-open-in-range, conflicts, reopen
// ===========================================================================

test("POST /coach/blackouts closes OPEN slots in range (calendar_blocked stays false) and returns booked slots as conflicts", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    coachAuthRoute,
    { test: (u, m) => u.includes("/blackout_dates") && m === "POST",
      reply: (u, m, opts) => ok([{ id: BLACKOUT_ID, ...JSON.parse(opts.body) }]) },
    { // booked-in-range read -> one conflict.
      test: (u, m) => u.includes("/bookable_slots") && u.includes("status=eq.booked") && m === "GET",
      reply: () => ok([{ id: BOOKED_SLOT, starts_at: "2026-12-25T15:00:00Z", booked_by: "x" }]) },
    { // close OPEN slots -> two closed.
      test: (u, m) => u.includes("/bookable_slots") && u.includes("status=eq.open") && m === "PATCH",
      reply: () => ok([{ id: SLOT_A }, { id: SLOT_B }]) },
  ]);
  try {
    const res = await request(port, {
      method: "POST", path: "/coach/blackouts",
      headers: { authorization: "Bearer coach-jwt" },
      body: JSON.stringify({ start_date: "2026-12-24", end_date: "2026-12-26", timezone: "America/New_York", reason: "holiday" }),
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.json.closed_open_count, 2, "two open slots closed");
    assert.strictEqual(res.json.conflicts.length, 1, "the booked slot is surfaced, not cancelled");
    assert.strictEqual(res.json.conflicts[0].id, BOOKED_SLOT);

    const close = mock.calls.find(
      (c) => c.u.includes("/bookable_slots") && c.u.includes("status=eq.open") && c.method === "PATCH",
    );
    assert.ok(close, "an open-slot close PATCH fired");
    assert.strictEqual(close.body.status, "cancelled", "open slots become cancelled");
    assert.strictEqual(close.body.blackout_id, BLACKOUT_ID, "stamped with blackout provenance");
    // TRAP: the close must NOT set calendar_blocked=true, or the 15-min calendar
    // sweep + disconnect RPC would reopen the blackout. Provenance != calendar.
    assert.notStrictEqual(close.body.calendar_blocked, true, "calendar_blocked is never set true by a blackout");
    // The close filter is scoped to open, non-calendar-blocked rows only.
    assert.ok(close.u.includes("calendar_blocked=eq.false"), "close leaves calendar-owned rows alone");

    // The booked slot was never PATCHed (no auto-cancel of a paid session).
    assert.ok(
      !mock.calls.some((c) => c.u.includes(`id=eq.${BOOKED_SLOT}`) && c.method === "PATCH"),
      "booked sessions are never auto-cancelled by a blackout",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

test("DELETE /coach/blackouts/:id reopens exactly the slots the blackout closed, then deletes the blackout", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    coachAuthRoute,
    { test: (u, m) => u.includes("/blackout_dates") && u.includes(`id=eq.${BLACKOUT_ID}`) && m === "GET",
      reply: () => ok([{ id: BLACKOUT_ID }]) },
    { test: (u, m) => u.includes("/bookable_slots") && u.includes(`blackout_id=eq.${BLACKOUT_ID}`) && m === "PATCH",
      reply: () => ok([{ id: SLOT_A }, { id: SLOT_B }]) },
    { test: (u, m) => u.includes("/blackout_dates") && m === "DELETE", reply: () => ok([]) },
  ]);
  try {
    const res = await request(port, {
      method: "DELETE", path: `/coach/blackouts/${BLACKOUT_ID}`,
      headers: { authorization: "Bearer coach-jwt" },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.reopened_count, 2);

    const reopen = mock.calls.find(
      (c) => c.u.includes("/bookable_slots") && c.u.includes(`blackout_id=eq.${BLACKOUT_ID}`) && c.method === "PATCH",
    );
    assert.ok(reopen, "a reopen PATCH fired scoped to this blackout's provenance");
    assert.ok(reopen.u.includes("status=eq.cancelled"), "only still-cancelled rows are reopened");
    assert.ok(
      reopen.u.includes("window_id=not.is.null"),
      "slots orphaned by a window delete are never resurrected as bookable (verifier M2)",
    );
    assert.strictEqual(reopen.body.status, "open");
    assert.strictEqual(reopen.body.blackout_id, null, "provenance cleared on reopen");
    assert.ok(
      mock.calls.some((c) => c.u.includes("/blackout_dates") && c.method === "DELETE"),
      "the blackout row is deleted",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

test("blackoutUtcBounds covers an inclusive date range through the end of end_date", () => {
  const { startUtc, endUtcExclusive } = blackoutUtcBounds({
    startDate: "2026-12-24", endDate: "2026-12-26", timezone: "America/New_York",
  });
  // 2026-12-24 00:00 EST == 05:00Z.
  assert.strictEqual(startUtc.toISOString(), "2026-12-24T05:00:00.000Z");
  // Exclusive end is 2026-12-27 00:00 EST == 05:00Z (covers all of the 26th).
  assert.strictEqual(endUtcExclusive.toISOString(), "2026-12-27T05:00:00.000Z");
});

// ===========================================================================
// PART G — rolling-horizon cron
// ===========================================================================

test("GET /cron/slots-roll without the CRON secret is 401", async () => {
  const { server, port } = await startServer();
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "roll-secret";
  const mock = installFetchMock([]);
  try {
    const res = await request(port, { method: "GET", path: "/cron/slots-roll" });
    assert.strictEqual(res.status, 401);
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/availability_windows")),
      "no work runs without the secret",
    );
  } finally {
    mock.restore();
    if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
    server.close();
  }
});

test("POST /cron/slots-roll tops up every coach with active windows (idempotent, per-coach)", async () => {
  const { server, port } = await startServer();
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "roll-secret";
  const C2 = "77777777-7777-4777-8777-777777777777";
  const mock = installFetchMock([
    { // distinct-coach scan (duplicated coach rows collapse to 2 coaches).
      test: (u, m) => u.includes("/availability_windows") && u.includes("select=coach_id") && m === "GET",
      reply: () => ok([{ coach_id: COACH_ID }, { coach_id: COACH_ID }, { coach_id: C2 }]) },
    { // per-coach window read.
      test: (u, m) => u.includes("/availability_windows") && m === "GET",
      reply: () => ok([{ id: WINDOW_ID, coach_id: COACH_ID, day_of_week: 1,
        start_time: "15:00:00", end_time: "16:00:00", timezone: "UTC", slot_minutes: 60 }]) },
    { test: (u, m) => u.includes("/bookable_slots") && u.includes("window_id=not.is.null") && m === "GET",
      reply: () => ok([]) },
    { test: (u, m) => u.includes("/blackout_dates") && m === "GET", reply: () => ok([]) },
    { test: (u, m) => u.includes("/bookable_slots") && m === "POST",
      reply: (u, m, opts) => ok(JSON.parse(opts.body)) },
  ]);
  try {
    const res = await request(port, {
      method: "POST", path: "/cron/slots-roll",
      headers: { "x-cron-secret": "roll-secret" },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.coaches, 2, "two distinct coaches rolled");
    assert.ok(res.json.created >= 2, "slots topped up for both coaches");
    assert.strictEqual(res.json.failed, 0);
  } finally {
    mock.restore();
    if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
    server.close();
  }
});
