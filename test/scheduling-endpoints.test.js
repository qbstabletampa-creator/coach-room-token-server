// D12 scheduling ENDPOINT unit tests (the token-server data layer: ics builder,
// book/cancel/credit flow, slot generation). Separate file from the /book PAGE
// route tests in scheduling.test.js. No network, no live creds; each test FILE
// runs in its own process under `node --test`, so this env is isolated.
//
// Env is set BEFORE requiring index.js so the module boots in test mode
// (require.main !== module skips app.listen) with the scheduling routes ENABLED.
// STRIPE_* / RESEND_API_KEY stay unset (email is a graceful no-op, no fetch).

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
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.RESEND_API_KEY;

const { app } = require("../index.js");
const { buildIcs, formatCalendarDate } = require("../lib/ics.js");
const { expandWindows, bookingEmailHtml } = require("../lib/scheduling.js");

// ---- tiny in-process HTTP harness (same shape as payments.test.js) ---------
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
    if (payload && !h["content-type"] && !h["Content-Type"]) {
      h["content-type"] = "application/json";
    }
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

const FUTURE = new Date(Date.now() + 14 * 86400000).toISOString();
const UUID_A = "11111111-1111-4111-8111-111111111111"; // invite token
const SLOT_ID = "22222222-2222-4222-8222-222222222222";
const COACH_ID = "33333333-3333-4333-8333-333333333333";
const ATHLETE_ID = "44444444-4444-4444-8444-444444444444";
const PURCHASE_ID = "55555555-5555-4555-8555-555555555555";
const NEW_INVITE_TOKEN = "66666666-6666-4666-8666-666666666666"; // minted by /send-invite
const CLAIM_TOKEN = "77777777-7777-4777-8777-777777777777"; // minted by the claim touchpoint
const AUTH_ID = "88888888-8888-4888-8888-888888888888"; // a claimed athlete's auth user id

// ===========================================================================
// 1. ics golden: line folding + escaping
// ===========================================================================

test("buildIcs folds long lines to <=75 bytes and escapes , ; \\ and newlines", () => {
  const start = new Date("2026-07-13T21:00:00.000Z");
  const end = new Date("2026-07-13T22:00:00.000Z");
  const ics = buildIcs({
    title: "QB private, live",
    description:
      "Bring cleats, water; a great attitude \\ and be ready to work hard for the whole hour because this is a long line meant to exceed seventy five bytes\nSee you there",
    start,
    end,
    url: "https://coachtime.app/book?token=abc",
    organizer: "coach@coachtime.app",
  });

  // Structure.
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.ok(ics.includes("END:VCALENDAR"));
  assert.ok(ics.includes(`DTSTART:${formatCalendarDate(start)}`));
  assert.ok(ics.includes(`DTEND:${formatCalendarDate(end)}`));
  assert.ok(ics.includes("DTSTART:20260713T210000Z"), "UTC Z form, not fake-local");

  // Every PHYSICAL line is <= 75 octets (RFC-5545 folding).
  for (const line of ics.split("\r\n")) {
    assert.ok(
      Buffer.byteLength(line, "utf8") <= 75,
      `line exceeds 75 bytes: ${JSON.stringify(line)}`,
    );
  }

  // Unfold (remove CRLF+space) then check the escaping landed.
  const unfolded = ics.replace(/\r\n /g, "");
  const descLine = unfolded.split("\r\n").find((l) => l.startsWith("DESCRIPTION:"));
  assert.ok(descLine, "a DESCRIPTION line exists");
  assert.ok(descLine.includes("cleats\\,"), "comma is escaped");
  assert.ok(descLine.includes("water\\;"), "semicolon is escaped");
  assert.ok(descLine.includes("\\\\"), "backslash is escaped");
  assert.ok(descLine.includes("\\n"), "newline is escaped to literal \\n");
  assert.ok(!descLine.includes("\nSee you"), "no raw newline survived");
});

// ===========================================================================
// Shared fetch mock builder for the HTTP-driven booking tests.
// Routes Supabase REST calls by URL + method; records every call so tests can
// assert what the handler did. Anything unmatched returns a generic ok/empty
// (covers notify()'s notifications insert + push_tokens lookup).
// ===========================================================================
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
    // Default: ok + empty (notify's inserts, push token lookups, etc.).
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

// ===========================================================================
// 2. book refuses a non-open slot -> 409 slot_unavailable
// ===========================================================================

