// Round-2 dashboard + import route tests (DASHBOARD_ENABLED + IMPORT_ENABLED ON).
// Foundation smoke: both stubs register, auth-gate on the coach JWT, then return
// 501 "not implemented" (the feature builders fill the internals). No network,
// no live creds; env is set BEFORE requiring index.js so the routes register.
// global.fetch is mocked so the /auth/v1/user check resolves to a coach id.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
process.env.DASHBOARD_ENABLED = "1";
process.env.IMPORT_ENABLED = "1";

const { app } = require("../index.js");

const COACH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUTH = { authorization: "Bearer test-jwt" };

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

function installAuthMock(coachId = COACH) {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/auth/v1/user")) {
      return { ok: true, status: 200, json: async () => ({ id: coachId }), text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => [], text: async () => "" };
  };
  return { restore() { global.fetch = realFetch; } };
}

test("GET /coach/dashboard registers and returns the rollup (implemented) for an authed coach", async () => {
  const { server, port } = await startServer();
  const mock = installAuthMock();
  try {
    const res = await request(port, { path: "/coach/dashboard?range=this_month", headers: AUTH });
    assert.strictEqual(res.status, 200, "dashboard route is implemented (rollup payload)");
    assert.ok(res.json && res.json.range && res.json.revenue, "contract-A top-level shape present");
  } finally {
    mock.restore();
    server.close();
  }
});

test("GET /coach/dashboard 401s without a coach JWT (auth gate wired before the stub)", async () => {
  const { server, port } = await startServer();
  const mock = installAuthMock();
  try {
    const res = await request(port, { path: "/coach/dashboard" });
    assert.strictEqual(res.status, 401, "no bearer token -> sign in required");
  } finally {
    mock.restore();
    server.close();
  }
});

test("POST /coach/athletes/import registers and returns a dry-run plan (implemented) for an authed coach", async () => {
  const { server, port } = await startServer();
  const mock = installAuthMock();
  try {
    const res = await request(port, {
      method: "POST",
      path: "/coach/athletes/import",
      headers: AUTH,
      body: JSON.stringify({ rows: [{ name: "Test Athlete" }], options: { dry_run: true } }),
    });
    assert.strictEqual(res.status, 200, "import route is implemented (dry-run plan)");
    assert.ok(res.json && "plan" in res.json, "dry_run responds with a plan");
  } finally {
    mock.restore();
    server.close();
  }
});

test("POST /coach/athletes/import 401s without a coach JWT", async () => {
  const { server, port } = await startServer();
  const mock = installAuthMock();
  try {
    const res = await request(port, {
      method: "POST",
      path: "/coach/athletes/import",
      body: JSON.stringify({ rows: [] }),
    });
    assert.strictEqual(res.status, 401);
  } finally {
    mock.restore();
    server.close();
  }
});
