const test = require("node:test");
const assert = require("node:assert/strict");

const calendar = require("../lib/calendar-sync");
const { encryptSecret } = require("../lib/crypto-box");

const COACH = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ATHLETE = "33333333-3333-4333-8333-333333333333";
const SLOT = "44444444-4444-4444-8444-444444444444";
const SESSION = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-07-16T12:00:00.000Z");
const TOKEN = `cal_${"ab".repeat(24)}`;

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  };
}

function mockFetch(fn) {
  const previous = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || "GET", options, rawBody: options.body };
    if (options.body && options.headers && String(options.headers["content-type"] || "").includes("json")) {
      call.body = JSON.parse(options.body);
    }
    calls.push(call);
    return fn(call, calls);
  };
  return { calls, restore() { global.fetch = previous; } };
}

function req(overrides = {}) {
  return { body: undefined, query: {}, params: {}, headers: {}, get(name) {
    return this.headers[String(name).toLowerCase()];
  }, ...overrides };
}

function res() {
  return {
    statusCode: 200, body: undefined, headers: {},
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    set(name, value) {
      if (typeof name === "object") Object.assign(this.headers, name);
      else this.headers[name] = value;
      return this;
    },
    setHeader(name, value) { this.headers[name] = value; return this; },
  };
}

function auth(role = "coach") {
  return async () => ({ user: {
    id: COACH,
    app_metadata: { role },
    user_metadata: { role: role === "coach" ? "athlete" : "coach" },
  } });
}

function build(extra = {}) {
  return calendar.buildCalendarHandlers({
    requireSupabaseUser: auth(),
    now: () => new Date(NOW),
    randomBytes: (size) => Buffer.alloc(size, 0xab),
    ...extra,
  });
}

function settings(overrides = {}) {
  return { coach_id: COACH, ics_feed_token: TOKEN, ics_enabled: true, ...overrides };
}

test.beforeEach(() => {
  process.env.SUPABASE_URL = "https://db.test";
  process.env.SUPABASE_SERVICE_KEY = "service-key";
  process.env.CALENDAR_PUBLIC_URL = "https://calendar.test/";
  process.env.GOOGLE_CALENDAR_CLIENT_ID = "client-id";
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "client-secret";
  process.env.GOOGLE_CALENDAR_REDIRECT_URI = "https://api.test/calendar/google/callback";
  process.env.CALENDAR_TOKEN_KEY = "11".repeat(32);
  process.env.CALENDAR_OAUTH_STATE_SECRET = "22".repeat(32);
  process.env.CRON_SECRET = "cron-secret";
});

test.after(() => {
  for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "CALENDAR_PUBLIC_URL",
    "GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET",
    "GOOGLE_CALENDAR_REDIRECT_URI", "CALENDAR_TOKEN_KEY",
    "CALENDAR_OAUTH_STATE_SECRET", "CRON_SECRET"]) delete process.env[key];
});

test("exports are exact and building the factory is inert", () => {
  assert.deepEqual(Object.keys(calendar), [
    "buildCalendarHandlers", "mirrorCalendarBooking", "cancelCalendarBooking",
    "reconcileBusyBlocks", "computeBlockTransitions",
  ]);
  let touched = 0;
  const handlers = calendar.buildCalendarHandlers({
    requireSupabaseUser: () => { touched++; },
    now: () => { touched++; },
    randomBytes: () => { touched++; },
  });
  assert.deepEqual(Object.keys(handlers), [
    "getConnection", "postFeedReset", "deleteFeed", "postGoogleConnect",
    "getGoogleCallback", "deleteGoogle", "getFeed", "getCronSync",
  ]);
  assert.equal(touched, 0);
});

test("every protected shape is rejected before auth or DB", async () => {
  let authCalls = 0;
  const handlers = build({ requireSupabaseUser: async () => {
    authCalls++; return { error: "unauthorized", status: 401 };
  } });
  const cases = [
    [handlers.getConnection, req({ query: { coach_id: COACH } })],
    [handlers.postFeedReset, req({ body: { token: TOKEN } })],
    [handlers.deleteFeed, req({ body: { coach_id: COACH } })],
    [handlers.postGoogleConnect, req({ body: { redirect_uri: "https://evil.test" } })],
    [handlers.deleteGoogle, req({ query: { provider: "google" } })],
  ];
  for (const [handler, request] of cases) {
    const out = res(); await handler(request, out);
    assert.deepEqual([out.statusCode, out.body], [400, { error: "invalid_request" }]);
  }
  assert.equal(authCalls, 0);
});

test("identity uses app_metadata only and config follows identity", async () => {
  delete process.env.SUPABASE_URL;
  let out = res();
  await build({ requireSupabaseUser: auth("athlete") }).getConnection(req(), out);
  assert.deepEqual([out.statusCode, out.body], [403, { error: "forbidden" }]);
  out = res();
  await build({ requireSupabaseUser: async () => ({ error: "unauthorized", status: 401 }) })
    .getConnection(req(), out);
  assert.deepEqual([out.statusCode, out.body], [401, { error: "unauthorized" }]);
  out = res(); await build().getConnection(req(), out);
  assert.deepEqual([out.statusCode, out.body], [503, { error: "not_configured" }]);
});

