// Notification + payments backbone unit tests. No network, no live creds.
// Run: node --test  (Node's built-in runner; each test FILE runs in its own
// process, so the env we set here is isolated from clips.test.js).
//
// We set env BEFORE requiring index.js so the module boots in test mode
// (require.main !== module skips app.listen) with the payments routes ENABLED.
// Deliberately absent: STRIPE_SECRET_KEY (checkout stays simulated),
// STRIPE_WEBHOOK_SECRET (webhook stays simulated by default; individual tests
// set it at call time to exercise real signature verification), RESEND_API_KEY
// (the email channel is a graceful no-op).

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
process.env.ROOM_TICKET_SECRET = "test-ticket-secret";
process.env.CHECKOUT_ENABLED = "1";
process.env.STRIPE_WEBHOOK_ENABLED = "1";
// Ensure a clean slate for the mode-sensitive secrets.
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.RESEND_API_KEY;

const { app, notify } = require("../index.js");

// ---- tiny in-process HTTP harness (same shape as clips.test.js) ------------
function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body);
    const h = { ...headers };
    if (payload && !h["content-type"] && !h["Content-Type"]) {
      h["content-type"] = "application/json";
    }
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: h },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            json: (() => {
              try {
                return JSON.parse(data);
              } catch {
                return null;
              }
            })(),
            text: data,
          }),
        );
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Compute a valid Stripe-Signature header for a raw body string.
function stripeSig(body, secret, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${body}`)
    .digest("hex");
  return `t=${t},v1=${v1}`;
}

// ===========================================================================
// notify(): never throws, idempotent
// ===========================================================================

test("notify() never throws when every channel fails (fetch rejects)", async () => {
  const realFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("network down");
  };
  try {
    await assert.doesNotReject(() =>
      notify({
        userId: "u1",
        type: "session.booked",
        title: "Booked",
        body: "See you Friday",
        email: "parent@example.com",
        dedupeKey: "booking-1",
        data: { bookingId: "b1" },
      }),
    );
  } finally {
    global.fetch = realFetch;
  }
});

test("notify() never throws when Supabase returns errors (missing table / 404)", async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
    text: async () => "relation \"notifications\" does not exist",
  });
  try {
    await assert.doesNotReject(() =>
      notify({ userId: "u1", type: "clip.ready", title: "Clip", body: "Ready" }),
    );
  } finally {
    global.fetch = realFetch;
  }
});

test("notify() is idempotent: an existing dedupe row short-circuits email + push", async () => {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ u, method: opts.method || "GET" });
    // Dedupe pre-check (GET notifications) returns an existing row.
    if (u.includes("/rest/v1/notifications") && (opts.method || "GET") === "GET") {
      return { ok: true, json: async () => [{ id: "n1" }] };
    }
    return { ok: true, json: async () => [], text: async () => "" };
  };
  try {
    await notify({
      userId: "u1",
      type: "session.booked",
      title: "Booked",
      body: "again",
      dedupeKey: "booking-1",
    });
    assert.ok(
      !calls.some((c) => c.u.includes("exp.host")),
      "no Expo push fired after the dedupe hit",
    );
    assert.ok(
      !calls.some((c) => c.u.includes("/rest/v1/push_tokens")),
      "no push-token lookup after the dedupe hit",
    );
    assert.ok(
      !calls.some((c) => c.u.includes("/rest/v1/notifications") && c.method === "POST"),
      "no duplicate row inserted after the dedupe hit",
    );
  } finally {
    global.fetch = realFetch;
  }
});

// ===========================================================================
// POST /stripe/webhook: 400 bad signature, 200 unhandled, 200 valid handled
// ===========================================================================

test("POST /stripe/webhook returns 400 on a bad signature (secret set)", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_testsecret";
  const { server, port } = await startServer();
  try {
    const body = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: {} },
    });
    const res = await request(port, {
      method: "POST",
      path: "/stripe/webhook",
      headers: { "content-type": "application/json", "stripe-signature": "t=123,v1=deadbeef" },
      body,
    });
    assert.strictEqual(res.status, 400, "a tampered/garbage signature is the one non-200");
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    server.close();
  }
});

test("POST /stripe/webhook returns 400 when the signature header is missing (secret set)", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_testsecret";
  const { server, port } = await startServer();
  try {
    const body = JSON.stringify({ type: "checkout.session.completed", data: { object: {} } });
    const res = await request(port, {
      method: "POST",
      path: "/stripe/webhook",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.strictEqual(res.status, 400);
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    server.close();
  }
});

test("POST /stripe/webhook returns 200 for an UNHANDLED event type (simulated, no secret)", async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET; // simulated parse path
  const { server, port } = await startServer();
  try {
    const body = JSON.stringify({ type: "invoice.paid", data: { object: { id: "in_1" } } });
    const res = await request(port, {
      method: "POST",
      path: "/stripe/webhook",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.strictEqual(res.status, 200, "unhandled events are ACK'd, never retry-stormed");
    assert.strictEqual(res.json.received, true);
  } finally {
    server.close();
  }
});

test("POST /stripe/webhook returns 200 for a VALID signature on a handled event", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_testsecret";
  const { server, port } = await startServer();
  try {
    const body = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { id: "cs_123", client_reference_id: "u1", amount_total: 5000 } },
    });
    const sig = stripeSig(body, "whsec_testsecret");
    const res = await request(port, {
      method: "POST",
      path: "/stripe/webhook",
      headers: { "content-type": "application/json", "stripe-signature": sig },
      body,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.received, true);
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    server.close();
  }
});

// ===========================================================================
// POST /checkout/create-session: refuses a client price, simulated stable shape
// ===========================================================================

test("POST /checkout/create-session REFUSES a client-supplied amount", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  // Auth passes; the price-field guard fires before any package lookup.
  global.fetch = async (url) => {
    if (String(url).includes("/auth/v1/user")) {
      return { ok: true, json: async () => ({ id: "user-1" }) };
    }
    return { ok: true, json: async () => [] };
  };
  try {
    const res = await request(port, {
      method: "POST",
      path: "/checkout/create-session",
      headers: { authorization: "Bearer good-jwt" },
      body: JSON.stringify({ packageId: "p1", amount: 1 }),
    });
    assert.strictEqual(res.status, 400, "the client never names its own price");
    assert.match(res.json.error, /server-side/);
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test("POST /checkout/create-session simulated mode returns a stable shape (amount from the package row)", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/auth/v1/user")) {
      return { ok: true, json: async () => ({ id: "user-1" }) };
    }
    if (u.includes("/rest/v1/packages")) {
      return {
        ok: true,
        json: async () => [
          { id: "p1", name: "5-Session Pack", price_cents: 5000, active: true },
        ],
      };
    }
    return { ok: true, json: async () => [] };
  };
  try {
    const res = await request(port, {
      method: "POST",
      path: "/checkout/create-session",
      headers: { authorization: "Bearer good-jwt" },
      body: JSON.stringify({ packageId: "p1" }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.simulated, true);
    assert.strictEqual(res.json.amountCents, 5000, "amount is the server-computed package price");
    assert.strictEqual(res.json.packageId, "p1");
    assert.strictEqual(res.json.clientSecret, "cs_simulated_p1_secret");
    assert.ok(typeof res.json.url === "string" && res.json.url.length > 0, "a checkout url is returned");
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test("POST /checkout/create-session returns 401 without a JWT", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, {
      method: "POST",
      path: "/checkout/create-session",
      body: JSON.stringify({ packageId: "p1" }),
    });
    assert.strictEqual(res.status, 401, "identity must come from a verified JWT");
  } finally {
    server.close();
  }
});
