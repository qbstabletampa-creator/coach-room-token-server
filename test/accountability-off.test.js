const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
delete process.env.ACCOUNTABILITY_ENABLED;

const { app } = require("../index.js");
const ID = "11111111-1111-4111-8111-111111111111";

function startServer() {
  return new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })); });
}
function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const bytes = body == null ? null : Buffer.from(body);
    const req = http.request({ hostname: "127.0.0.1", port, method, path,
      headers: bytes ? { "content-type": "application/json", "content-length": bytes.length } : {} }, (res) => {
      let text = ""; res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, contentType: res.headers["content-type"], text }));
    });
    req.on("error", reject); if (bytes) req.write(bytes); req.end();
  });
}

test("all six accountability routes and the private page are ordinary Express 404s while off", async () => {
  const { server, port } = await startServer();
  const routes = [["POST", "/homework", JSON.stringify({ athlete_id: ID, title: "x" })], ["GET", `/homework?athlete_id=${ID}&status=assigned`, null],
    ["POST", `/homework/${ID}/done`, "{}"], ["GET", `/hw/${ID}/data`, null], ["POST", `/hw/${ID}/done`, "{}"], ["GET", `/hw/${ID}`, null]];
  try {
    const health = await request(port, "GET", "/health", null); assert.equal(health.status, 200); assert.deepEqual(JSON.parse(health.text), { ok: true });
    for (const [method, path, body] of routes) {
      const out = await request(port, method, path, body); assert.equal(out.status, 404, `${method} ${path}`);
      assert.match(out.text, /Cannot (GET|POST)/); assert.doesNotMatch(out.text, /Homework complete|Mark done|too_many_requests|\"error\"/);
    }
  } finally { server.close(); }
});

test("flag-off large body has byte-identical global-parser posture", async () => {
  const { server, port } = await startServer(); const body = JSON.stringify({ padding: "x".repeat(128 * 1024) });
  try {
    const feature = await request(port, "POST", "/homework", body); const baseline = await request(port, "POST", "/master-fallback", body);
    assert.ok(Buffer.byteLength(body) > 100 * 1024); assert.deepEqual(feature, baseline);
  } finally { server.close(); }
});
