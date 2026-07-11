// Storefront ENDPOINT unit tests (public coach page + zero-friction guest
// booking) plus the invite-lane session-type additions. No network, no live
// creds; env is set BEFORE requiring index.js so the module boots in test mode
// with SCHEDULING_ENABLED on. STRIPE_* / RESEND stay unset (email is a no-op).

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
    if (payload && !h["content-type"] && !h["Content-Type"]) h["content-type"] = "application/json";
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: h },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            json: (() => { try { return JSON.parse(data); } catch { return null; } })(),
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
  return { calls, restore() { global.fetch = realFetch; } };
}
function ok(json) { return { ok: true, status: 200, json: async () => json, text: async () => "" }; }

const SLUG = "cjbennett";
const COACH_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_COACH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SLOT_ID = "22222222-2222-4222-8222-222222222222";
const ATHLETE_ID = "44444444-4444-4444-8444-444444444444";
const TYPE_ID = "55555555-5555-4555-8555-555555555555";
const CLAIM_TOKEN = "77777777-7777-4777-8777-777777777777";
const INVITE_TOKEN = "11111111-1111-4111-8111-111111111111";
const FUTURE = new Date(Date.now() + 14 * 86400000).toISOString();

function coachRow() {
  return {
    id: COACH_ID,
    full_name: "Coach CJ",
    business: "QB Stable",
    disciplines: ["Quarterback"],
    bio: "Former player turned coach.",
    city: "Tampa, FL",
  };
}

// ===========================================================================
// 1. Unknown slug -> 404 on both the page and the data route
// ===========================================================================

test("GET /coach/:slug 404s for an unknown slug (flag on)", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && m === "GET", reply: () => ok([]) },
  ]);
  try {
    const res = await request(port, { path: `/coach/${SLUG}` });
    assert.strictEqual(res.status, 404, "an unknown coach handle is a real 404");
  } finally {
    mock.restore();
    server.close();
  }
});

test("GET /coach/:slug/data 404s for an unknown slug", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && m === "GET", reply: () => ok([]) },
  ]);
  try {
    const res = await request(port, { path: `/coach/${SLUG}/data` });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.json.error, "not found");
  } finally {
    mock.restore();
    server.close();
  }
});

test("GET /coach/:slug serves the storefront HTML for a known coach", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && m === "GET", reply: () => ok([coachRow()]) },
  ]);
  try {
    const res = await request(port, { path: `/coach/${SLUG}` });
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Scan to book/, "the coach.html storefront page is served");
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 2. /data returns ONLY sanitized fields (no email / phone / keys / coach id)
// ===========================================================================

