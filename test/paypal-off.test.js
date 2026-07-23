// PayPal lane routes DARK when PAYPAL_ENABLED is off.
// PAYPAL_ENABLED ships DEFAULT-ON (envFlagDefaultOn), so "off" means an explicit
// "0". Proves the three /paypal routes are completely absent (404) when the flag
// is turned off. Own file because index.js reads the flag once at module load and
// node --test runs each file in a fresh process.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
// The emergency off switch.
process.env.PAYPAL_ENABLED = "0";

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
    const req = http.request({ hostname: "127.0.0.1", port, path, method }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, text: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("POST /paypal/create-order 404s when PAYPAL_ENABLED is off", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, "/paypal/create-order", "POST");
    assert.strictEqual(res.status, 404, "create-order is absent when the flag is off");
  } finally {
    server.close();
  }
});

test("GET /paypal/return 404s when PAYPAL_ENABLED is off", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, "/paypal/return?token=abc", "GET");
    assert.strictEqual(res.status, 404, "return is absent when the flag is off");
  } finally {
    server.close();
  }
});

test("POST /paypal/webhook 404s when PAYPAL_ENABLED is off", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, "/paypal/webhook", "POST");
    assert.strictEqual(res.status, 404, "webhook is absent when the flag is off");
  } finally {
    server.close();
  }
});