test("POST /schedule/:token/book returns 409 when the slot is not open", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      test: (u, m) => u.includes("/booking_invites") && m === "GET",
      reply: () =>
        ok([
          {
            token: UUID_A,
            coach_id: COACH_ID,
            athlete_id: ATHLETE_ID,
            slot_id: null,
            email: null,
            status: "pending",
            expires_at: FUTURE,
            coaches: { full_name: "Coach CJ" },
            athletes: { name: "Athlete A", parent_email: null },
          },
        ]),
    },
    {
      // credit balance precheck: has a credit.
      test: (u, m) =>
        u.includes("/package_purchases") && u.includes("status=eq.active") && m === "GET",
      reply: () => ok([{ credits_remaining: 2 }]),
    },
    {
      // claim PATCH on an already-taken slot: 0 rows updated.
      test: (u, m) =>
        u.includes("/bookable_slots") && u.includes("status=eq.open") && m === "PATCH",
      reply: () => ok([]),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: `/schedule/${UUID_A}/book`,
      body: JSON.stringify({ slotId: SLOT_ID }),
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.json.error, "slot_unavailable");
    // The credit was NEVER deducted (no deduct ledger insert fired).
    assert.ok(
      !mock.calls.some(
        (c) =>
          c.u.includes("/credit_deductions") &&
          c.method === "POST" &&
          c.body &&
          c.body.action === "deduct",
      ),
      "no credit is spent when the slot claim fails",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 3. zero credits -> 402 no_credits with a checkout hint
// ===========================================================================

test("POST /schedule/:token/book returns 402 no_credits when the athlete has none", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      test: (u, m) => u.includes("/booking_invites") && m === "GET",
      reply: () =>
        ok([
          {
            token: UUID_A,
            coach_id: COACH_ID,
            athlete_id: ATHLETE_ID,
            slot_id: null,
            status: "pending",
            expires_at: FUTURE,
            coaches: { full_name: "Coach CJ" },
            athletes: { name: "Athlete A" },
          },
        ]),
    },
    {
      // credit balance precheck: ZERO active purchases.
      test: (u, m) =>
        u.includes("/package_purchases") && u.includes("status=eq.active") && m === "GET",
      reply: () => ok([]),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: `/schedule/${UUID_A}/book`,
      body: JSON.stringify({ slotId: SLOT_ID }),
    });
    assert.strictEqual(res.status, 402);
    assert.strictEqual(res.json.error, "no_credits");
    assert.ok(res.json.checkoutHint, "a checkout hint routes the athlete forward, no dead end");
    // The slot was never touched (no claim PATCH fired).
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/bookable_slots") && c.method === "PATCH"),
      "the slot is not claimed when there are no credits",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 4. cancel refunds the credit to the ORIGINATING purchase
// ===========================================================================

test("POST /schedule/:token/cancel refunds one credit to the source purchase", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      test: (u, m) => u.includes("/booking_invites") && m === "GET",
      reply: () =>
        ok([
          {
            token: UUID_A,
            coach_id: COACH_ID,
            athlete_id: ATHLETE_ID,
            slot_id: SLOT_ID,
            status: "accepted",
            expires_at: FUTURE,
            coaches: { full_name: "Coach CJ" },
            athletes: { name: "Athlete A" },
          },
        ]),
    },
    {
      // reopen gate: this athlete booked it -> 1 row.
      test: (u, m) =>
        u.includes("/bookable_slots") && u.includes("status=eq.booked") && m === "PATCH",
      reply: () => ok([{ id: SLOT_ID, status: "open", starts_at: FUTURE, ends_at: FUTURE }]),
    },
    {
      // originating deduct ledger row -> names the source purchase.
      test: (u, m) =>
        u.includes("/credit_deductions") && u.includes("action=eq.deduct") && m === "GET",
      reply: () => ok([{ purchase_id: PURCHASE_ID, coach_id: COACH_ID }]),
    },
    {
      // the source purchase: exhausted by this booking.
      test: (u, m) =>
        u.includes("/package_purchases") && u.includes(`id=eq.${PURCHASE_ID}`) && m === "GET",
      reply: () =>
        ok([
          { id: PURCHASE_ID, credits_remaining: 0, credits_total: 5, status: "exhausted" },
        ]),
    },
    {
      // final balance re-sum.
      test: (u, m) =>
        u.includes("/package_purchases") && u.includes("status=eq.active") && m === "GET",
      reply: () => ok([{ credits_remaining: 1 }]),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: `/schedule/${UUID_A}/cancel`,
      body: JSON.stringify({ slotId: SLOT_ID }),
    });
    assert.strictEqual(res.status, 200);

    // The purchase was bumped back to 1 credit AND reactivated to 'active'.
    const bump = mock.calls.find(
      (c) =>
        c.u.includes("/package_purchases") &&
        c.u.includes(`id=eq.${PURCHASE_ID}`) &&
        c.method === "PATCH",
    );
    assert.ok(bump, "the source purchase was PATCHed");
    assert.strictEqual(bump.body.credits_remaining, 1, "one credit returned");
    assert.strictEqual(bump.body.status, "active", "exhausted pack reactivated");

    // A refund ledger row was appended AGAINST THE SOURCE purchase.
    const refund = mock.calls.find(
      (c) =>
        c.u.includes("/credit_deductions") &&
        c.method === "POST" &&
        c.body &&
        c.body.action === "refund",
    );
    assert.ok(refund, "a refund ledger row was appended");
    assert.strictEqual(refund.body.purchase_id, PURCHASE_ID, "refund goes to the source purchase");
    assert.strictEqual(refund.body.amount, 1);
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 5. slot generation is idempotent across two runs
// ===========================================================================