test("GET /coach/:slug/data returns sanitized public fields only", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && m === "GET", reply: () => ok([coachRow()]) },
    {
      test: (u, m) => u.includes("/session_types") && m === "GET",
      reply: () => ok([{ id: TYPE_ID, name: "Private", duration_min: 60, price_cents: 6000, description: "1:1" }]),
    },
    {
      test: (u, m) => u.includes("/bookable_slots") && m === "GET",
      reply: () => ok([{ id: SLOT_ID, starts_at: FUTURE, ends_at: FUTURE, timezone: "America/New_York", title: "QB session" }]),
    },
  ]);
  try {
    const res = await request(port, { path: `/coach/${SLUG}/data` });
    assert.strictEqual(res.status, 200);
    // Coach block carries only the public fields.
    assert.deepStrictEqual(Object.keys(res.json.coach).sort(), ["bio", "business", "city", "disciplines", "name"]);
    assert.strictEqual(res.json.coach.name, "Coach CJ");
    assert.strictEqual(res.json.coach.id, undefined, "the coach id is never exposed");
    // No leaked contact/keys anywhere in the payload.
    assert.ok(!res.text.includes("parent_email"), "no email field leaks");
    assert.ok(!res.text.toLowerCase().includes("phone"), "no phone leaks");
    assert.ok(!res.text.includes("service"), "no service key leaks");
    assert.ok(Array.isArray(res.json.session_types) && res.json.session_types.length === 1);
    assert.ok(Array.isArray(res.json.open_slots) && res.json.open_slots.length === 1);
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 3. book-guest happy path: creates the athlete, books the slot with the type,
//    burns NO credit, mints a claim, returns { booked, claim_url }
// ===========================================================================

function guestHappyRoutes({ athleteMatch = null, reusableClaim = null } = {}) {
  return [
    { test: (u, m) => u.includes("/coaches") && m === "GET", reply: () => ok([coachRow()]) },
    // resolveSessionType (id=eq.) — must be BEFORE any broad session_types route.
    {
      test: (u, m) => u.includes("/session_types") && u.includes("id=eq.") && m === "GET",
      reply: () => ok([{ id: TYPE_ID }]),
    },
    // athlete match in THIS tenant.
    {
      test: (u, m) => u.includes("/athletes") && m === "GET",
      reply: () => ok(athleteMatch ? [athleteMatch] : []),
    },
    // create athlete card.
    { test: (u, m) => u.includes("/athletes") && m === "POST", reply: () => ok([{ id: ATHLETE_ID }]) },
    // slot claim open -> booked.
    {
      test: (u, m) => u.includes("/bookable_slots") && u.includes("status=eq.open") && m === "PATCH",
      reply: () => ok([{ id: SLOT_ID, status: "booked", starts_at: FUTURE, ends_at: FUTURE, title: "QB session" }]),
    },
    { test: (u, m) => u.includes("/sessions") && m === "POST", reply: () => ok([{ id: "99999999-9999-4999-8999-999999999999" }]) },
    { test: (u, m) => u.includes("/athlete_claims") && m === "GET", reply: () => ok(reusableClaim ? [{ token: reusableClaim }] : []) },
    { test: (u, m) => u.includes("/athlete_claims") && m === "POST", reply: () => ok([{ token: CLAIM_TOKEN }]) },
  ];
}

test("POST /coach/:slug/book-guest creates the athlete, books with the type, burns no credit, mints a claim", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock(guestHappyRoutes());
  try {
    const res = await request(port, {
      method: "POST",
      path: `/coach/${SLUG}/book-guest`,
      body: JSON.stringify({ slot_id: SLOT_ID, session_type_id: TYPE_ID, name: "Jordan Parent", email: "Parent@Example.com" }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.booked, true);
    assert.ok(
      typeof res.json.claim_url === "string" && res.json.claim_url.endsWith(`/claim/${CLAIM_TOKEN}`),
      "a claim URL is minted for the new lead",
    );

    // The athlete card was created in THIS tenant, email lowercased.
    const athIns = mock.calls.find((c) => c.u.includes("/athletes") && c.method === "POST");
    assert.ok(athIns, "an athlete card was created");
    assert.strictEqual(athIns.body.coach_id, COACH_ID);
    assert.strictEqual(athIns.body.parent_email, "parent@example.com", "email normalized to lowercase");

    // The slot was claimed with the chosen type + the new athlete.
    const claim = mock.calls.find(
      (c) => c.u.includes("/bookable_slots") && c.method === "PATCH" && c.u.includes("status=eq.open"),
    );
    assert.ok(claim, "the slot was claimed");
    assert.strictEqual(claim.body.status, "booked");
    assert.strictEqual(claim.body.booked_by, ATHLETE_ID);
    assert.strictEqual(claim.body.session_type_id, TYPE_ID, "the chosen session type is stored on the slot");

    // ZERO credit machinery: the guest lane never touches purchases or the ledger.
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/package_purchases")),
      "no purchase is read or written — a new lead never hits a paywall",
    );
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/credit_deductions")),
      "no credit is deducted for a guest booking",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 4. book-guest matches an existing in-tenant athlete by CASE-INSENSITIVE email;
//    a cross-tenant same-email athlete must NOT link (a fresh card is created).
// ===========================================================================

test("book-guest reuses an in-tenant athlete matched case-insensitively (no new card)", async () => {
  const { server, port } = await startServer();
  // Matched + already claimed -> no claim minted, no new athlete created.
  const mock = installFetchMock(
    guestHappyRoutes({ athleteMatch: { id: ATHLETE_ID, user_id: "auth-user-1" } }),
  );
  try {
    const res = await request(port, {
      method: "POST",
      path: `/coach/${SLUG}/book-guest`,
      body: JSON.stringify({ slot_id: SLOT_ID, name: "Jordan", email: "MATCH@Example.com" }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.claim_url, null, "a claimed athlete gets no claim URL");

    // The match query was scoped to THIS coach and the lowercased email.
    const athGet = mock.calls.find((c) => c.u.includes("/athletes") && c.method === "GET");
    assert.ok(athGet, "an athlete match query ran");
    assert.ok(athGet.u.includes(`coach_id=eq.${COACH_ID}`), "the match is tenant-scoped");
    assert.ok(
      athGet.u.toLowerCase().includes(encodeURIComponent("match@example.com")),
      "the match uses the lowercased email",
    );
    // Matched -> the slot is booked_by the matched athlete, no new card created.
    assert.ok(!mock.calls.some((c) => c.u.includes("/athletes") && c.method === "POST"), "a matched athlete is reused");
    const claim = mock.calls.find((c) => c.u.includes("/bookable_slots") && c.method === "PATCH" && c.u.includes("status=eq.open"));
    assert.strictEqual(claim.body.booked_by, ATHLETE_ID);
  } finally {
    mock.restore();
    server.close();
  }
});

test("book-guest does NOT link a same-email athlete from another tenant (creates a fresh card)", async () => {
  const { server, port } = await startServer();
  // The match query is scoped to COACH_ID; the only athlete with this email lives
  // under OTHER_COACH, so this coach's query returns empty and a fresh card is made.
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && m === "GET", reply: () => ok([coachRow()]) },
    {
      // Return a row ONLY if the query were scoped to the OTHER coach (it never is).
      test: (u, m) => u.includes("/athletes") && m === "GET",
      reply: (u) =>
        ok(u.includes(`coach_id=eq.${OTHER_COACH}`) ? [{ id: "cross-tenant-id", user_id: null }] : []),
    },
    { test: (u, m) => u.includes("/athletes") && m === "POST", reply: () => ok([{ id: ATHLETE_ID }]) },
    {
      test: (u, m) => u.includes("/bookable_slots") && u.includes("status=eq.open") && m === "PATCH",
      reply: () => ok([{ id: SLOT_ID, status: "booked", starts_at: FUTURE, ends_at: FUTURE }]),
    },
    { test: (u, m) => u.includes("/athlete_claims") && m === "GET", reply: () => ok([]) },
    { test: (u, m) => u.includes("/athlete_claims") && m === "POST", reply: () => ok([{ token: CLAIM_TOKEN }]) },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: `/coach/${SLUG}/book-guest`,
      body: JSON.stringify({ slot_id: SLOT_ID, name: "Jordan", email: "shared@example.com" }),
    });
    assert.strictEqual(res.status, 200);
    // A fresh card was created in THIS tenant; the cross-tenant athlete never linked.
    const athIns = mock.calls.find((c) => c.u.includes("/athletes") && c.method === "POST");
    assert.ok(athIns, "a fresh in-tenant card was created");
    assert.strictEqual(athIns.body.coach_id, COACH_ID);
    const claim = mock.calls.find((c) => c.u.includes("/bookable_slots") && c.method === "PATCH" && c.u.includes("status=eq.open"));
    assert.strictEqual(claim.body.booked_by, ATHLETE_ID, "booked by the fresh in-tenant card, never the cross-tenant one");
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 5. Double-book race -> 409 slot_unavailable, no session/claim after
// ===========================================================================

test("POST /coach/:slug/book-guest returns 409 when the slot was just taken", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/coaches") && m === "GET", reply: () => ok([coachRow()]) },
    { test: (u, m) => u.includes("/athletes") && m === "GET", reply: () => ok([]) },
    { test: (u, m) => u.includes("/athletes") && m === "POST", reply: () => ok([{ id: ATHLETE_ID }]) },
    // The claim loses the race: 0 rows updated.
    {
      test: (u, m) => u.includes("/bookable_slots") && u.includes("status=eq.open") && m === "PATCH",
      reply: () => ok([]),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: `/coach/${SLUG}/book-guest`,
      body: JSON.stringify({ slot_id: SLOT_ID, name: "Jordan", email: "race@example.com" }),
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.json.error, "slot_unavailable");
    assert.ok(!mock.calls.some((c) => c.u.includes("/sessions") && c.method === "POST"), "no film session on a lost race");
    assert.ok(!mock.calls.some((c) => c.u.includes("/athlete_claims")), "no claim minted on a lost race");
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 6. book-guest validation: missing name / bad email / bad slot -> 400
// ===========================================================================

test("POST /coach/:slug/book-guest rejects a bad email with 400", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([]);
  try {
    const res = await request(port, {
      method: "POST",
      path: `/coach/${SLUG}/book-guest`,
      body: JSON.stringify({ slot_id: SLOT_ID, name: "Jordan", email: "not-an-email" }),
    });
    assert.strictEqual(res.status, 400);
    assert.ok(!mock.calls.some((c) => c.u.includes("/bookable_slots")), "nothing is booked on a validation failure");
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 7. INVITE LANE: /schedule now carries the coach's active session types, and
//    booking stores the chosen type on the slot.
// ===========================================================================

function inviteRow() {
  return {
    token: INVITE_TOKEN,
    coach_id: COACH_ID,
    athlete_id: ATHLETE_ID,
    slot_id: null,
    email: "parent@example.com",
    status: "pending",
    expires_at: FUTURE,
    coaches: { full_name: "Coach CJ" },
    athletes: { name: "Athlete A", parent_email: "parent@example.com", user_id: "auth-user-1" },
  };
}

test("GET /schedule/:token returns the coach's active session types", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/booking_invites") && m === "GET", reply: () => ok([inviteRow()]) },
    { test: (u, m) => u.includes("/bookable_slots") && m === "GET", reply: () => ok([]) },
    {
      test: (u, m) => u.includes("/session_types") && m === "GET",
      reply: () => ok([{ id: TYPE_ID, name: "Private", duration_min: 60, price_cents: 6000, description: null }]),
    },
    { test: (u, m) => u.includes("/package_purchases") && m === "GET", reply: () => ok([]) },
  ]);
  try {
    const res = await request(port, { path: `/schedule/${INVITE_TOKEN}` });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.json.session_types), "session_types is present on the payload");
    assert.strictEqual(res.json.session_types.length, 1);
    assert.strictEqual(res.json.session_types[0].id, TYPE_ID);
  } finally {
    mock.restore();
    server.close();
  }
});

test("GET /schedule/:token with no types returns an empty session_types array", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/booking_invites") && m === "GET", reply: () => ok([inviteRow()]) },
    { test: (u, m) => u.includes("/bookable_slots") && m === "GET", reply: () => ok([]) },
    { test: (u, m) => u.includes("/session_types") && m === "GET", reply: () => ok([]) },
    { test: (u, m) => u.includes("/package_purchases") && m === "GET", reply: () => ok([]) },
  ]);
  try {
    const res = await request(port, { path: `/schedule/${INVITE_TOKEN}` });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.session_types, [], "no types -> empty array (book.html skips the type step)");
  } finally {
    mock.restore();
    server.close();
  }
});

