// GET /schedule/:inviteToken — package-balance flags (contract §C, migration 0015).
// Proves the read-path additively surfaces athlete_sees_balance +
// low_balance_threshold off the coach row, and defaults safely (true / 2) when
// 0015 is unapplied, so book.html can render the low-balance + rebuy state and an
// old cached page keeps working. Runs with SCHEDULING_ENABLED on, in its own
// process (the flag is isolated from scheduling-off.test.js).

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SCHEDULING_ENABLED = "1";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";

const { app } = require("../index.js");

const TOKEN = "11111111-1111-1111-1111-111111111111";
const COACH_ID = "22222222-2222-2222-2222-222222222222";
const ATHLETE_ID = "33333333-3333-3333-3333-333333333333";
const FUTURE = new Date(Date.now() + 7 * 86400000).toISOString();

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request(port, { method = "GET", path = "/" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: { Accept: "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch (e) {}
          resolve({ status: res.statusCode, json, text: data });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function ok(json) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

// Route Supabase REST reads by URL. `coachReply` decides what the coaches
// balance-flags read returns, which is the whole point under test.
function installFetchMock(coachReply) {
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    if (u.includes("/booking_invites") && method === "GET") {
      return ok([
        {
          token: TOKEN,
          coach_id: COACH_ID,
          athlete_id: ATHLETE_ID,
          slot_id: null,
          email: null,
          status: "pending",
          expires_at: FUTURE,
          coaches: { full_name: "Coach CJ" },
          athletes: { name: "Athlete A", parent_email: null, user_id: null },
        },
      ]);
    }
    if (u.includes("/bookable_slots") && method === "GET") return ok([]);
    if (u.includes("/session_types") && method === "GET") return ok([]);
    if (u.includes("/package_purchases") && method === "GET") {
      return ok([{ credits_remaining: 3 }]);
    }
    if (u.includes("/coaches") && method === "GET") return coachReply();
    return { ok: true, status: 200, json: async () => [], text: async () => "" };
  };
  return {
    restore() {
      global.fetch = realFetch;
    },
  };
}

test("getSchedule surfaces the coach's balance flags when 0015 is applied", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock(() =>
    ok([{ athlete_sees_balance: false, low_balance_threshold: 5 }]),
  );
  try {
    const res = await request(port, { path: `/schedule/${TOKEN}` });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.athlete_sees_balance, false, "flag echoed off the coach row");
    assert.strictEqual(res.json.low_balance_threshold, 5, "threshold echoed off the coach row");
    // The additive fields ride ALONGSIDE the existing payload, unchanged.
    assert.strictEqual(res.json.credits, 3, "existing credits field is intact");
    assert.ok(Array.isArray(res.json.slots), "existing slots field is intact");
  } finally {
    mock.restore();
    server.close();
  }
});

test("getSchedule defaults the flags (true / 2) when 0015 is unapplied", async () => {
  const { server, port } = await startServer();
  // 0015 unapplied: the coaches read comes back with a row missing the columns.
  const mock = installFetchMock(() => ok([{}]));
  try {
    const res = await request(port, { path: `/schedule/${TOKEN}` });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.athlete_sees_balance, true, "defaults to visible");
    assert.strictEqual(res.json.low_balance_threshold, 2, "defaults to the shared 2");
  } finally {
    mock.restore();
    server.close();
  }
});

test("getSchedule keeps defaults when the coach read itself errors", async () => {
  const { server, port } = await startServer();
  // A hard failure on the coaches read must not break the picker: defaults hold.
  const mock = installFetchMock(() => ({
    ok: false,
    status: 400,
    json: async () => ({ message: "column does not exist" }),
    text: async () => "column does not exist",
  }));
  try {
    const res = await request(port, { path: `/schedule/${TOKEN}` });
    assert.strictEqual(res.status, 200, "the schedule still loads (picker never breaks)");
    assert.strictEqual(res.json.athlete_sees_balance, true);
    assert.strictEqual(res.json.low_balance_threshold, 2);
  } finally {
    mock.restore();
    server.close();
  }
});

test("getSchedule honors a threshold of 0 (empty-only low)", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock(() =>
    ok([{ athlete_sees_balance: true, low_balance_threshold: 0 }]),
  );
  try {
    const res = await request(port, { path: `/schedule/${TOKEN}` });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.low_balance_threshold, 0, "0 is a valid threshold, not coerced to the default");
  } finally {
    mock.restore();
    server.close();
  }
});
