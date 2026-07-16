const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
delete process.env.AI_NOTES_ENABLED;

const { app } = require("../index.js");
const ID = "11111111-1111-4111-8111-111111111111";

function startServer() {
  return new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })); });
}
function request(port, method, path, body, contentType = "application/json", extra = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body == null ? null : Buffer.from(body);
    const call = http.request({ hostname: "127.0.0.1", port, method, path, headers: {
      ...(bytes ? { "content-type": contentType, "content-length": bytes.length } : {}), ...extra,
    } }, (response) => {
      let text = ""; response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, contentType: response.headers["content-type"], text }));
    });
    call.on("error", reject); if (bytes) call.write(bytes); call.end();
  });
}

test("AI notes flag-off import registers no route or route-local parser", () => {
  const stack = app._router && app._router.stack || [];
  const routes = stack.filter((layer) => layer.route).map((layer) => ({
    path: layer.route.path, methods: Object.keys(layer.route.methods || {}).sort(),
  }));
  assert.equal(routes.some((route) => String(route.path).includes("ai-notes")), false);
  const source = stack.map((layer) => String(layer.handle || "")).join("\n");
  assert.doesNotMatch(source, /ai-notes|AI_NOTES_AUDIO_BUCKET|session-audio/);
  const health = routes.find((route) => route.path === "/health");
  assert.deepEqual(health, { path: "/health", methods: ["get"] });
});

test("all five flag-off endpoints are ordinary Express 404s and health is unchanged", async () => {
  const { server, port } = await startServer();
  const audio = Buffer.alloc(12); audio.write("ftyp", 4);
  const routes = [
    ["POST", `/ai-notes/${ID}/audio`, audio, "audio/mp4", { "idempotency-key": "request_key_000001" }],
    ["DELETE", `/ai-notes/${ID}/audio/request_key_000001`, null],
    ["POST", `/ai-notes/${ID}/generate`, JSON.stringify({ request_id: "request_key_000001", use_audio: false })],
    ["GET", `/ai-notes/${ID}`, null],
    ["POST", `/ai-notes/${ID}/share`, JSON.stringify({ share_id: "share_key_00000001" })],
  ];
  try {
    const health = await request(port, "GET", "/health", null);
    assert.equal(health.status, 200); assert.deepEqual(JSON.parse(health.text), { ok: true });
    for (const [method, path, body, type, headers] of routes) {
      const out = await request(port, method, path, body, type, headers);
      assert.equal(out.status, 404, `${method} ${path}`);
      assert.match(out.text, /Cannot (GET|POST|DELETE) \/ai-notes/);
      assert.doesNotMatch(out.text, /"error"|too_many_requests|source_too_large|invalid_audio/);
    }
  } finally { server.close(); }
});
