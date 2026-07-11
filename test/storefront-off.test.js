// Storefront route test (SCHEDULING_ENABLED OFF).
// The public coach page + guest booking ride the same flag as the rest of
// scheduling. With the flag unset none of the /coach/:slug routes register, so
// every one falls through to a 404 (fails soft everywhere, per the build brief).
// Own file because index.js reads the flag once at module load and node --test
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

function request(port, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method },
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

test("GET /coach/:slug 404s when SCHEDULING_ENABLED is off", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, "/coach/cjbennett");
    assert.strictEqual(res.status, 404, "the storefront page is absent until the flag is on");
  } finally {
    server.close();
  }
});

test("GET /coach/:slug/data 404s when SCHEDULING_ENABLED is off", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, "/coach/cjbennett/data");
    assert.strictEqual(res.status, 404, "the storefront data route is absent until the flag is on");
  } finally {
    server.close();
  }
});

test("POST /coach/:slug/book-guest 404s when SCHEDULING_ENABLED is off", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, "/coach/cjbennett/book-guest", "POST");
    assert.strictEqual(res.status, 404, "guest booking is absent until the flag is on");
  } finally {
    server.close();
  }
});