test("expandWindows is idempotent: a second run over the same slots inserts nothing", () => {
  const now = new Date("2026-07-13T12:00:00.000Z"); // fixed Monday noon UTC
  const windows = [
    {
      id: "win-1",
      coach_id: COACH_ID,
      day_of_week: 5, // Friday
      start_time: "17:00:00",
      end_time: "19:00:00",
      timezone: "America/New_York",
      slot_minutes: 60,
    },
  ];

  // Run 1: nothing exists yet.
  const first = expandWindows({ windows, existing: [], weeks: 2, now, coachId: COACH_ID });
  assert.ok(first.rows.length > 0, "the first run generates slots");
  assert.strictEqual(first.skipped, 0);
  for (const r of first.rows) {
    assert.strictEqual(r.source, "availability");
    assert.strictEqual(r.window_id, "win-1");
    assert.strictEqual(r.status, "open");
    assert.ok(r.starts_at.endsWith("Z") || r.starts_at.includes("+00:00"));
  }

  // Run 2: feed the first run's rows back as existing -> zero new, all skipped.
  const existing = first.rows.map((r) => ({ window_id: r.window_id, starts_at: r.starts_at }));
  const second = expandWindows({ windows, existing, weeks: 2, now, coachId: COACH_ID });
  assert.strictEqual(second.rows.length, 0, "the second run inserts nothing");
  assert.strictEqual(second.skipped, first.rows.length, "every candidate was recognized as existing");
});

// ===========================================================================
// 6. DST-correct UTC: a 5pm America/New_York slot is 21:00Z in summer
// ===========================================================================

test("expandWindows computes real UTC from the IANA zone (no fake-local)", () => {
  const now = new Date("2026-07-13T12:00:00.000Z");
  const windows = [
    {
      id: "win-1",
      coach_id: COACH_ID,
      day_of_week: 5,
      start_time: "17:00:00",
      end_time: "18:00:00",
      timezone: "America/New_York", // EDT (UTC-4) in July
      slot_minutes: 60,
    },
  ];
  const { rows } = expandWindows({ windows, existing: [], weeks: 1, now, coachId: COACH_ID });
  assert.ok(rows.length > 0);
  // 17:00 EDT == 21:00 UTC.
  const start = new Date(rows[0].starts_at);
  assert.strictEqual(start.getUTCHours(), 21, "5pm New York in July is 21:00 UTC");
});

// ===========================================================================
// 7. POST /send-invite happy path: 201 { token, url, expires_at ~14d }
// ===========================================================================