// Full invite booking mock (unclaimed athlete gets a claim), parametrized by
// whether a session type was chosen so we can assert both storage cases.
function inviteBookingRoutes() {
  return [
    {
      test: (u, m) => u.includes("/booking_invites") && m === "GET",
      reply: () => ok([{ ...inviteRow(), athletes: { name: "Athlete A", parent_email: "parent@example.com", user_id: null } }]),
    },
    // resolveSessionType (id=eq.) BEFORE the credit-balance package query.
    { test: (u, m) => u.includes("/session_types") && u.includes("id=eq.") && m === "GET", reply: () => ok([{ id: TYPE_ID }]) },
    { test: (u, m) => u.includes("/package_purchases") && u.includes("credits_remaining=gt.0") && m === "GET", reply: () => ok([{ id: "p1", credits_remaining: 3, coach_id: COACH_ID }]) },
    { test: (u, m) => u.includes("/package_purchases") && u.includes("status=eq.active") && m === "GET", reply: () => ok([{ credits_remaining: 3 }]) },
    { test: (u, m) => u.includes("/bookable_slots") && u.includes("status=eq.open") && m === "PATCH", reply: () => ok([{ id: SLOT_ID, status: "booked", starts_at: FUTURE, ends_at: FUTURE, title: "Session" }]) },
    { test: (u, m) => u.includes("/package_purchases") && m === "PATCH", reply: () => ok([{ id: "p1" }]) },
    { test: (u, m) => u.includes("/sessions") && m === "POST", reply: () => ok([{ id: "99999999-9999-4999-8999-999999999999" }]) },
    { test: (u, m) => u.includes("/athlete_claims") && m === "GET", reply: () => ok([]) },
    { test: (u, m) => u.includes("/athlete_claims") && m === "POST", reply: () => ok([{ token: CLAIM_TOKEN }]) },
  ];
}

