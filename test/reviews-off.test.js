// REVIEWS_ENABLED is intentionally absent in this fresh test process. All
// review shapes must be the ordinary Express fallback, never review JSON.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
delete process.env.REVIEWS_ENABLED;

const { app } = require("../index.js");

const ID = "11111111-1111-4111-8111-111111111111";

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port }));
  });
}

function request(port, method, path, body, contentType = "application/json") {
  return new Promise((resolve, reject) => {
    const bytes = body == null ? null : Buffer.from(body);
    const req = http.request({
      hostname: "127.0.0.1", port, method, path,
      headers: bytes ? { "content-type": contentType, "content-length": bytes.length } : {},
    }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: { "content-type": res.headers["content-type"], "content-length": res.headers["content-length"] },
        text,
      }));
    });
    req.on("error", reject);
    if (bytes) req.write(bytes);
    req.end();
  });
}

test("all seven review routes are byte-posture Express 404s while flag is off", async () => {
  const { server, port } = await startServer();
  const routes = [
    ["POST", "/reviews", JSON.stringify({ video_id: ID })],
    ["GET", "/reviews?status=submitted", null],
    ["GET", `/reviews/${ID}`, null],
    ["POST", `/reviews/${ID}/audio`, "0000ftyp", "audio/mp4"],
    ["POST", `/reviews/${ID}/answer`, JSON.stringify({ reel: [], duration_s: 0 })],
    ["GET", `/reviews/${ID}/annotation`, null],
    ["POST", `/reviews/${ID}/decline`, "{}"],
  ];
  try {
    const health = await request(port, "GET", "/health", null);
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.text), { ok: true });
    for (const [method, path, body, type] of routes) {
      const out = await request(port, method, path, body, type);
      assert.equal(out.status, 404, `${method} ${path}`);
      assert.match(out.text, /Cannot (GET|POST) \/reviews/);
      assert.doesNotMatch(out.text, /"error"|too_many_requests/);
    }
  } finally { server.close(); }
});

test("flag off does not mount the 1 MB review JSON parser", async () => {
  const { server, port } = await startServer();
  // Larger than Express's global 100 KB default but smaller than the review
  // parser's 1 MB allowance. With the flag off, /reviews must therefore have
  // precisely the same parser/fallback response bytes as an ordinary missing
  // route from master.
  const body = JSON.stringify({ padding: "x".repeat(128 * 1024) });
  try {
    const review = await request(port, "POST", "/reviews", body);
    const baseline = await request(port, "POST", "/master-fallback", body);
    assert.ok(Buffer.byteLength(body) > 1024);
    assert.deepEqual(review, baseline);
  } finally { server.close(); }
});
