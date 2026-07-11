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
const { expandWindows } = require("../lib/scheduling.js");

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
