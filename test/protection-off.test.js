const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
delete process.env.PROTECTION_ENABLED;

const { app } = require("../index");

function request(server, method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port: server.address().port, method, path,
      headers: method === "POST" ? { "content-type": "application/json" } : {},
    }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    if (method === "POST") req.end("{}"); else req.end();
  });
}

test("PROTECTION_ENABLED off leaves all five pinned routes unregistered", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const routes = [
      ["GET", "/protection/invite/11111111-1111-4111-8111-111111111111"],
      ["GET", "/protection/coach-slug"],
      ["POST", "/protection/coach-slug/setup-intent"],
      ["POST", "/coach/bookings/no-show"],
      ["POST", "/coach/charges/11111111-1111-4111-8111-111111111111/waive"],
    ];
    for (const [method, path] of routes) {
      assert.strictEqual((await request(server, method, path)).status, 404, `${method} ${path}`);
    }
  } finally {
    server.close();
  }
});
