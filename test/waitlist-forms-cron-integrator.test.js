const test = require("node:test");
const assert = require("node:assert/strict");

const { buildRemindersHandler, WINDOW_WIDTH_MS } = require("../lib/reminders");
const { buildWaitlistHandlers } = require("../lib/waitlist");

const CRON_SECRET = "integrator-cron-secret";
const DB_URL = "https://integrator.test";
const COACH = "11111111-1111-4111-8111-111111111111";
const SLOT = "22222222-2222-4222-8222-222222222222";
const ENTRY = "33333333-3333-4333-8333-333333333333";
const OFFER = "44444444-4444-4444-8444-444444444444";
const INVITE = "55555555-5555-4555-8555-555555555555";
const NOW_MS = Date.parse("2026-07-17T16:00:00.000Z");

process.env.CRON_SECRET = CRON_SECRET;
process.env.SUPABASE_URL = DB_URL;
process.env.SUPABASE_SERVICE_KEY = "integrator-service-key";

function req(secret = CRON_SECRET) {
  const headers = secret == null ? {} : { "x-cron-secret": secret };
  return { headers, get: (name) => headers[String(name).toLowerCase()] };
}

function res() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(body) { this.body = body; return this; },
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
    json: async () => body,
  };
}

async function withRuntime({ nowMs = NOW_MS, fetchImpl, errorImpl }, run) {
  const savedNow = Date.now;
  const savedFetch = global.fetch;
  const savedError = console.error;
  Date.now = () => nowMs;
  global.fetch = fetchImpl;
  console.error = errorImpl || (() => {});
  try {
    return await run();
  } finally {
    Date.now = savedNow;
    global.fetch = savedFetch;
    console.error = savedError;
  }
}

test("reminder work precedes one expiry batch and both use the captured instant", async () => {
  const events = [];
  const calls = [];
  await withRuntime({
    fetchImpl: async (url) => {
      events.push("reminders");
      calls.push(String(url));
      return response([]);
    },
  }, async () => {
    const handler = buildRemindersHandler({
      notify: async () => {},
      waitlistExpire: async (args) => events.push({ expiry: args }),
    });
    const out = res();
    await handler(req(), out);
    assert.equal(out.statusCode, 200);
    assert.deepEqual(out.body, { scanned: 0, sent: 0 });
  });

  assert.equal(events[0], "reminders");
  assert.equal(events.length, 2);
  assert.equal(events[1].expiry.limit, 200);
  assert.ok(events[1].expiry.now instanceof Date);
  assert.equal(events[1].expiry.now.getTime(), NOW_MS);

  const query = new URL(calls[0]);
  const half = WINDOW_WIDTH_MS / 2;
  assert.equal(
    Date.parse(query.searchParams.get("starts_at").replace(/^gt\./, "")),
    NOW_MS + 30 * 60 * 1000 - half,
  );
});

test("null expiry seam is observationally identical to the pre-integration baseline", async () => {
  async function run(options) {
    const fetches = [];
    const logs = [];
    let out;
    await withRuntime({
      fetchImpl: async (url, init = {}) => {
        fetches.push({ url: String(url), init: JSON.parse(JSON.stringify(init)) });
        return response([]);
      },
      errorImpl: (...args) => logs.push(args),
    }, async () => {
      out = res();
      await buildRemindersHandler(options)(req(), out);
    });
    return { fetches, logs, statusCode: out.statusCode, body: out.body, headers: out.headers };
  }

  const baseline = await run({ notify: async () => {} });
  const explicitNull = await run({ notify: async () => {}, waitlistExpire: null });
  assert.deepEqual(explicitNull, baseline);
});

test("expiry resolve and rejection never change the reminder response DTO", async () => {
  for (const waitlistExpire of [
    async () => ({ examined: 2, expired: 1, rolled: 1 }),
    async () => { throw new Error("provider-secret-detail"); },
  ]) {
    const logs = [];
    await withRuntime({
      fetchImpl: async () => response([]),
      errorImpl: (...args) => logs.push(args),
    }, async () => {
      const out = res();
      await buildRemindersHandler({ notify: async () => {}, waitlistExpire })(req(), out);
      assert.deepEqual([out.statusCode, out.body], [200, { scanned: 0, sent: 0 }]);
    });
    if (logs.length) {
      assert.deepEqual(logs, [["[reminders:hook:waitlist-expiry] failed (non-fatal)"]]);
      assert.doesNotMatch(JSON.stringify(logs), /provider-secret-detail/);
    }
  }
});