test("first connection read mints a 192-bit server token and strips secret rows", async () => {
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("coach_calendar_settings?") && method === "GET") return response([]);
    if (url.endsWith("/coach_calendar_settings") && method === "POST") {
      assert.deepEqual(body, { coach_id: COACH, ics_feed_token: TOKEN, ics_enabled: true });
      return response([settings()]);
    }
    if (url.includes("calendar_connections?") && method === "GET") return response([{
      coach_id: COACH, provider: "google", google_email: "coach@test.invalid",
      refresh_token_enc: "secret-ciphertext", access_token_enc: "more-secret",
      access_token_expires_at: "2026-07-16T13:00:00.000Z", status: "error",
      last_synced_at: null, sync_error_code: "reauthorize", injected: "drop-me",
    }]);
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res(); await build().getConnection(req(), out);
    assert.equal(out.statusCode, 200);
    assert.deepEqual(out.body, {
      ics: { enabled: true, feed_url: `https://calendar.test/calendar/${COACH}/feed.ics?token=${TOKEN}` },
      google: { email: "coach@test.invalid", status: "error", needs_reconnect: true, last_synced_at: null },
    });
    assert.equal(JSON.stringify(out.body).includes("secret"), false);
  } finally { mock.restore(); }
});

test("128 first-read mints are unique, exact entropy, and never request supplied", async () => {
  let serial = 0;
  const tokens = new Set();
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("coach_calendar_settings?") && method === "GET") return response([]);
    if (url.endsWith("/coach_calendar_settings") && method === "POST") {
      tokens.add(body.ics_feed_token); return response([settings({ ics_feed_token: body.ics_feed_token })]);
    }
    if (url.includes("calendar_connections?") && method === "GET") return response([]);
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const handlers = build({ randomBytes(size) {
      assert.equal(size, 24);
      const value = Buffer.alloc(24); value.writeUInt32BE(serial++); return value;
    } });
    for (let i = 0; i < 128; i++) {
      const out = res();
      await handlers.getConnection(req({ body: undefined, supplied_token: "attacker" }), out);
      assert.equal(out.statusCode, 200);
    }
    assert.equal(tokens.size, 128);
    for (const token of tokens) assert.match(token, /^cal_[0-9a-f]{48}$/);
  } finally { mock.restore(); }
});

test("settings 409 distinguishes coach race, token collision, and ambiguity", async () => {
  for (const scenario of ["coach", "token", "ambiguous"]) {
    let settingsReads = 0;
    let posts = 0;
    const mock = mockFetch(({ url, method, body }) => {
      if (url.includes("coach_calendar_settings?") && method === "GET") {
        settingsReads++;
        if (scenario === "coach" && settingsReads === 2) return response([settings()]);
        return response([]);
      }
      if (url.endsWith("/coach_calendar_settings") && method === "POST") {
        posts++;
        if (scenario === "token" && posts === 2) return response([settings({ ics_feed_token: body.ics_feed_token })]);
        const constraint = scenario === "coach" ? "coach_calendar_settings_pkey" :
          scenario === "token" ? "coach_calendar_settings_feed_token_idx" : "other_unique";
        return response({ code: "23505", message: `violates ${constraint}` }, 409);
      }
      if (url.includes("calendar_connections?")) return response([]);
      throw new Error(`unexpected ${method} ${url}`);
    });
    try {
      let nonce = 1;
      const out = res(); await build({ randomBytes: () => Buffer.alloc(24, nonce++) }).getConnection(req(), out);
      assert.equal(out.statusCode, scenario === "ambiguous" ? 500 : 200);
      assert.equal(posts, scenario === "token" ? 2 : 1);
    } finally { mock.restore(); }
  }
});

test("a malformed 2xx database body is internal_error, never an empty DTO", async () => {
  const mock = mockFetch(() => response(new SyntaxError("bad json")));
  try {
    const out = res(); await build().getConnection(req(), out);
    assert.deepEqual([out.statusCode, out.body], [500, { error: "internal_error" }]);
  } finally { mock.restore(); }
});