test("POST /send-invite mints an invite: 201 token + url + ~14-day expiry", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      // coach JWT -> a coach-role user.
      test: (u) => u.includes("/auth/v1/user"),
      reply: () => ok({ id: COACH_ID, user_metadata: { role: "coach" } }),
    },
    {
      // tenant check: the athlete belongs to this coach.
      test: (u, m) => u.includes("/athletes") && m === "GET",
      reply: () => ok([{ id: ATHLETE_ID }]),
    },
    {
      // insert echoes the body back with a DB-minted token.
      test: (u, m) => u.includes("/booking_invites") && m === "POST",
      reply: (u, m, opts) => ok([{ token: NEW_INVITE_TOKEN, ...JSON.parse(opts.body) }]),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/send-invite",
      headers: { authorization: "Bearer coach-jwt" },
      body: JSON.stringify({ athlete_id: ATHLETE_ID }),
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.json.token, NEW_INVITE_TOKEN);
    assert.ok(
      res.json.url.endsWith(`/book/${NEW_INVITE_TOKEN}`),
      "url points at the athlete booking page for this token",
    );
    const days = (new Date(res.json.expires_at).getTime() - Date.now()) / 86400000;
    assert.ok(days > 13.5 && days < 14.5, "invite expires ~14 days out");

    // The insert carried a pending status, the coach from auth, and ~14d expiry.
    const ins = mock.calls.find((c) => c.u.includes("/booking_invites") && c.method === "POST");
    assert.ok(ins, "an invite row was inserted");
    assert.strictEqual(ins.body.status, "pending");
    assert.strictEqual(ins.body.coach_id, COACH_ID);
    assert.strictEqual(ins.body.athlete_id, ATHLETE_ID);
    const insDays = (new Date(ins.body.expires_at).getTime() - Date.now()) / 86400000;
    assert.ok(insDays > 13.5 && insDays < 14.5, "inserted expiry is ~14 days");
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 7b. the returned url path shape matches the registered /book/:token route:
//     mint via /send-invite, then GET the returned url's pathname through the
//     app and expect 200 (book.html served). Proves the link is not a dead
//     /book?token= query form.
// ===========================================================================

test("POST /send-invite returns a url whose path the /book/:token route serves 200", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      test: (u) => u.includes("/auth/v1/user"),
      reply: () => ok({ id: COACH_ID, user_metadata: { role: "coach" } }),
    },
    {
      test: (u, m) => u.includes("/athletes") && m === "GET",
      reply: () => ok([{ id: ATHLETE_ID }]),
    },
    {
      test: (u, m) => u.includes("/booking_invites") && m === "POST",
      reply: (u, m, opts) => ok([{ token: NEW_INVITE_TOKEN, ...JSON.parse(opts.body) }]),
    },
  ]);
  try {
    const mint = await request(port, {
      method: "POST",
      path: "/send-invite",
      headers: { authorization: "Bearer coach-jwt" },
      body: JSON.stringify({ athlete_id: ATHLETE_ID }),
    });
    assert.strictEqual(mint.status, 201);

    // The url is the PATH form, not the dead query form.
    assert.match(mint.json.url, /\/book\/[^/?]+$/, "url is the /book/:token path form");
    assert.ok(!mint.json.url.includes("?token="), "no dead ?token= query form");

    // The pathname round-trips through the actual registered route.
    const pathname = new URL(mint.json.url).pathname;
    const page = await request(port, { method: "GET", path: pathname });
    assert.strictEqual(page.status, 200, "the /book/:token route serves the booking page");
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 8. an athlete-role caller cannot mint invites -> 403, nothing inserted
// ===========================================================================

test("POST /send-invite rejects an athlete-role caller with 403", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      test: (u) => u.includes("/auth/v1/user"),
      reply: () => ok({ id: ATHLETE_ID, user_metadata: { role: "athlete" } }),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/send-invite",
      headers: { authorization: "Bearer athlete-jwt" },
      body: JSON.stringify({ athlete_id: ATHLETE_ID }),
    });
    assert.strictEqual(res.status, 403);
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/booking_invites") && c.method === "POST"),
      "no invite is minted for a non-coach caller",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 9. a coach cannot invite another coach's athlete (cross-tenant) -> 403
// ===========================================================================

test("POST /send-invite rejects a cross-tenant athlete_id with 403", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      test: (u) => u.includes("/auth/v1/user"),
      reply: () => ok({ id: COACH_ID, user_metadata: { role: "coach" } }),
    },
    {
      // tenant check: the athlete is NOT in this coach's roster -> empty.
      test: (u, m) => u.includes("/athletes") && m === "GET",
      reply: () => ok([]),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/send-invite",
      headers: { authorization: "Bearer coach-jwt" },
      body: JSON.stringify({ athlete_id: ATHLETE_ID }),
    });
    assert.strictEqual(res.status, 403);
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/booking_invites") && c.method === "POST"),
      "no invite is minted for a cross-tenant athlete",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 9b. a coach cannot pre-assign another coach's slot (cross-tenant) -> 403
// ===========================================================================

