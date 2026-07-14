// Payments Phase 1 route tests (PAYMENTS_ENABLED OFF).
// Proves every /payments + /charges route is completely absent when the flag is
// unset: each request gets no matching route and falls through to a 404. Lives
// in its own file because index.js reads the flag once at module load, and node
// --test runs each file in a fresh process, so the flag here is genuinely OFF.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
// PAYMENTS_ENABLED deliberately UNSET.
delete process.env.PAYMENTS_ENABLED;

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

const PAYMENT_ID = "11111111-1111-4111-8111-111111111111";

test("GET /payments/overview 404s when PAYMENTS_ENABLED is off", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, "/payments/overview");
    assert.strictEqual(res.status, 404, "the payments overview is absent until the flag is on");
  } finally {
    server.close();
  }
});

test("GET /payments/methods 404s when PAYMENTS_ENABLED is off", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, "/payments/methods");
    assert.strictEqual(res.status, 404);
  } finally {
    server.close();
  }
});

test("POST /payments 404s when PAYMENTS_ENABLED is off", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, "/payments", "POST");
    assert.strictEqual(res.status, 404, "record-payment is absent until the flag is on");
  } finally {
    server.close();
  }
});

test("POST /payments/:id/void 404s when PAYMENTS_ENABLED is off", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, `/payments/${PAYMENT_ID}/void`, "POST");
    assert.strictEqual(res.status, 404);
  } finally {
    server.close();
  }
});

test("POST /charges 404s when PAYMENTS_ENABLED is off", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, "/charges", "POST");
    assert.strictEqual(res.status, 404);
  } finally {
    server.close();
  }
});

test("PATCH /payments/rails 404s when PAYMENTS_ENABLED is off", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, "/payments/rails", "PATCH");
    assert.strictEqual(res.status, 404);
  } finally {
    server.close();
  }
});
