// Athlete booking page route test (SCHEDULING_ENABLED OFF).
// Proves the booking route is completely absent when the flag is unset: GET
// /book/:token gets no matching route and falls through to a 404. Lives in its
// own file because index.js reads the flag once at module load, and node --test
// runs each file in a fresh process, so the flag here is genuinely OFF.

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

const VALID_TOKEN = "11111111-1111-1111-1111-111111111111";

test("GET /book/:inviteToken 404s when SCHEDULING_ENABLED is off", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, `/book/${VALID_TOKEN}`);
    assert.strictEqual(res.status, 404, "the booking route is absent until the flag is on");
  } finally {
    server.close();
  }
});
