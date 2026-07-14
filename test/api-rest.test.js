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