test("POST /schedule/:token/book stores the chosen session type on the slot", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock(inviteBookingRoutes());
  try {
    const res = await request(port, {
      method: "POST",
      path: `/schedule/${INVITE_TOKEN}/book`,
      body: JSON.stringify({ slotId: SLOT_ID, session_type_id: TYPE_ID }),
    });
    assert.strictEqual(res.status, 200);
    const claim = mock.calls.find((c) => c.u.includes("/bookable_slots") && c.method === "PATCH" && c.u.includes("status=eq.open"));
    assert.ok(claim, "the slot was claimed");
    assert.strictEqual(claim.body.session_type_id, TYPE_ID, "the invite-lane booking stores the picked type");
  } finally {
    mock.restore();
    server.close();
  }
});

test("POST /schedule/:token/book with no type stores session_type_id null (flow unchanged)", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock(inviteBookingRoutes());
  try {
    const res = await request(port, {
      method: "POST",
      path: `/schedule/${INVITE_TOKEN}/book`,
      body: JSON.stringify({ slotId: SLOT_ID }),
    });
    assert.strictEqual(res.status, 200);
    const claim = mock.calls.find((c) => c.u.includes("/bookable_slots") && c.method === "PATCH" && c.u.includes("status=eq.open"));
    assert.strictEqual(claim.body.session_type_id, null, "no type chosen -> null, identical to before storefront");
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/session_types") && c.u.includes("id=eq.")),
      "no type lookup fires when none was requested",
    );
  } finally {
    mock.restore();
    server.close();
  }
});