test("feed misses are byte-identical and malformed tokens use the zero lookup", async () => {
  const misses = [
    { query: {}, params: { coachId: COACH }, row: null },
    { query: { token: "bad" }, params: { coachId: COACH }, row: null },
    { query: { token: TOKEN }, params: { coachId: COACH }, row: settings({ ics_enabled: false }) },
    { query: { token: TOKEN }, params: { coachId: OTHER }, row: settings() },
    { query: { token: TOKEN }, params: { coachId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
      row: settings({ coach_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }) },
  ];
  let baseline;
  for (const item of misses) {
    const mock = mockFetch(({ url }) => {
      if (!item.query.token || item.query.token === "bad") assert.match(url, /cal_000000000000000000000000000000000000000000000000/);
      return response(item.row ? [item.row] : []);
    });
    try {
      const out = res(); await build().getFeed(req({ query: item.query, params: item.params }), out);
      const snapshot = JSON.stringify({ status: out.statusCode, body: out.body, headers: out.headers });
      baseline ||= snapshot;
      assert.equal(snapshot, baseline);
      assert.equal(mock.calls.length, 1, "miss never performs slot follow-up");
    } finally { mock.restore(); }
  }
});

test("valid feed is tenant bounded, stable, escaped, folded, and allowlist-only", async () => {
  const hostile = "Avery\\,;\r\nORGANIZER:mailto:evil@test <script> 東京".repeat(3);
  const mock = mockFetch(({ url }) => {
    if (url.includes("coach_calendar_settings?")) return response([settings()]);
    assert.match(url, new RegExp(`coach_id=eq\\.${COACH}`));
    assert.match(url, /status=eq\.booked/);
    assert.match(url, /order=starts_at\.asc&limit=500/);
    return response([{
      id: SLOT, coach_id: COACH, status: "booked", starts_at: "2026-07-17T14:00:00.000Z",
      ends_at: "2026-07-17T15:00:00.000Z", session_id: SESSION,
      athletes: { name: hostile }, title: "must not leak", note: "must not leak",
    }]);
  });
  try {
    const out = res(); await build().getFeed(req({ query: { token: TOKEN }, params: { coachId: COACH } }), out);
    assert.equal(out.statusCode, 200);
    assert.equal(out.headers["Content-Type"], "text/calendar; charset=utf-8");
    assert.match(out.body, new RegExp(`UID:${SLOT}@coachtime`));
    assert.match(out.body, /DTSTART:20260717T140000Z/);
    assert.match(out.body, new RegExp(`URL:https://calendar\\.test/join/${SESSION}`));
    assert.equal(out.body.includes("must not leak"), false);
    assert.equal(out.body.includes("\r\nORGANIZER:"), false);
    for (const line of out.body.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75);
    assert.equal((out.body.match(/BEGIN:VEVENT/g) || []).length, 1);
  } finally { mock.restore(); }
});

test("empty valid feed is a zero-event VCALENDAR", async () => {
  const mock = mockFetch(({ url }) => response(url.includes("coach_calendar_settings?") ? [settings()] : []));
  try {
    const out = res(); await build().getFeed(req({ query: { token: TOKEN }, params: { coachId: COACH } }), out);
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.includes("BEGIN:VEVENT"), false);
    assert.match(out.body, /^BEGIN:VCALENDAR\r\n/);
    assert.match(out.body, /END:VCALENDAR$/);
  } finally { mock.restore(); }
});

test("Google connect URL and signed state are exact and expire in ten minutes", async () => {
  const out = res(); await build().postGoogleConnect(req({ body: {} }), out);
  assert.equal(out.statusCode, 200);
  const url = new URL(out.body.auth_url);
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.deepEqual([...url.searchParams.keys()], [
    "client_id", "redirect_uri", "response_type", "access_type", "prompt",
    "include_granted_scopes", "scope", "state",
  ]);
  assert.equal(url.searchParams.get("redirect_uri"), process.env.GOOGLE_CALENDAR_REDIRECT_URI);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("scope"), ["openid", "email",
    "https://www.googleapis.com/auth/calendar.freebusy",
    "https://www.googleapis.com/auth/calendar.events"].join(" "));
  const payload = JSON.parse(Buffer.from(url.searchParams.get("state").split(".")[0], "base64url"));
  assert.deepEqual(Object.keys(payload), ["v", "coach_id", "iat", "exp", "nonce"]);
  assert.equal(payload.coach_id, COACH);
  assert.equal(payload.exp - payload.iat, 600);
  assert.match(payload.nonce, /^[A-Za-z0-9_-]{22}$/);
});

test("callback rejects repeated, extra, tampered, expired and future state before I/O", async () => {
  const connected = res(); await build().postGoogleConnect(req({ body: {} }), connected);
  const good = new URL(connected.body.auth_url).searchParams.get("state");
  const cases = [
    { code: ["a", "b"], state: good },
    { code: "a", state: good, coach_id: OTHER },
    { code: "a", state: `${good.slice(0, -1)}A` },
    { code: "", state: good },
  ];
  let calls = 0;
  const mock = mockFetch(() => { calls++; throw new Error("must not fetch"); });
  try {
    for (const query of cases) {
      const out = res(); await build().getGoogleCallback(req({ query }), out);
      assert.equal(out.statusCode, 400);
      assert.equal(out.headers["Cache-Control"], "no-store, max-age=0");
      assert.equal(out.body.includes("state"), false);
    }
    let out = res();
    await build({ now: () => new Date(NOW.getTime() + 600000) })
      .getGoogleCallback(req({ query: { code: "a", state: good } }), out);
    assert.equal(out.statusCode, 400, "exp equal to now is expired");
    out = res();
    await build({ now: () => new Date(NOW.getTime() - 1000) })
      .getGoogleCallback(req({ query: { code: "a", state: good } }), out);
    assert.equal(out.statusCode, 400, "future iat is rejected");
    assert.equal(calls, 0);
  } finally { mock.restore(); }
});

