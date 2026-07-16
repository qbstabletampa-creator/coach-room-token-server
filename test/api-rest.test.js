// Open API REST surface tests (API_ENABLED ON). No network, no live creds:
// global.fetch is mocked to stand in for Supabase PostgREST, and each test FILE
// runs in its own process under `node --test`, so this env is isolated.
//
// Coverage (build brief chunk 7):
//   - minted key -> tenant-scoped 200 read
//   - no key -> 401
//   - revoked key -> 401
//   - cross-tenant id probe on GET /athletes/:id -> 404 (no data leak)
//   - cross-tenant id probe on PATCH /athletes/:id -> 404 (no write)
//   - foreign athlete write (create session) -> 403 cross_tenant
//   - audit_log row written on a key-authed call

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
process.env.API_ENABLED = "1";
delete process.env.RESEND_API_KEY;

const { app } = require("../index.js");

const COACH_ID = "33333333-3333-4333-8333-333333333333";
const KEY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ATHLETE_ID = "44444444-4444-4444-8444-444444444444";
const FOREIGN_ATHLETE = "55555555-5555-4555-8555-555555555555";
const VALID_KEY = "ctk_" + "a".repeat(64);

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
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers: h }, (res) => {
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
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Route Supabase REST calls; record every call so tests can assert what fired.
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

// A live (non-revoked) key row for requireApiKey. Matches the api_keys lookup.
function liveKeyRoute() {
  return {
    test: (u, m) => u.includes("/api_keys") && u.includes("key_hash=eq.") && m === "GET",
    reply: () =>
      ok([{ id: KEY_ID, coach_id: COACH_ID, rate_limit: 60, scopes: [] }]),
  };
}
// A revoked key -> the revoked_at=is.null filter excludes it -> empty.
function revokedKeyRoute() {
  return {
    test: (u, m) => u.includes("/api_keys") && u.includes("key_hash=eq.") && m === "GET",
    reply: () => ok([]),
  };
}

const authHdr = { authorization: `Bearer ${VALID_KEY}` };

// ===========================================================================
// 1. minted key -> tenant-scoped 200 read, filter carries coach_id
// ===========================================================================
test("GET /api/v1/athletes with a valid key returns a tenant-scoped 200", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    liveKeyRoute(),
    {
      test: (u, m) => u.includes("/athletes") && u.includes(`coach_id=eq.${COACH_ID}`) && m === "GET",
      reply: () => ok([{ id: ATHLETE_ID, coach_id: COACH_ID, name: "Athlete A" }]),
    },
  ]);
  try {
    const res = await request(port, { path: "/api/v1/athletes", headers: authHdr });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.json.athletes), "athletes array returned");
    assert.strictEqual(res.json.athletes[0].id, ATHLETE_ID);
    // The list query was tenant-locked to the key's coach.
    const listCall = mock.calls.find(
      (c) => c.u.includes("/athletes") && c.method === "GET" && c.u.includes("coach_id=eq."),
    );
    assert.ok(listCall, "a tenant-locked athletes query fired");
    assert.ok(listCall.u.includes(`coach_id=eq.${COACH_ID}`), "locked to the key's coach_id");
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 2. no key -> 401
// ===========================================================================
test("GET /api/v1/athletes with no key returns 401", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([liveKeyRoute()]);
  try {
    const res = await request(port, { path: "/api/v1/athletes" });
    assert.strictEqual(res.status, 401);
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/athletes") && c.method === "GET"),
      "no data query fires without a key",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 3. revoked key -> 401
// ===========================================================================
test("GET /api/v1/athletes with a revoked key returns 401", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([revokedKeyRoute()]);
  try {
    const res = await request(port, { path: "/api/v1/athletes", headers: authHdr });
    assert.strictEqual(res.status, 401);
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/athletes") && c.method === "GET"),
      "a revoked key reaches no data",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 4. cross-tenant id probe on GET /athletes/:id -> 404, not data
// ===========================================================================
test("GET /api/v1/athletes/:id for a foreign athlete returns 404 (no leak)", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    liveKeyRoute(),
    {
      // scoped read: foreign id + this coach -> empty (PostgREST filter did the work).
      test: (u, m) => u.includes("/athletes") && u.includes(`id=eq.${FOREIGN_ATHLETE}`) && m === "GET",
      reply: () => ok([]),
    },
  ]);
  try {
    const res = await request(port, { path: `/api/v1/athletes/${FOREIGN_ATHLETE}`, headers: authHdr });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.json.error, "not found");
    // The read was scoped to the key's coach_id (never a bare id lookup).
    const readCall = mock.calls.find(
      (c) => c.u.includes(`id=eq.${FOREIGN_ATHLETE}`) && c.method === "GET",
    );
    assert.ok(readCall.u.includes(`coach_id=eq.${COACH_ID}`), "the read is tenant-locked");
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 5. cross-tenant id probe on PATCH /athletes/:id -> 404, no write
// ===========================================================================
test("PATCH /api/v1/athletes/:id for a foreign athlete returns 404 and never writes", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    liveKeyRoute(),
    {
      // ownership pre-check finds nothing for this coach.
      test: (u, m) => u.includes("/athletes") && u.includes(`id=eq.${FOREIGN_ATHLETE}`) && m === "GET",
      reply: () => ok([]),
    },
  ]);
  try {
    const res = await request(port, {
      method: "PATCH",
      path: `/api/v1/athletes/${FOREIGN_ATHLETE}`,
      headers: authHdr,
      body: JSON.stringify({ name: "hacked" }),
    });
    assert.strictEqual(res.status, 404);
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/athletes") && c.method === "PATCH"),
      "no PATCH fires against a foreign athlete",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 6. foreign athlete write (create session) -> 403 cross_tenant, no insert
// ===========================================================================
test("POST /api/v1/sessions with a foreign athlete_id returns 403 cross_tenant", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    liveKeyRoute(),
    {
      // ownership check on the referenced athlete: not this coach's -> empty.
      test: (u, m) => u.includes("/athletes") && u.includes(`id=eq.${FOREIGN_ATHLETE}`) && m === "GET",
      reply: () => ok([]),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/api/v1/sessions",
      headers: authHdr,
      body: JSON.stringify({ athlete_id: FOREIGN_ATHLETE, title: "Sneaky session" }),
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.json.error, "cross_tenant");
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/sessions") && c.method === "POST"),
      "no session is inserted against a foreign athlete",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 7. audit_log row is written on a key-authed call
// ===========================================================================
test("a key-authed call writes an audit_log row (coach + status)", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    liveKeyRoute(),
    {
      test: (u, m) => u.includes("/athletes") && m === "GET",
      reply: () => ok([]),
    },
  ]);
  try {
    const res = await request(port, { path: "/api/v1/athletes", headers: authHdr });
    assert.strictEqual(res.status, 200);
    // Audit fires on res 'finish' (fire-and-forget); give it a beat to land.
    await new Promise((r) => setTimeout(r, 60));
    const audit = mock.calls.find((c) => c.u.includes("/audit_log") && c.method === "POST");
    assert.ok(audit, "an audit_log row was written");
    assert.strictEqual(audit.body.coach_id, COACH_ID, "audit row is scoped to the key's coach");
    assert.strictEqual(audit.body.status, 200, "audit row records the final status");
    assert.strictEqual(audit.body.method, "GET");
    assert.ok(audit.body.path.startsWith("/api/v1/athletes"), "audit records the path");
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 8. mint via /developer/keys returns the plaintext key ONCE
// ===========================================================================
test("POST /developer/keys mints a key and returns the plaintext once", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      test: (u) => u.includes("/auth/v1/user"),
      reply: () => ok({ id: COACH_ID, user_metadata: { role: "coach" } }),
    },
    {
      test: (u, m) => u.includes("/api_keys") && m === "POST",
      reply: (u, m, opts) => ok([{ id: KEY_ID, ...JSON.parse(opts.body), rate_limit: 60, scopes: [], created_at: new Date().toISOString() }]),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/developer/keys",
      headers: { authorization: "Bearer coach-jwt" },
      body: JSON.stringify({ name: "My AI" }),
    });
    assert.strictEqual(res.status, 201);
    assert.ok(typeof res.json.key === "string" && res.json.key.startsWith("ctk_"), "plaintext key returned once");
    assert.strictEqual(res.json.id, KEY_ID);
    // The stored row carried the sha256 hash, never the plaintext.
    const ins = mock.calls.find((c) => c.u.includes("/api_keys") && c.method === "POST");
    assert.ok(ins.body.key_hash && ins.body.key_hash.length === 64, "a sha256 hash was stored");
    assert.ok(!ins.body.key, "the plaintext key was never sent to storage");
    assert.strictEqual(ins.body.coach_id, COACH_ID, "the key is bound to the authed coach");
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 9. an athlete-role caller cannot mint a key -> 403
// ===========================================================================
test("POST /developer/keys rejects a non-coach caller with 403", async () => {
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
      path: "/developer/keys",
      headers: { authorization: "Bearer athlete-jwt" },
      body: JSON.stringify({ name: "nope" }),
    });
    assert.strictEqual(res.status, 403);
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/api_keys") && c.method === "POST"),
      "no key is minted for a non-coach",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

test("full-surface read routes are key-authed and tenant-scoped", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    liveKeyRoute(),
    { test: (u, m) => u.includes("/protection_policies?") && m === "GET", reply: () => ok([]) },
    { test: (u, m) => u.includes("/billing_subscriptions?") && m === "GET", reply: () => ok([]) },
    { test: (u, m) => u.includes("/coaches?") && m === "GET", reply: () => ok([{ id: COACH_ID, slug: "coach-a", full_name: "Coach A" }]) },
    { test: (u, m) => u.includes("/sessions?") && u.includes("film_url=not.is.null") && m === "GET", reply: () => ok([{ id: ATHLETE_ID, film_url: "room/clip.mp4", title: "Rep" }]) },
  ]);
  try {
    const cases = [
      ["/api/v1/protection/policy", "default"],
      ["/api/v1/subscriptions", "subscriptions"],
      ["/api/v1/coach-page", "coach"],
      ["/api/v1/clips", "clips"],
      ["/api/v1/dashboard", "revenue"],
      ["/api/v1/payments/overview", "owed"],
    ];
    for (const [path, key] of cases) {
      const res = await request(port, { path, headers: authHdr });
      assert.strictEqual(res.status, 200, path);
      assert.ok(res.json[key] !== undefined, `${path} returns ${key}`);
    }
    const tenantReads = mock.calls.filter((c) => c.method === "GET" &&
      /protection_policies|billing_subscriptions|coaches\?|sessions\?/.test(c.u));
    assert.ok(tenantReads.length >= 4);
    assert.ok(tenantReads.every((c) => c.u.includes(`coach_id=eq.${COACH_ID}`) || c.u.includes(`id=eq.${COACH_ID}`)));
  } finally { mock.restore(); server.close(); }
});

