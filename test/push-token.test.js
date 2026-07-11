// POST /register-push-token unit tests (D13 notify backbone). The route is NOT
// flag-gated (a user owns their own device tokens), authed via the same
// requireSupabaseUser primitive as /data and the scheduling coach routes.
//
// Same in-process HTTP harness + fetch-mock shape as scheduling-endpoints.test.js.
// Env is set BEFORE requiring index.js so the module boots in test mode
// (require.main !== module skips app.listen). No network, no live creds.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.RESEND_API_KEY;

const { app } = require("../index.js");

const COACH_ID = "33333333-3333-4333-8333-333333333333";
const VALID_TOKEN = "ExponentPushToken[abc123DEF456]";

// ---- harness ---------------------------------------------------------------
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

function installFetchMock(routes) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ u, method, headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
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

// ===========================================================================
// 1. happy path: authed user + valid token -> 200, upsert on token
// ===========================================================================

test("POST /register-push-token upserts on the token unique key -> 200 ok", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      test: (u) => u.includes("/auth/v1/user"),
      reply: () => ok({ id: COACH_ID }),
    },
    {
      test: (u, m) => u.includes("/push_tokens") && m === "POST",
      reply: () => ok([]),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/register-push-token",
      headers: { authorization: "Bearer coach-jwt" },
      body: JSON.stringify({ token: VALID_TOKEN, platform: "ios" }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.ok, true);

    const up = mock.calls.find((c) => c.u.includes("/push_tokens") && c.method === "POST");
    assert.ok(up, "the token was upserted");
    assert.ok(up.u.includes("on_conflict=token"), "upsert conflict-targets the token unique key");
    assert.ok(
      String(up.headers.prefer || "").includes("resolution=merge-duplicates"),
      "upsert uses merge-duplicates so a re-register refreshes instead of erroring",
    );
    // The row binds the token to the VERIFIED caller, not a body-supplied id.
    assert.strictEqual(up.body.user_id, COACH_ID);
    assert.strictEqual(up.body.token, VALID_TOKEN);
    assert.strictEqual(up.body.platform, "ios");
    assert.ok(up.body.updated_at, "updated_at is stamped on register");
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 2. malformed token -> 200 no-op, nothing written
// ===========================================================================

test("POST /register-push-token no-ops a malformed token with 200 and writes nothing", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      test: (u) => u.includes("/auth/v1/user"),
      reply: () => ok({ id: COACH_ID }),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/register-push-token",
      headers: { authorization: "Bearer coach-jwt" },
      body: JSON.stringify({ token: "not-a-real-token", platform: "ios" }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.ok, true);
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/push_tokens")),
      "a malformed token never touches push_tokens",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 3. auth required: no Authorization header -> 401, nothing written
// ===========================================================================

test("POST /register-push-token requires a session -> 401 without a token", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/register-push-token",
      body: JSON.stringify({ token: VALID_TOKEN, platform: "ios" }),
    });
    assert.strictEqual(res.status, 401);
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/push_tokens")),
      "no token is stored for an unauthenticated caller",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 4. unknown platform normalizes to ios; a re-register refreshes the same token
// ===========================================================================

test("POST /register-push-token normalizes an unknown platform to ios", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      test: (u) => u.includes("/auth/v1/user"),
      reply: () => ok({ id: COACH_ID }),
    },
    {
      test: (u, m) => u.includes("/push_tokens") && m === "POST",
      reply: () => ok([]),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/register-push-token",
      headers: { authorization: "Bearer coach-jwt" },
      body: JSON.stringify({ token: VALID_TOKEN, platform: "SymbianOS" }),
    });
    assert.strictEqual(res.status, 200);
    const up = mock.calls.find((c) => c.u.includes("/push_tokens") && c.method === "POST");
    assert.strictEqual(up.body.platform, "ios", "an unrecognized platform falls back to ios");
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 5. a Supabase upsert failure surfaces honestly -> 502
// ===========================================================================

test("POST /register-push-token returns 502 when the upsert fails", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    {
      test: (u) => u.includes("/auth/v1/user"),
      reply: () => ok({ id: COACH_ID }),
    },
    {
      test: (u, m) => u.includes("/push_tokens") && m === "POST",
      reply: () => ({ ok: false, status: 500, json: async () => null, text: async () => "boom" }),
    },
  ]);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/register-push-token",
      headers: { authorization: "Bearer coach-jwt" },
      body: JSON.stringify({ token: VALID_TOKEN, platform: "ios" }),
    });
    assert.strictEqual(res.status, 502);
  } finally {
    mock.restore();
    server.close();
  }
});