test("half-open transitions are deterministic across edges, nesting, duplicates, and all-day busy", () => {
  const slots = [
    { id: SLOT, coach_id: COACH, status: "open", calendar_blocked: false,
      starts_at: "2026-03-08T07:00:00Z", ends_at: "2026-03-08T08:00:00Z" },
    { id: OTHER, coach_id: COACH, status: "cancelled", calendar_blocked: true,
      starts_at: "2026-03-09T07:00:00Z", ends_at: "2026-03-09T08:00:00Z" },
    { id: ATHLETE, coach_id: COACH, status: "cancelled", calendar_blocked: false,
      starts_at: "2026-03-08T07:00:00Z", ends_at: "2026-03-08T08:00:00Z" },
  ];
  const busy = [
    { start: "2026-03-08T00:00:00Z", end: "2026-03-09T00:00:00Z" },
    { start: "2026-03-08T08:00:00Z", end: "2026-03-08T09:00:00Z" },
    { start: "2026-03-08T00:00:00Z", end: "2026-03-09T00:00:00Z" },
  ];
  assert.deepEqual(calendar.computeBlockTransitions(slots, busy), {
    block_ids: [SLOT], reopen_ids: [OTHER],
  });
  assert.throws(() => calendar.computeBlockTransitions(slots, [{ start: "bad", end: "worse" }]));
});

test("cron authenticates before configuration and missing config returns exact zero counters", async () => {
  delete process.env.SUPABASE_URL;
  let calls = 0;
  const mock = mockFetch(() => { calls++; throw new Error("must not fetch"); });
  try {
    let out = res(); await build().getCronSync(req({ headers: {} }), out);
    assert.deepEqual([out.statusCode, out.body], [401, { error: "unauthorized" }]);
    out = res(); await build().getCronSync(req({ headers: { "x-cron-secret": "cron-secret" } }), out);
    assert.deepEqual(out.body, { scanned: 0, synced: 0, failed: 0, blocked: 0, reopened: 0 });
    assert.equal(calls, 0);
  } finally { mock.restore(); }
});

test("reset and disable rotate with tenant+old-token predicates, including a missing first row", async () => {
  let current = null;
  let serial = 1;
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("coach_calendar_settings?") && method === "GET") {
      return response(current ? [current] : []);
    }
    if (url.endsWith("/coach_calendar_settings") && method === "POST") {
      current = settings({ ics_feed_token: body.ics_feed_token }); return response([current]);
    }
    if (url.includes("coach_calendar_settings?") && method === "PATCH") {
      assert.match(url, new RegExp(`coach_id=eq\\.${COACH}.*ics_feed_token=eq\\.`));
      current = settings({ ics_feed_token: body.ics_feed_token, ics_enabled: body.ics_enabled });
      return response([current]);
    }
    if (url.includes("calendar_connections?") && method === "GET") return response([]);
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const handlers = build({ randomBytes(size) {
      const bytes = Buffer.alloc(size); bytes.writeUInt32BE(serial++); return bytes;
    } });
    const reset = res(); await handlers.postFeedReset(req({ body: {} }), reset);
    assert.equal(reset.statusCode, 200);
    const resetUrl = reset.body.ics.feed_url;
    assert.match(resetUrl, /cal_[0-9a-f]{48}$/);
    const disabled = res(); await handlers.deleteFeed(req(), disabled);
    assert.equal(disabled.statusCode, 204);
    assert.equal(current.ics_enabled, false);
    assert.notEqual(resetUrl.split("token=")[1], current.ics_feed_token);
  } finally { mock.restore(); }
});

