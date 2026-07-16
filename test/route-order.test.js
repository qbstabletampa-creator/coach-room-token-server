const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
process.env.SCHEDULING_ENABLED = "1";
process.env.DASHBOARD_ENABLED = "1";

const { app } = require("../index");

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, text, type: res.headers["content-type"] || "" }));
    });
    req.on("error", reject);
  });
}

test("dashboard literal wins over /coach/:slug while a real storefront slug still resolves", async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/auth/v1/user")) return { ok: false, status: 401, json: async () => ({}), text: async () => "" };
    if (u.includes("/coaches?slug=eq.real-coach")) {
      return { ok: true, status: 200, json: async () => [{ id: "33333333-3333-4333-8333-333333333333", full_name: "Real Coach" }], text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => [], text: async () => "" };
  };
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const dashboard = await request(server.address().port, "/coach/dashboard");
    assert.strictEqual(dashboard.status, 401);
    assert.match(dashboard.type, /application\/json/);
    assert.deepStrictEqual(JSON.parse(dashboard.text), { error: "sign in required" });
    const storefront = await request(server.address().port, "/coach/real-coach");
    assert.strictEqual(storefront.status, 200);
    assert.match(storefront.text, /Scan to book/);
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});
