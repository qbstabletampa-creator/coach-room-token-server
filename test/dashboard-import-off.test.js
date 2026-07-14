// Round-2 dashboard + import route tests (DASHBOARD_ENABLED + IMPORT_ENABLED OFF).
// Proves GET /coach/dashboard and POST /coach/athletes/import are completely
// absent when the flags are unset: each request gets no matching route and falls
// through to a 404. Own file because index.js reads the flags once at module
// load, and node --test runs each file in a fresh process, so the flags are
// genuinely OFF here.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
// DASHBOARD_ENABLED + IMPORT_ENABLED deliberately UNSET.
delete process.env.DASHBOARD_ENABLED;
delete process.env.IMPORT_ENABLED;

const { app } = require("../index.js");

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request(port, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, text: data }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("GET /coach/dashboard 404s when DASHBOARD_ENABLED is off", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, "/coach/dashboard");
    assert.strictEqual(res.status, 404, "the dashboard is absent until the flag is on");
  } finally {
    server.close();
  }
});

test("POST /coach/athletes/import 404s when IMPORT_ENABLED is off", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, "/coach/athletes/import", "POST");
    assert.strictEqual(res.status, 404, "import is absent until the flag is on");
  } finally {
    server.close();
  }
});

test("GET /ai serves the pack as markdown even with both feature flags off", async () => {
  // The public AI pack routes are NOT flag-gated; they answer regardless.
  const { server, port } = await startServer();
  try {
    const res = await request(port, "/ai");
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.length > 0, "pack body is served");
  } finally {
    server.close();
  }
});

test("GET /llms.txt serves the index even with both feature flags off", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, "/llms.txt");
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.length > 0, "llms.txt body is served");
  } finally {
    server.close();
  }
});