test("an initial reminder failure keeps the existing 500 and never reaches expiry", async () => {
  let expiryCalls = 0;
  const logs = [];
  await withRuntime({
    fetchImpl: async () => { throw new Error("reminder database down"); },
    errorImpl: (...args) => logs.push(args),
  }, async () => {
    const out = res();
    await buildRemindersHandler({
      notify: async () => {},
      waitlistExpire: async () => { expiryCalls++; },
    })(req(), out);
    assert.deepEqual([out.statusCode, out.body], [500, { error: "reminder sweep failed" }]);
  });
  assert.equal(expiryCalls, 0);
  assert.equal(logs[0][0], "[reminders] sweep failed:");
});

test("missing or wrong cron secret returns the exact 401 without expiry work", async () => {
  let expiryCalls = 0;
  const handler = buildRemindersHandler({
    notify: async () => {},
    waitlistExpire: async () => { expiryCalls++; },
  });
  for (const request of [req(null), req("wrong")]) {
    const out = res();
    await handler(request, out);
    assert.deepEqual([out.statusCode, out.body], [401, { error: "unauthorized" }]);
  }
  assert.equal(expiryCalls, 0);
});

test("missing Supabase config keeps the exact empty 200 and skips expiry", async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;
  let expiryCalls = 0;
  try {
    const out = res();
    await buildRemindersHandler({
      notify: async () => {},
      waitlistExpire: async () => { expiryCalls++; },
    })(req(), out);
    assert.deepEqual([out.statusCode, out.body], [200, { scanned: 0, sent: 0 }]);
    assert.equal(expiryCalls, 0);
  } finally {
    process.env.SUPABASE_URL = savedUrl;
    process.env.SUPABASE_SERVICE_KEY = savedKey;
  }
});

test("overlapping real expiry primitives terminalize and restore one offer once", async () => {
  const expiresAt = "2026-07-17T15:59:00.000Z";
  const offer = {
    id: OFFER,
    coach_id: COACH,
    entry_id: ENTRY,
    slot_id: SLOT,
    fill_round: 7,
    booking_invite_token: INVITE,
    status: "notified",
    expires_at: expiresAt,
  };
  const state = { offerStatus: "notified", entryStatus: "offered", inviteStatus: "pending" };
  const writes = { offer: 0, entry: 0, invite: 0 };

  function method(init) { return String(init.method || "GET").toUpperCase(); }
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const m = method(init);
    if (u.includes("/waitlist_offers?") && m === "GET") {
      return response(state.offerStatus === "notified" ? [offer] : []);
    }
    if (u.includes("/waitlist_offers?") && m === "PATCH") {
      if (state.offerStatus !== "notified") return response([]);
      state.offerStatus = "expired";
      writes.offer++;
      return response([{ ...offer, status: "expired" }]);
    }
    if (u.includes("/booking_invites?") && m === "PATCH") {
      if (state.inviteStatus !== "pending") return response([]);
      state.inviteStatus = "expired";
      writes.invite++;
      return response([{ token: INVITE, status: "expired" }]);
    }
    if (u.includes("/waitlist_entries?") && m === "PATCH") {
      if (state.entryStatus !== "offered") return response([]);
      state.entryStatus = "waiting";
      writes.entry++;
      return response([{ id: ENTRY, status: "waiting" }]);
    }
    if (u.includes("/bookable_slots?") && m === "GET") {
      return response([{ id: SLOT, coach_id: COACH, status: "open", starts_at: "2026-07-18T16:00:00.000Z", ends_at: "2026-07-18T17:00:00.000Z", timezone: "UTC", title: null, session_type_id: null, waitlist_fill_round: 7 }]);
    }
    if (u.includes("/coaches?") && m === "GET") {
      return response([{ id: COACH, waitlist_mode: "first_in_line", waitlist_offer_window_min: 5 }]);
    }
    if (u.includes("/waitlist_entries?") && m === "GET") return response([]);
    throw new Error(`unexpected ${m} ${u}`);
  };

  await withRuntime({ fetchImpl }, async () => {
    const primitive = buildWaitlistHandlers({ now: () => new Date(NOW_MS) }).expireWaitlistOffers;
    const [a, b] = await Promise.all([
      primitive({ now: new Date(NOW_MS), limit: 200 }),
      primitive({ now: new Date(NOW_MS), limit: 200 }),
    ]);
    assert.deepEqual(
      [a, b].map((x) => [x.expired, x.rolled]).sort(),
      [[0, 0], [1, 0]],
    );
    assert.deepEqual(await primitive({ now: new Date(NOW_MS), limit: 200 }), {
      examined: 0, expired: 0, rolled: 0,
    });
  });

  assert.deepEqual(writes, { offer: 1, entry: 1, invite: 1 });
  assert.deepEqual(state, { offerStatus: "expired", entryStatus: "waiting", inviteStatus: "expired" });
});
