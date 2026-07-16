// Open API + MCP surface OFF test (API_ENABLED unset).
// Proves the /api/v1 REST cluster and the /mcp endpoint are completely absent
// when the flag is unset — a request falls through to a 404. Its own file
// because index.js reads the flag once at module load and node --test runs each
// file in a fresh process, so the flag here is genuinely OFF.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
// API_ENABLED deliberately UNSET.
delete process.env.API_ENABLED;

const { app } = require("../index.js");

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request(port, path, method = "GET", headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, text: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("GET /api/v1/athletes 404s when API_ENABLED is off", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, "/api/v1/athletes", "GET", {
      authorization: "Bearer ctk_whatever",
    });
    assert.strictEqual(res.status, 404, "the REST surface is absent until the flag is on");
  } finally {
    server.close();
  }
});

test("POST /mcp 404s when API_ENABLED is off", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, "/mcp", "POST", { authorization: "Bearer ctk_whatever" });
    assert.strictEqual(res.status, 404, "the MCP endpoint is absent until the flag is on");
  } finally {
    server.close();
  }
});
