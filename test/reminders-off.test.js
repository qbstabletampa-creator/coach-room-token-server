// Reminder-cron route test (SCHEDULING_ENABLED OFF). Proves GET /cron/reminders
// is absent when the feature flag is unset: it falls through to a 404. Lives in
// its own file because index.js reads the flag once at module load and node
// --test runs each file in a fresh process, so the flag here is genuinely OFF.
// This passes both before and after the PM wires registration, because the route
// registers behind the same flag.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
// SCHEDULING_ENABLED deliberately UNSET.
delete process.env.SCHEDULING_ENABLED;

const { app } = require("../index.js");

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "GET" },
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

test("GET /cron/reminders 404s when SCHEDULING_ENABLED is off", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, "/cron/reminders");
    assert.strictEqual(res.status, 404, "the reminder cron route is absent until the flag is on");
  } finally {
    server.close();
  }
});