test("money writes deny foreign rows before mutation", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    liveKeyRoute(),
    { test: (u, m) => u.includes("/payments?") && u.includes(`coach_id=eq.${COACH_ID}`) && m === "GET", reply: () => ok([]) },
    { test: (u, m) => u.includes("/booking_charges?") && u.includes(`coach_id=eq.${COACH_ID}`) && m === "GET", reply: () => ok([]) },
  ]);
  try {
    const paymentId = "66666666-6666-4666-8666-666666666666";
    let res = await request(port, { method: "POST", path: `/api/v1/payments/${paymentId}/void`, headers: authHdr, body: "{}" });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.json.error, "cross_tenant");
    res = await request(port, { method: "POST", path: `/api/v1/booking-charges/${paymentId}/waive`, headers: authHdr, body: "{}" });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.json.error, "cross_tenant");
    assert.ok(!mock.calls.some((c) => ["PATCH", "DELETE"].includes(c.method) &&
      /\/payments\?|\/booking_charges\?/.test(c.u)), "foreign money rows are never mutated");
  } finally { mock.restore(); server.close(); }
});

test("protection and billing configuration writes stay in the key tenant", async () => {
  const { server, port } = await startServer();
  const packageId = "77777777-7777-4777-8777-777777777777";
  const mock = installFetchMock([
    liveKeyRoute(),
    { test: (u, m) => u.includes("/protection_policies") && m === "POST",
      reply: (_u, _m, opts) => ok([{ id: packageId, ...JSON.parse(opts.body) }]) },
    { test: (u, m) => u.includes("/packages?") && u.includes(`coach_id=eq.${COACH_ID}`) && m === "PATCH",
      reply: (_u, _m, opts) => ok([{ id: packageId, coach_id: COACH_ID, ...JSON.parse(opts.body) }]) },
  ]);
  try {
    let res = await request(port, { method: "PUT", path: "/api/v1/protection/policy", headers: authHdr,
      body: JSON.stringify({ coachId: "99999999-9999-4999-8999-999999999999", enabled: true, require_card: true, free_cancel_hours: 24,
        late_cancel_fee: { type: "percent", value: 50 }, no_show_fee: { type: "flat", value: 2500 } }) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.policy.enabled, true);
    res = await request(port, { method: "PUT", path: `/api/v1/packages/${packageId}/billing-plan`, headers: authHdr,
      body: JSON.stringify({ billing_type: "subscription", billing_interval: "month", grace_days: 3 }) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.package.billing_type, "subscription");
    const policyWrite = mock.calls.find((c) => c.u.includes("/protection_policies") && c.method === "POST");
    assert.strictEqual(policyWrite.body.coach_id, COACH_ID);
    const planWrite = mock.calls.find((c) => c.u.includes("/packages?") && c.method === "PATCH");
    assert.ok(planWrite.u.includes(`coach_id=eq.${COACH_ID}`));
  } finally { mock.restore(); server.close(); }
});

test("every money mutation denies a foreign target through the real API core", async () => {
  const { server, port } = await startServer();
  const foreign = "99999999-9999-4999-8999-999999999999";
  const mutationCalls = [];
  const mock = installFetchMock([
    liveKeyRoute(),
    {
      test: (u, m) => m === "GET" && /session_types|athletes|bookable_slots|booking_charges|payments|billing_subscriptions/.test(u),
      reply: (u) => ok(u.includes(`coach_id=eq.${COACH_ID}`) ? [] : [{
        id: foreign, coach_id: foreign, status: "active", stripe_subscription_id: "sub_foreign",
      }]),
    },
    {
      test: (_u, m) => ["POST", "PATCH", "DELETE"].includes(m),
      reply: (u, m, opts) => {
        const body = opts.body ? JSON.parse(opts.body) : {};
        if (m === "POST" && /\/rest\/v1\/(payments|coach_charges)$/.test(u)) {
          mutationCalls.push([u, m, body.coach_id]);
          return ok([{ id: foreign, ...body }]);
        }
        if (/payments\?|coach_charges|booking_charges|packages\?|billing_subscriptions/.test(u)) {
          if (!u.includes(`coach_id=eq.${COACH_ID}`)) mutationCalls.push([u, m]);
          return ok(u.includes(`coach_id=eq.${COACH_ID}`) ? [] : [{ id: foreign }]);
        }
        return ok([]);
      },
    },
  ]);
  try {
    const json = (body) => JSON.stringify({ coachId: foreign, ...body });
    const cases = [
      ["POST", "/api/v1/payments", json({ amount_cents: 500, collected_via: "cash", athlete_id: foreign }), 403],
      ["POST", "/api/v1/charges", json({ label: "Foreign", amount_cents: 500, athlete_id: foreign }), 403],
      ["POST", `/api/v1/payments/${foreign}/void`, json({}), 403],
      ["POST", "/api/v1/booking-charges/no-show", json({ slot_id: foreign }), 403],
      ["POST", `/api/v1/booking-charges/${foreign}/waive`, json({}), 403],
      ["PUT", "/api/v1/protection/policy", json({ session_type_id: foreign, enabled: true,
        free_cancel_hours: 24, late_cancel_fee: { type: "none", value: 0 },
        no_show_fee: { type: "none", value: 0 } }), 403],
      ["PUT", `/api/v1/packages/${foreign}/billing-plan`, json({ billing_type: "one_time" }), 404],
      ["POST", `/api/v1/subscriptions/${foreign}/pause`, json({}), 404],
      ["POST", `/api/v1/subscriptions/${foreign}/resume`, json({}), 404],
      ["POST", `/api/v1/subscriptions/${foreign}/cancel`, json({ when: "now" }), 404],
    ];
    for (const [method, path, body, status] of cases) {
      const res = await request(port, { method, path, headers: authHdr, body });
      assert.strictEqual(res.status, status, path);
    }
    assert.deepStrictEqual(mutationCalls, [], "no foreign money/configuration row was mutated");
  } finally { mock.restore(); server.close(); }
});

test("new ledger lists clamp abusive limits and apply offsets", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([liveKeyRoute()]);
  try {
    for (const path of [
      "/api/v1/booking-charges?limit=1000000000&offset=7",
      "/api/v1/subscriptions?limit=1000000000&offset=7",
      "/api/v1/payments/overview?limit=1000000000&offset=7",
    ]) {
      const res = await request(port, { path, headers: authHdr });
      assert.strictEqual(res.status, 200, path);
      assert.strictEqual(res.json.limit, 100, path);
      assert.strictEqual(res.json.offset, 7, path);
    }
    const paged = mock.calls.filter((c) => /booking_charges|billing_subscriptions|payments\?/.test(c.u) && c.u.includes("limit=100"));
    assert.ok(paged.length >= 3);
    assert.ok(paged.every((c) => c.u.includes("offset=7")));
  } finally { mock.restore(); server.close(); }
});

test("get_clip_url refuses a tampered stored path without calling the signer", async () => {
  const { server, port } = await startServer();
  const clipId = "88888888-8888-4888-8888-888888888888";
  const mock = installFetchMock([
    liveKeyRoute(),
    { test: (u, m) => u.includes("/sessions?") && u.includes(`id=eq.${clipId}`) && m === "GET",
      reply: () => ok([{ id: clipId, film_url: "foreign-room/../../secret.mp4" }]) },
  ]);
  try {
    const res = await request(port, { method: "POST", path: `/api/v1/clips/${clipId}/url`, headers: authHdr, body: "{}" });
    assert.strictEqual(res.status, 404);
    assert.ok(!mock.calls.some((c) => c.u.includes("/storage/v1/object/sign/")), "tampered path was never signed");
  } finally { mock.restore(); server.close(); }
});

test("REST policy and billing cores reject numeric values outside MCP bounds", async () => {
  const { server, port } = await startServer();
  const packageId = "77777777-7777-4777-8777-777777777777";
  const mock = installFetchMock([liveKeyRoute()]);
  try {
    const policy = await request(port, { method: "PUT", path: "/api/v1/protection/policy", headers: authHdr,
      body: JSON.stringify({ enabled: true, free_cancel_hours: 24,
        late_cancel_fee: { type: "percent", value: 101 },
        no_show_fee: { type: "flat", value: 12.5 } }) });
    assert.strictEqual(policy.status, 400);
    const plan = await request(port, { method: "PUT", path: `/api/v1/packages/${packageId}/billing-plan`, headers: authHdr,
      body: JSON.stringify({ billing_type: "subscription", billing_interval: "month",
        max_cycles: 1.5, trial_days: 366, grace_days: 91 }) });
    assert.strictEqual(plan.status, 400);
    assert.ok(!mock.calls.some((c) => ["protection_policies", "packages?"].some((part) => c.u.includes(part)) && c.method !== "GET"));
  } finally { mock.restore(); server.close(); }
});

test("API roster import accepts a body above the global JSON limit", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([liveKeyRoute()]);
  try {
    const body = JSON.stringify({ rows: [], options: { dry_run: true, padding: "x".repeat(150000) } });
    const res = await request(port, { method: "POST", path: "/api/v1/athletes/import", headers: authHdr, body });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.created, 0);
  } finally { mock.restore(); server.close(); }
});
