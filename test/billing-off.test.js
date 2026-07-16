const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test";
process.env.LIVEKIT_API_SECRET = "test";
delete process.env.BILLING_ENABLED;
const { app } = require("../index");

test("billing routes are not registered while BILLING_ENABLED is off", async () => {
  const server = await new Promise((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port: server.address().port,
        path: "/coach/subscriptions", method: "GET" }, (res) => {
        res.resume(); res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject); req.end();
    });
    assert.equal(status, 404);
  } finally { server.close(); }
});