test("reconcile sends primary-only 84-day FreeBusy and applies atomic prior-state transitions", async () => {
  const access = encryptSecret("access-token", { coachId: COACH, column: "access_token_enc" });
  const refresh = encryptSecret("refresh-token", { coachId: COACH, column: "refresh_token_enc" });
  const second = "66666666-6666-4666-8666-666666666666";
  const mock = mockFetch(({ url, method, body, options }) => {
    if (url.includes("calendar_connections?") && method === "GET") return response([{
      coach_id: COACH, provider: "google", google_email: null,
      refresh_token_enc: refresh, access_token_enc: access,
      access_token_expires_at: "2026-07-16T13:00:00.000Z", status: "active",
      last_synced_at: null, sync_error_code: null,
    }]);
    if (url.endsWith("/calendar/v3/freeBusy")) {
      assert.equal(options.headers.authorization, "Bearer access-token");
      assert.deepEqual(body, {
        timeMin: NOW.toISOString(), timeMax: "2026-10-08T12:00:00.000Z", items: [{ id: "primary" }],
      });
      return response({ calendars: { primary: { busy: [{
        start: "2026-07-17T13:30:00.000Z", end: "2026-07-17T14:30:00.000Z",
      }] } } });
    }
    if (url.includes("bookable_slots?") && method === "GET") {
      assert.match(url, new RegExp(`coach_id=eq\\.${COACH}`));
      assert.match(url, /status=in\.\(open,cancelled\)/);
      return response([
        { id: SLOT, coach_id: COACH, status: "open", calendar_blocked: false,
          starts_at: "2026-07-17T14:00:00.000Z", ends_at: "2026-07-17T15:00:00.000Z" },
        { id: second, coach_id: COACH, status: "cancelled", calendar_blocked: true,
          starts_at: "2026-07-18T14:00:00.000Z", ends_at: "2026-07-18T15:00:00.000Z" },
      ]);
    }
    if (url.includes(`id=eq.${SLOT}`) && method === "PATCH") {
      assert.match(url, /coach_id=eq\..*&status=eq\.open&calendar_blocked=eq\.false/);
      assert.deepEqual(body, { status: "cancelled", calendar_blocked: true }); return response([{ id: SLOT }]);
    }
    if (url.includes(`id=eq.${second}`) && method === "PATCH") {
      assert.match(url, /coach_id=eq\..*&status=eq\.cancelled&calendar_blocked=eq\.true/);
      assert.deepEqual(body, { status: "open", calendar_blocked: false }); return response([{ id: second }]);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    assert.deepEqual(await calendar.reconcileBusyBlocks({ coachId: COACH, now: new Date(NOW) }),
      { blocked: 1, reopened: 1 });
  } finally { mock.restore(); }
});

function mirrorPayload(overrides = {}) {
  return { coachId: COACH, athleteId: ATHLETE, slot: {
    id: SLOT, coach_id: COACH, booked_by: ATHLETE, status: "booked",
    starts_at: "2026-07-17T14:00:00.000Z", ends_at: "2026-07-17T15:00:00.000Z",
    timezone: "America/New_York", title: "private title", session_id: SESSION,
    gcal_event_id: null, ...overrides,
  } };
}

test("mirror validates before DB, re-reads both tenants, and disambiguates provider 409 metadata", async () => {
  let calls = 0;
  await assert.rejects(() => calendar.mirrorCalendarBooking({ coachId: COACH }), TypeError);
  assert.equal(calls, 0);
  const access = encryptSecret("access-token", { coachId: COACH, column: "access_token_enc" });
  const refresh = encryptSecret("refresh-token", { coachId: COACH, column: "refresh_token_enc" });
  let eventId;
  const mock = mockFetch(({ url, method, body }) => {
    calls++;
    if (url.includes("bookable_slots?") && method === "GET") {
      assert.match(url, new RegExp(`coach_id=eq\\.${COACH}.*booked_by=eq\\.${ATHLETE}.*status=eq\\.booked`));
      return response([{ ...mirrorPayload().slot, calendar_blocked: false }]);
    }
    if (url.includes("athletes?") && method === "GET") {
      assert.match(url, new RegExp(`id=eq\\.${ATHLETE}.*coach_id=eq\\.${COACH}`));
      return response([{ id: ATHLETE, coach_id: COACH, name: "Avery" }]);
    }
    if (url.includes("calendar_connections?") && method === "GET") return response([{
      coach_id: COACH, provider: "google", google_email: null, refresh_token_enc: refresh,
      access_token_enc: access, access_token_expires_at: "2099-01-01T00:00:00Z",
      status: "active", last_synced_at: null, sync_error_code: null,
    }]);
    if (url.endsWith("/calendars/primary/events") && method === "POST") {
      eventId = body.id;
      assert.match(eventId, /^ct[0-9a-f]{64}$/);
      assert.deepEqual(body, {
        id: eventId, summary: "CoachTime — Avery",
        description: `Join CoachTime: https://calendar.test/join/${SESSION}`,
        start: { dateTime: "2026-07-17T14:00:00.000Z" },
        end: { dateTime: "2026-07-17T15:00:00.000Z" },
        extendedProperties: { private: { coachTimeSlotId: SLOT, coachTimeManaged: "1" } },
      });
      return response({ error: "already exists" }, 409);
    }
    if (eventId && url.endsWith(`/events/${eventId}`) && method === "GET") return response({
      id: eventId, extendedProperties: { private: { coachTimeSlotId: SLOT, coachTimeManaged: "1" } },
    });
    if (url.includes("bookable_slots?") && method === "PATCH") {
      assert.match(url, /coach_id=eq\..*&booked_by=eq\..*&status=eq\.booked&gcal_event_id=is\.null/);
      return response([{ id: SLOT, gcal_event_id: eventId }]);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    assert.deepEqual(await calendar.mirrorCalendarBooking(mirrorPayload()), {
      mirrored: true, event_id: eventId, disposition: "existing",
    });
  } finally { mock.restore(); }
});

test("cancel treats provider 404 as already absent and clears the exact tenant/state/event", async () => {
  const eventId = "ct" + "a".repeat(64);
  const access = encryptSecret("access-token", { coachId: COACH, column: "access_token_enc" });
  const refresh = encryptSecret("refresh-token", { coachId: COACH, column: "refresh_token_enc" });
  const payload = mirrorPayload({ status: "cancelled", booked_by: null, gcal_event_id: eventId });
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("bookable_slots?") && method === "GET") return response([{
      ...payload.slot, calendar_blocked: false,
    }]);
    if (url.includes("calendar_connections?") && method === "GET") return response([{
      coach_id: COACH, provider: "google", google_email: null, refresh_token_enc: refresh,
      access_token_enc: access, access_token_expires_at: "2099-01-01T00:00:00Z",
      status: "error", last_synced_at: null, sync_error_code: "google_unavailable",
    }]);
    if (url.endsWith(`/events/${eventId}`) && method === "DELETE") return response("", 404);
    if (url.includes("bookable_slots?") && method === "PATCH") {
      assert.match(url, new RegExp(`coach_id=eq\\.${COACH}.*status=in\\.\\(open,cancelled\\).*booked_by=is\\.null.*gcal_event_id=eq\\.${eventId}`));
      assert.equal(body.gcal_event_id, null); return response([{ id: SLOT }]);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    assert.deepEqual(await calendar.cancelCalendarBooking(payload), {
      cancelled: true, disposition: "already_absent",
    });
  } finally { mock.restore(); }
});

test("successful callback stores ciphertext, never plaintext, then returns invariant hardened HTML", async () => {
  const connect = res(); await build().postGoogleConnect(req({ body: {} }), connect);
  const state = new URL(connect.body.auth_url).searchParams.get("state");
  let stored;
  let connectionReads = 0;
  const mock = mockFetch(({ url, method, body, rawBody }) => {
    if (url === "https://oauth2.googleapis.com/token") {
      assert.match(rawBody, /grant_type=authorization_code/);
      assert.match(rawBody, /redirect_uri=https%3A%2F%2Fapi\.test%2Fcalendar%2Fgoogle%2Fcallback/);
      return response({ access_token: "plain-access", refresh_token: "plain-refresh", expires_in: 3600 });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") return response({ email: "coach@test.invalid" });
    if (url.includes("calendar_connections?") && method === "POST") {
      stored = body; return response([body]);
    }
    if (url.includes("calendar_connections?") && method === "GET") {
      connectionReads++; return response([]);
    }
    if (url.includes("calendar_connections?") && method === "PATCH") return response([{ coach_id: COACH }]);
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res(); await build().getGoogleCallback(req({ query: { code: "oauth-code", state } }), out);
    assert.equal(out.statusCode, 200);
    assert.equal(out.body, "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>CoachTime</title></head><body><main><p>Google Calendar connected. Return to CoachTime.</p></main></body></html>");
    assert.equal(out.headers["Content-Security-Policy"].includes("default-src 'none'"), true);
    assert.equal(JSON.stringify(stored).includes("plain-access"), false);
    assert.equal(JSON.stringify(stored).includes("plain-refresh"), false);
    assert.match(stored.access_token_enc, /^v1:/);
    assert.match(stored.refresh_token_enc, /^v1:/);
    assert.equal(connectionReads, 1);
  } finally { mock.restore(); }
});

test("disconnect is idempotent; revoke is best-effort and RPC remains tenant-derived", async () => {
  const access = encryptSecret("access-token", { coachId: COACH, column: "access_token_enc" });
  const refresh = encryptSecret("refresh-token", { coachId: COACH, column: "refresh_token_enc" });
  for (const connected of [false, true]) {
    let rpc = 0;
    const mock = mockFetch(({ url, method, body }) => {
      if (url.includes("calendar_connections?") && method === "GET") return response(connected ? [{
        coach_id: COACH, provider: "google", google_email: null, refresh_token_enc: refresh,
        access_token_enc: access, access_token_expires_at: "2099-01-01T00:00:00Z",
        status: "active", last_synced_at: null, sync_error_code: null,
      }] : []);
      if (url.startsWith("https://oauth2.googleapis.com/revoke")) throw new Error("offline");
      if (url.endsWith("/rpc/disconnect_calendar_connection") && method === "POST") {
        rpc++; assert.deepEqual(body, { p_coach_id: COACH }); return response(2);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    try {
      const out = res(); await build().deleteGoogle(req(), out);
      assert.equal(out.statusCode, 204);
      assert.equal(rpc, connected ? 1 : 0);
    } finally { mock.restore(); }
  }
});

test("FreeBusy embedded errors fail closed before slot reads or reopen writes", async () => {
  const access = encryptSecret("access-token", { coachId: COACH, column: "access_token_enc" });
  const refresh = encryptSecret("refresh-token", { coachId: COACH, column: "refresh_token_enc" });
  let slotCalls = 0;
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("calendar_connections?") && method === "GET") return response([{
      coach_id: COACH, provider: "google", google_email: null, refresh_token_enc: refresh,
      access_token_enc: access, access_token_expires_at: "2099-01-01T00:00:00.000Z",
      status: "active", last_synced_at: null, sync_error_code: null,
    }]);
    if (url.endsWith("/calendar/v3/freeBusy")) return response({
      calendars: { primary: { errors: [{ reason: "backendError" }], busy: [] } },
    });
    if (url.includes("bookable_slots?")) slotCalls++;
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    await assert.rejects(
      calendar.reconcileBusyBlocks({ coachId: COACH, now: new Date(NOW) }),
      /provider request failed/,
    );
    assert.equal(slotCalls, 0);
  } finally { mock.restore(); }
});

test("feed strips lone CR controls and rejects every cross-tenant returned row", async () => {
  for (const item of [
    { coach_id: COACH, name: "Avery\rATTENDEE:mailto:evil@test", expected: 200 },
    { coach_id: OTHER, name: "Avery", expected: 500 },
  ]) {
    const mock = mockFetch(({ url }) => {
      if (url.includes("coach_calendar_settings?")) return response([settings()]);
      return response([{
        id: SLOT, coach_id: item.coach_id, status: "booked",
        starts_at: "2026-07-17T14:00:00.000Z", ends_at: "2026-07-17T15:00:00.000Z",
        session_id: null, athletes: { name: item.name },
      }]);
    });
    try {
      const out = res();
      await build().getFeed(req({ query: { token: TOKEN }, params: { coachId: COACH } }), out);
      assert.equal(out.statusCode, item.expected);
      if (item.expected === 200) {
        assert.equal(out.body.includes("\rATTENDEE:"), false);
        assert.equal(out.body.replace(/\r\n/g, "").includes("\r"), false);
        assert.equal((out.body.match(/BEGIN:VEVENT/g) || []).length, 1);
      } else {
        assert.deepEqual(out.body, { error: "internal_error" });
        assert.equal(String(out.body).includes("BEGIN:VEVENT"), false);
      }
    } finally { mock.restore(); }
  }
});

test("callback rejects a malformed 2xx upsert representation", async () => {
  const connect = res(); await build().postGoogleConnect(req({ body: {} }), connect);
  const state = new URL(connect.body.auth_url).searchParams.get("state");
  let reconciled = false;
  const mock = mockFetch(({ url, method }) => {
    if (url === "https://oauth2.googleapis.com/token") {
      return response({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") return response({ email: null });
    if (url.includes("calendar_connections?") && method === "POST") return response([{}]);
    reconciled = true;
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await build().getGoogleCallback(req({ query: { code: "code", state } }), out);
    assert.equal(out.statusCode, 500);
    assert.equal(out.body.includes("connected. Return"), false);
    assert.equal(reconciled, false);
  } finally { mock.restore(); }
});

test("concurrent refresh CAS uses old expiry generation and stale loser re-reads winner", async () => {
  const refresh = encryptSecret("refresh-token", { coachId: COACH, column: "refresh_token_enc" });
  let current = {
    coach_id: COACH, provider: "google", google_email: null, refresh_token_enc: refresh,
    access_token_enc: null, access_token_expires_at: null, status: "active",
    last_synced_at: null, sync_error_code: null,
  };
  let tokenSerial = 0;
  let committed = 0;
  const authHeaders = [];
  const casUrls = [];
  const mock = mockFetch(({ url, method, body, options }) => {
    if (url.includes("calendar_connections?") && method === "GET") return response([current]);
    if (url === "https://oauth2.googleapis.com/token") {
      tokenSerial++;
      return response({ access_token: `access-${tokenSerial}`, expires_in: 3600 });
    }
    if (url.includes("calendar_connections?") && method === "PATCH") {
      casUrls.push(url);
      if (current.access_token_expires_at !== null) return response([]);
      committed++;
      current = { ...current, ...body };
      return response([current]);
    }
    if (url.endsWith("/calendar/v3/freeBusy")) {
      authHeaders.push(options.headers.authorization);
      return response({ calendars: { primary: { busy: [] } } });
    }
    if (url.includes("bookable_slots?") && method === "GET") return response([]);
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const results = await Promise.all([
      calendar.reconcileBusyBlocks({ coachId: COACH, now: new Date(NOW) }),
      calendar.reconcileBusyBlocks({ coachId: COACH, now: new Date(NOW) }),
    ]);
    assert.deepEqual(results, [{ blocked: 0, reopened: 0 }, { blocked: 0, reopened: 0 }]);
    assert.equal(committed, 1);
    assert.equal(casUrls.length, 2);
    assert.ok(casUrls.every((url) => url.includes("access_token_expires_at=is.null")));
    assert.equal(new Set(authHeaders).size, 1, "loser discards its stale access token");
  } finally { mock.restore(); }
});

test("stale permanent refresh failure cannot mark a concurrent reconnect as error", async () => {
  const oldRefresh = encryptSecret("old-refresh", { coachId: COACH, column: "refresh_token_enc" });
  const newRefresh = encryptSecret("new-refresh", { coachId: COACH, column: "refresh_token_enc" });
  const newAccess = encryptSecret("new-access", { coachId: COACH, column: "access_token_enc" });
  let current = {
    coach_id: COACH, provider: "google", google_email: null, refresh_token_enc: oldRefresh,
    access_token_enc: null, access_token_expires_at: null, status: "active",
    last_synced_at: null, sync_error_code: null,
  };
  const patches = [];
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("calendar_connections?status=eq.active&select=coach_id")) {
      return response([{ coach_id: COACH }]);
    }
    if (url.includes("calendar_connections?") && method === "GET") return response([current]);
    if (url === "https://oauth2.googleapis.com/token") {
      current = { ...current, refresh_token_enc: newRefresh, access_token_enc: newAccess,
        access_token_expires_at: "2099-01-01T00:00:00.000Z", status: "active",
        sync_error_code: null };
      return response({ error: "invalid_grant" }, 400);
    }
    if (url.includes("calendar_connections?") && method === "PATCH") {
      patches.push({ url, body });
      if (!url.includes(`refresh_token_enc=eq.${encodeURIComponent(current.refresh_token_enc)}`) ||
          !url.includes(`access_token_expires_at=eq.${encodeURIComponent(current.access_token_expires_at)}`)) {
        return response([]);
      }
      current = { ...current, ...body };
      return response([current]);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await build().getCronSync(req({ headers: { "x-cron-secret": "cron-secret" } }), out);
    assert.deepEqual(out.body, { scanned: 1, synced: 0, failed: 1, blocked: 0, reopened: 0 });
    assert.equal(current.refresh_token_enc, newRefresh);
    assert.equal(current.status, "active");
    assert.equal(current.sync_error_code, null);
    assert.equal(patches.length, 1, "cron does not repeat the handled permanent-failure write");
    assert.ok(patches[0].url.includes(`refresh_token_enc=eq.${encodeURIComponent(oldRefresh)}`));
    assert.ok(patches[0].url.includes("access_token_expires_at=is.null"));
  } finally { mock.restore(); }
});

test("cron retries transient active failures next sweep but removes invalid_grant permanently", async () => {
  const access = encryptSecret("access-token", { coachId: COACH, column: "access_token_enc" });
  const refresh = encryptSecret("refresh-token", { coachId: COACH, column: "refresh_token_enc" });
  let current = {
    coach_id: COACH, provider: "google", google_email: null, refresh_token_enc: refresh,
    access_token_enc: access, access_token_expires_at: "2099-01-01T00:00:00.000Z",
    status: "active", last_synced_at: null, sync_error_code: null,
  };
  let sweep = 0;
  let freebusyCalls = 0;
  const patches = [];
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("calendar_connections?status=eq.active&select=coach_id")) {
      sweep++;
      return response(current.status === "active" ? [{ coach_id: COACH }] : []);
    }
    if (url.includes("calendar_connections?") && method === "GET") return response([current]);
    if (url.endsWith("/calendar/v3/freeBusy")) {
      freebusyCalls++;
      if (freebusyCalls === 1) return response({ error: "backend" }, 503);
      return response({ calendars: { primary: { busy: [] } } });
    }
    if (url.includes("bookable_slots?") && method === "GET") return response([]);
    if (url.includes("calendar_connections?") && method === "PATCH") {
      patches.push(body); current = { ...current, ...body }; return response([current]);
    }
    if (url === "https://oauth2.googleapis.com/token") {
      return response({ error: "invalid_grant" }, 400);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const handlers = build();
    let out = res();
    await handlers.getCronSync(req({ headers: { "x-cron-secret": "cron-secret" } }), out);
    assert.deepEqual(out.body, { scanned: 1, synced: 0, failed: 1, blocked: 0, reopened: 0 });
    assert.equal(current.status, "active");
    out = res();
    await handlers.getCronSync(req({ headers: { "x-cron-secret": "cron-secret" } }), out);
    assert.equal(out.body.synced, 1);
    assert.equal(freebusyCalls, 2, "next sweep rescans transient failure");

    current = { ...current, access_token_enc: null, access_token_expires_at: null,
      status: "active", sync_error_code: null };
    out = res();
    await handlers.getCronSync(req({ headers: { "x-cron-secret": "cron-secret" } }), out);
    assert.equal(out.body.failed, 1);
    assert.equal(current.status, "error");
    assert.equal(current.sync_error_code, "reauthorize");
    out = res();
    await handlers.getCronSync(req({ headers: { "x-cron-secret": "cron-secret" } }), out);
    assert.equal(out.body.scanned, 0, "permanent revocation leaves later sweeps");
    assert.equal(sweep, 4);
    assert.ok(patches.some((body) => body.status === "active"));
  } finally { mock.restore(); }
});
