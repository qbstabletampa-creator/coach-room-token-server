// Athlete booking page route tests (SCHEDULING_ENABLED ON).
// Run: node --test  (each test FILE runs in its own process, so the flag we set
// here is isolated from scheduling-off.test.js, which boots the same module with
// the flag UNSET to prove the route 404s when the feature is off).
//
// Env is set BEFORE requiring index.js so the module boots in test mode
// (require.main !== module skips app.listen) with the booking route registered.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SCHEDULING_ENABLED = "1";

const { app } = require("../index.js");

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request(port, { method = "GET", path = "/", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, text: data }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const VALID_TOKEN = "11111111-1111-1111-1111-111111111111";

test("GET /book/:inviteToken serves the booking HTML when SCHEDULING_ENABLED is on", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, { path: `/book/${VALID_TOKEN}` });
    assert.strictEqual(res.status, 200, "a valid invite token serves the page");
    assert.match(res.headers["content-type"] || "", /text\/html/);
    assert.match(res.text, /Book a Session/, "the served page is book.html");
    // Zero-account north star: the page carries no login/signup/form scaffolding.
    assert.ok(!/type="password"/.test(res.text), "no password field on the booking page");
  } finally {
    server.close();
  }
});

test("GET /book/:inviteToken rejects a non-UUID token with 400", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, { path: "/book/not-a-uuid" });
    assert.strictEqual(res.status, 400, "a malformed token is rejected, not served");
  } finally {
    server.close();
  }
});