test("POST /send-invite rejects a cross-tenant slot_id with 403 cross_tenant", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      test: (u) => u.includes("/auth/v1/user"),
      reply: () => ok({ id: COACH_ID, user_metadata: { role: "coach" } }),
    },
    {
      // the athlete IS in this coach's roster (isolates the slot check).
      test: (u, m) => u.includes("/athletes") && m === "GET",
      reply: () => ok([{ id: ATHLETE_ID }]),
    },
    {
      // slot ownership check: the slot is NOT this coach's -> empty.
      test: (u, m) => u.includes("/bookable_slots") && m === "GET",
      reply: () => ok([]),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/send-invite",
      headers: { authorization: "Bearer coach-jwt" },
      body: JSON.stringify({ athlete_id: ATHLETE_ID, slot_id: SLOT_ID }),
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.json.error, "cross_tenant");
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/booking_invites") && c.method === "POST"),
      "no invite is minted for a cross-tenant slot",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 10. the minted invite is usable by the real lookupInvite/inviteUsable path:
//     mint via /send-invite, then load it through GET /schedule (which calls
//     lookupInvite + inviteUsable) -> 200. A stateful mock round-trips the row.
// ===========================================================================

test("POST /send-invite mints an invite GET /schedule accepts as usable", async () => {
  const { server, port } = await startServer();
  let storedInvite = null;
  const mock = installFetchMock([
    {
      test: (u) => u.includes("/auth/v1/user"),
      reply: () => ok({ id: COACH_ID, user_metadata: { role: "coach" } }),
    },
    {
      test: (u, m) => u.includes("/athletes") && m === "GET",
      reply: () => ok([{ id: ATHLETE_ID }]),
    },
    {
      // mint: persist the inserted row (with the DB-minted token) into the store.
      test: (u, m) => u.includes("/booking_invites") && m === "POST",
      reply: (u, m, opts) => {
        const b = JSON.parse(opts.body);
        storedInvite = {
          token: NEW_INVITE_TOKEN,
          ...b,
          coaches: { full_name: "Coach CJ" },
          athletes: { name: "Athlete A", parent_email: null },
        };
        return ok([{ token: NEW_INVITE_TOKEN, ...b }]);
      },
    },
    {
      // lookupInvite reads the stored row back -> proves it flows the real path.
      test: (u, m) => u.includes("/booking_invites") && m === "GET",
      reply: () => ok(storedInvite ? [storedInvite] : []),
    },
    {
      // getSchedule slot list + credit balance (empty is fine for this proof).
      test: (u, m) => u.includes("/bookable_slots") && m === "GET",
      reply: () => ok([]),
    },
    {
      test: (u, m) => u.includes("/package_purchases") && m === "GET",
      reply: () => ok([]),
    },
  ]);
  try {
    const mint = await request(port, {
      method: "POST",
      path: "/send-invite",
      headers: { authorization: "Bearer coach-jwt" },
      body: JSON.stringify({ athlete_id: ATHLETE_ID }),
    });
    assert.strictEqual(mint.status, 201);
    const token = mint.json.token;

    // Load it through the real invite path. A 200 means inviteUsable accepted the
    // freshly minted (pending, 14-day) row that lookupInvite returned.
    const sched = await request(port, { method: "GET", path: `/schedule/${token}` });
    assert.strictEqual(sched.status, 200, "the minted invite is usable, not expired/consumed");
    assert.strictEqual(sched.json.athleteId, ATHLETE_ID);
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 11. POST /coach/bookings/cancel happy path: booked slot with a deduct ->
//     200 refunded true, credits_remaining bumped, refund ledger row, slot
//     flipped to 'cancelled'.
// ===========================================================================

test("POST /coach/bookings/cancel refunds and cancels a booked slot -> 200 refunded true", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      // coach JWT -> a coach-role user.
      test: (u) => u.includes("/auth/v1/user"),
      reply: () => ok({ id: COACH_ID, user_metadata: { role: "coach" } }),
    },
    {
      // tenant + state read: the coach owns this slot and it's booked.
      test: (u, m) =>
        u.includes("/bookable_slots") && u.includes(`id=eq.${SLOT_ID}`) && m === "GET",
      reply: () =>
        ok([{ id: SLOT_ID, coach_id: COACH_ID, status: "booked", booked_by: ATHLETE_ID }]),
    },
    {
      // cancel gate: flip booked -> cancelled, 1 row.
      test: (u, m) =>
        u.includes("/bookable_slots") && u.includes("status=eq.booked") && m === "PATCH",
      reply: () => ok([{ id: SLOT_ID, status: "cancelled", starts_at: FUTURE, ends_at: FUTURE }]),
    },
    {
      // originating deduct ledger row -> names the source purchase.
      test: (u, m) =>
        u.includes("/credit_deductions") && u.includes("action=eq.deduct") && m === "GET",
      reply: () => ok([{ purchase_id: PURCHASE_ID, coach_id: COACH_ID }]),
    },
    {
      // the source purchase: exhausted by this booking.
      test: (u, m) =>
        u.includes("/package_purchases") && u.includes(`id=eq.${PURCHASE_ID}`) && m === "GET",
      reply: () =>
        ok([{ id: PURCHASE_ID, credits_remaining: 0, credits_total: 5, status: "exhausted" }]),
    },
    {
      // final balance re-sum after refund.
      test: (u, m) =>
        u.includes("/package_purchases") && u.includes("status=eq.active") && m === "GET",
      reply: () => ok([{ credits_remaining: 1 }]),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/coach/bookings/cancel",
      headers: { authorization: "Bearer coach-jwt" },
      body: JSON.stringify({ slot_id: SLOT_ID }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.refunded, true, "a credit was refunded");
    assert.strictEqual(res.json.credits_remaining, 1, "the athlete balance was re-summed");
    assert.strictEqual(res.json.slot.status, "cancelled", "the slot was flipped to cancelled");

    // The slot flip cleared booked_by/booked_at.
    const flip = mock.calls.find(
      (c) => c.u.includes("/bookable_slots") && c.method === "PATCH",
    );
    assert.ok(flip, "the slot was PATCHed");
    assert.strictEqual(flip.body.status, "cancelled");
    assert.strictEqual(flip.body.booked_by, null);

    // The source purchase was bumped back to 1 and reactivated.
    const bump = mock.calls.find(
      (c) =>
        c.u.includes("/package_purchases") &&
        c.u.includes(`id=eq.${PURCHASE_ID}`) &&
        c.method === "PATCH",
    );
    assert.ok(bump, "the source purchase was PATCHed");
    assert.strictEqual(bump.body.credits_remaining, 1);
    assert.strictEqual(bump.body.status, "active", "exhausted pack reactivated");

    // A refund ledger row was appended against the source purchase.
    const refund = mock.calls.find(
      (c) =>
        c.u.includes("/credit_deductions") &&
        c.method === "POST" &&
        c.body &&
        c.body.action === "refund",
    );
    assert.ok(refund, "a refund ledger row was appended");
    assert.strictEqual(refund.body.purchase_id, PURCHASE_ID);
    assert.strictEqual(refund.body.amount, 1);
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 12. an athlete-role caller cannot coach-cancel -> 403, slot never touched
// ===========================================================================

test("POST /coach/bookings/cancel rejects an athlete-role caller with 403", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      test: (u) => u.includes("/auth/v1/user"),
      reply: () => ok({ id: ATHLETE_ID, user_metadata: { role: "athlete" } }),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/coach/bookings/cancel",
      headers: { authorization: "Bearer athlete-jwt" },
      body: JSON.stringify({ slot_id: SLOT_ID }),
    });
    assert.strictEqual(res.status, 403);
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/bookable_slots") && c.method === "PATCH"),
      "no slot is cancelled for a non-coach caller",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 13. a coach cannot cancel another coach's slot (cross-tenant) -> 403
// ===========================================================================

test("POST /coach/bookings/cancel rejects a cross-tenant slot with 403 cross_tenant", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      test: (u) => u.includes("/auth/v1/user"),
      reply: () => ok({ id: COACH_ID, user_metadata: { role: "coach" } }),
    },
    {
      // scoped read finds nothing: the slot is not this coach's.
      test: (u, m) =>
        u.includes("/bookable_slots") && u.includes(`id=eq.${SLOT_ID}`) && m === "GET",
      reply: () => ok([]),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/coach/bookings/cancel",
      headers: { authorization: "Bearer coach-jwt" },
      body: JSON.stringify({ slot_id: SLOT_ID }),
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.json.error, "cross_tenant");
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/bookable_slots") && c.method === "PATCH"),
      "a cross-tenant slot is never cancelled",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 14. an unbooked (open) slot -> 409 not_booked, nothing refunded
// ===========================================================================

test("POST /coach/bookings/cancel returns 409 not_booked for a slot that is not booked", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      test: (u) => u.includes("/auth/v1/user"),
      reply: () => ok({ id: COACH_ID, user_metadata: { role: "coach" } }),
    },
    {
      // the coach owns the slot, but it's open, not booked.
      test: (u, m) =>
        u.includes("/bookable_slots") && u.includes(`id=eq.${SLOT_ID}`) && m === "GET",
      reply: () => ok([{ id: SLOT_ID, coach_id: COACH_ID, status: "open", booked_by: null }]),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/coach/bookings/cancel",
      headers: { authorization: "Bearer coach-jwt" },
      body: JSON.stringify({ slot_id: SLOT_ID }),
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.json.error, "not_booked");
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/bookable_slots") && c.method === "PATCH"),
      "an unbooked slot is never flipped",
    );
    assert.ok(
      !mock.calls.some(
        (c) =>
          c.u.includes("/credit_deductions") &&
          c.method === "POST" &&
          c.body &&
          c.body.action === "refund",
      ),
      "nothing is refunded when the slot was not booked",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 15. a booked slot with NO deduct to reverse -> 200 refunded false,
//     credits_remaining null (zero-credit legacy booking).
// ===========================================================================

test("POST /coach/bookings/cancel on a no-deduct booking -> 200 refunded false, credits_remaining null", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      test: (u) => u.includes("/auth/v1/user"),
      reply: () => ok({ id: COACH_ID, user_metadata: { role: "coach" } }),
    },
    {
      test: (u, m) =>
        u.includes("/bookable_slots") && u.includes(`id=eq.${SLOT_ID}`) && m === "GET",
      reply: () =>
        ok([{ id: SLOT_ID, coach_id: COACH_ID, status: "booked", booked_by: ATHLETE_ID }]),
    },
    {
      test: (u, m) =>
        u.includes("/bookable_slots") && u.includes("status=eq.booked") && m === "PATCH",
      reply: () => ok([{ id: SLOT_ID, status: "cancelled", starts_at: FUTURE, ends_at: FUTURE }]),
    },
    {
      // no deduct ledger row exists for this slot -> nothing to refund.
      test: (u, m) =>
        u.includes("/credit_deductions") && u.includes("action=eq.deduct") && m === "GET",
      reply: () => ok([]),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/coach/bookings/cancel",
      headers: { authorization: "Bearer coach-jwt" },
      body: JSON.stringify({ slot_id: SLOT_ID }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.refunded, false, "no deduct means no refund");
    assert.strictEqual(res.json.credits_remaining, null, "credits_remaining is null with no refund");
    assert.strictEqual(res.json.slot.status, "cancelled", "the slot is still cancelled");
    assert.ok(
      !mock.calls.some(
        (c) =>
          c.u.includes("/credit_deductions") &&
          c.method === "POST" &&
          c.body &&
          c.body.action === "refund",
      ),
      "no refund ledger row is appended when there was no deduct",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// D19 CLAIM-AT-BOOKING TOUCHPOINT (progressive accounts)
// ===========================================================================
//
// A successful booking of an UNCLAIMED athlete (athletes.user_id null) offers the
// account: reuse-or-mint an athlete_claims row and thread the /claim link into
// both the JSON response (claim_url) and the confirmation email. A CLAIMED athlete
// gets neither. These share a full happy-path booking mock; `athleteUserId` toggles
// claimed vs unclaimed and `reusableClaim` toggles reuse vs fresh mint.
function fullBookingRoutes({ athleteUserId = null, reusableClaim = null } = {}) {
  return [
    {
      test: (u, m) => u.includes("/booking_invites") && m === "GET",
      reply: () =>
        ok([
          {
            token: UUID_A,
            coach_id: COACH_ID,
            athlete_id: ATHLETE_ID,
            slot_id: null,
            email: "parent@example.com",
            status: "pending",
            expires_at: FUTURE,
            coaches: { full_name: "Coach CJ" },
            athletes: {
              name: "Athlete A",
              parent_email: "parent@example.com",
              user_id: athleteUserId,
            },
          },
        ]),
    },
    {
      // FIFO source query (carries credits_remaining=gt.0): the purchase to spend.
      test: (u, m) =>
        u.includes("/package_purchases") && u.includes("credits_remaining=gt.0") && m === "GET",
      reply: () => ok([{ id: PURCHASE_ID, credits_remaining: 3, coach_id: COACH_ID }]),
    },
    {
      // Credit balance (precheck + final re-sum): active purchases only.
      test: (u, m) =>
        u.includes("/package_purchases") && u.includes("status=eq.active") && m === "GET",
      reply: () => ok([{ credits_remaining: 3 }]),
    },
    {
      // Slot claim open -> booked: 1 row won.
      test: (u, m) =>
        u.includes("/bookable_slots") && u.includes("status=eq.open") && m === "PATCH",
      reply: () =>
        ok([{ id: SLOT_ID, status: "booked", starts_at: FUTURE, ends_at: FUTURE, title: "Session" }]),
    },
    {
      // FIFO decrement PATCH: won the optimistic race on the source purchase.
      test: (u, m) => u.includes("/package_purchases") && m === "PATCH",
      reply: () => ok([{ id: PURCHASE_ID }]),
    },
    {
      test: (u, m) => u.includes("/sessions") && m === "POST",
      reply: () => ok([{ id: "99999999-9999-4999-8999-999999999999" }]),
    },
    {
      // Claim reuse lookup: an unexpired unclaimed row, or none (=> mint).
      test: (u, m) => u.includes("/athlete_claims") && m === "GET",
      reply: () => ok(reusableClaim ? [{ token: reusableClaim }] : []),
    },
    {
      // Claim mint.
      test: (u, m) => u.includes("/athlete_claims") && m === "POST",
      reply: () => ok([{ token: CLAIM_TOKEN }]),
    },
  ];
}

test("book success for an UNCLAIMED athlete returns claim_url and mints a claim row", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock(fullBookingRoutes({ athleteUserId: null }));
  try {
    const res = await request(port, {
      method: "POST",
      path: `/schedule/${UUID_A}/book`,
      body: JSON.stringify({ slotId: SLOT_ID }),
    });
    assert.strictEqual(res.status, 200);
    assert.ok(
      typeof res.json.claim_url === "string" &&
        res.json.claim_url.endsWith(`/claim/${CLAIM_TOKEN}`),
      "the response carries the athlete's claim URL",
    );
    // A claim row was minted (no reusable one existed).
    assert.ok(
      mock.calls.some((c) => c.u.includes("/athlete_claims") && c.method === "POST"),
      "a fresh claim row was minted",
    );
    // The mint carried the coach + athlete, byte-identical to the coach-side mint.
    const mint = mock.calls.find((c) => c.u.includes("/athlete_claims") && c.method === "POST");
    assert.strictEqual(mint.body.coach_id, COACH_ID);
    assert.strictEqual(mint.body.athlete_id, ATHLETE_ID);
  } finally {
    mock.restore();
    server.close();
  }
});

test("book success for a CLAIMED athlete returns no claim_url and touches no claim row", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock(fullBookingRoutes({ athleteUserId: AUTH_ID }));
  try {
    const res = await request(port, {
      method: "POST",
      path: `/schedule/${UUID_A}/book`,
      body: JSON.stringify({ slotId: SLOT_ID }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.claim_url, null, "a claimed athlete gets no claim URL");
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/athlete_claims")),
      "the claim table is never touched for a claimed athlete",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

test("book success reuses an existing unclaimed claim instead of minting a duplicate", async () => {
  const { server, port } = await startServer();
  const REUSE = "12121212-1212-4121-8121-121212121212";
  const mock = installFetchMock(fullBookingRoutes({ athleteUserId: null, reusableClaim: REUSE }));
  try {
    const res = await request(port, {
      method: "POST",
      path: `/schedule/${UUID_A}/book`,
      body: JSON.stringify({ slotId: SLOT_ID }),
    });
    assert.strictEqual(res.status, 200);
    assert.ok(
      res.json.claim_url.endsWith(`/claim/${REUSE}`),
      "the response reuses the existing claim token",
    );
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/athlete_claims") && c.method === "POST"),
      "no duplicate claim row is minted when a reusable one exists",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

test("the booking confirmation email carries the claim link only when one exists", () => {
  const start = new Date("2026-07-24T21:00:00.000Z");
  const withClaim = bookingEmailHtml({
    athleteName: "Athlete A",
    coachName: "Coach CJ",
    start,
    gcal: "https://calendar.google.com/x",
    bookUrl: "https://coachtime.app/book/abc",
    claimUrl: "https://coachtime.app/claim/" + CLAIM_TOKEN,
  });
  assert.ok(
    withClaim.includes("/claim/" + CLAIM_TOKEN),
    "the claim link is rendered as a secondary CTA under the calendar button",
  );

  const withoutClaim = bookingEmailHtml({
    athleteName: "Athlete A",
    coachName: "Coach CJ",
    start,
    gcal: "https://calendar.google.com/x",
    bookUrl: "https://coachtime.app/book/abc",
    claimUrl: null,
  });
  assert.ok(
    !withoutClaim.includes("/claim/"),
    "a claimed athlete's email has no portal link",
  );
});
