// MCP endpoint tests (API_ENABLED ON). Drives the real /mcp Streamable HTTP
// transport in-process: initialize + tools/list + a tenant-locked tools/call
// round-trip, plus the no-key 401. Responses are SSE (text/event-stream); a tiny
// parser pulls the JSON-RPC message out of the `data:` line.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
process.env.API_ENABLED = "1";

const { app } = require("../index.js");
const { buildMcpServer } = require("../lib/mcp");
const { buildApiHandlers } = require("../lib/api-rest");

const COACH_ID = "33333333-3333-4333-8333-333333333333";
const KEY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ATHLETE_ID = "44444444-4444-4444-8444-444444444444";
const VALID_KEY = "ctk_" + "b".repeat(64);

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// POST a JSON-RPC message to /mcp. Accept must offer both json + event-stream
// (the Streamable HTTP transport requires it) or it answers 406.
function mcpPost(port, body, { auth = `Bearer ${VALID_KEY}` } = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "content-length": payload.length,
    };
    if (auth) headers.authorization = auth;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/mcp", method: "POST", headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, ct: res.headers["content-type"], body: data }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// Pull the last JSON-RPC message out of an SSE body (or parse a plain JSON body).
function parseRpc(raw) {
  const line = raw
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith("data: "));
  if (line) return JSON.parse(line.slice(6));
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function installFetchMock(routes) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ u, method, body: opts.body ? JSON.parse(opts.body) : null });
    for (const r of routes) {
      if (r.test(u, method)) return r.reply(u, method, opts);
    }
    return { ok: true, status: 200, json: async () => [], text: async () => "" };
  };
  return {
    calls,
    restore() {
      global.fetch = realFetch;
    },
  };
}

function ok(json) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

function liveKeyRoute() {
  return {
    test: (u, m) => u.includes("/api_keys") && u.includes("key_hash=eq.") && m === "GET",
    reply: () => ok([{ id: KEY_ID, coach_id: COACH_ID, rate_limit: 60, scopes: [] }]),
  };
}

const EXPECTED_TOOLS = [
  "list_athletes",
  "get_athlete",
  "create_athlete",
  "update_athlete",
  "list_sessions",
  "get_session",
  "list_slots",
  "generate_slots",
  "list_bookings",
  "cancel_booking",
  "list_packages",
  "get_credit_balances",
  "send_invite",
  "list_invites",
  "get_protection_policy",
  "set_protection_policy",
  "list_booking_charges",
  "charge_no_show",
  "waive_charge",
  "create_billing_plan",
  "list_subscriptions",
  "get_subscription",
  "pause_subscription",
  "resume_subscription",
  "cancel_subscription",
  "get_dashboard",
  "get_payments_overview",
  "record_payment",
  "void_payment",
  "create_charge",
  "import_athletes",
  "get_coach_page",
  "list_clips",
  "get_clip_url",
];

// ===========================================================================
// 1. initialize round-trips -> serverInfo "coachtime"
// ===========================================================================
test("POST /mcp initialize round-trips with a valid key", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([liveKeyRoute()]);
  try {
    const res = await mcpPost(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    assert.strictEqual(res.status, 200);
    const rpc = parseRpc(res.body);
    assert.ok(rpc && rpc.result, "an initialize result came back");
    assert.strictEqual(rpc.result.serverInfo.name, "coachtime");
    assert.ok(rpc.result.capabilities.tools, "the server advertises tools capability");
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 2. tools/list returns all 34 tools
// ===========================================================================
test("POST /mcp tools/list returns the full tool set", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([liveKeyRoute()]);
  try {
    const res = await mcpPost(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.strictEqual(res.status, 200);
    const rpc = parseRpc(res.body);
    assert.ok(rpc.result && Array.isArray(rpc.result.tools), "a tools array came back");
    const names = rpc.result.tools.map((t) => t.name).sort();
    for (const t of EXPECTED_TOOLS) {
      assert.ok(names.includes(t), `tool ${t} is exposed`);
    }
    assert.strictEqual(names.length, EXPECTED_TOOLS.length, "exactly the expected tools, no more");
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 3. tools/call list_athletes is tenant-locked to the key's coach
// ===========================================================================
test("POST /mcp tools/call list_athletes returns tenant-scoped data", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([
    liveKeyRoute(),
    {
      test: (u, m) => u.includes("/athletes") && u.includes(`coach_id=eq.${COACH_ID}`) && m === "GET",
      reply: () => ok([{ id: ATHLETE_ID, coach_id: COACH_ID, name: "Athlete A" }]),
    },
  ]);
  try {
    const res = await mcpPost(port, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_athletes", arguments: {} },
    });
    assert.strictEqual(res.status, 200);
    const rpc = parseRpc(res.body);
    assert.ok(rpc.result && !rpc.result.isError, "the tool call succeeded");
    const text = rpc.result.content[0].text;
    assert.ok(text.includes(ATHLETE_ID), "the athlete is in the tool result");
    // The underlying query was tenant-locked to the key's coach.
    const q = mock.calls.find((c) => c.u.includes("/athletes") && c.method === "GET" && c.u.includes("coach_id=eq."));
    assert.ok(q && q.u.includes(`coach_id=eq.${COACH_ID}`), "the MCP tool query is tenant-locked");
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 4. no key -> 401 (the MCP surface is not open to the world)
// ===========================================================================
test("POST /mcp with no key returns 401", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock([liveKeyRoute()]);
  try {
    const res = await mcpPost(port, { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }, { auth: null });
    assert.strictEqual(res.status, 401);
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/athletes")),
      "no tenant data is reached without a key",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

test("every new MCP tool delegates a happy path with the server-derived coach id", async () => {
  const calls = [];
  const apiCore = new Proxy({}, { get: (_target, method) => async (args) => {
    calls.push({ method: String(method), args });
    return { status: 200, data: { ok: true } };
  } });
  const server = buildMcpServer({ apiCore, coachId: COACH_ID });
  const cases = {
    get_protection_policy: {},
    set_protection_policy: { enabled: true, free_cancel_hours: 24,
      late_cancel_fee: { type: "percent", value: 50 }, no_show_fee: { type: "flat", value: 2500 } },
    list_booking_charges: {}, charge_no_show: { slot_id: ATHLETE_ID },
    waive_charge: { charge_id: ATHLETE_ID },
    create_billing_plan: { package_id: ATHLETE_ID, billing_type: "subscription", billing_interval: "month" },
    list_subscriptions: {}, get_subscription: { athlete_id: ATHLETE_ID },
    pause_subscription: { subscription_id: ATHLETE_ID }, resume_subscription: { subscription_id: ATHLETE_ID },
    cancel_subscription: { subscription_id: ATHLETE_ID, when: "period_end" },
    get_dashboard: {}, get_payments_overview: {},
    record_payment: { amount_cents: 5000, collected_via: "cash", athlete_id: ATHLETE_ID },
    void_payment: { payment_id: ATHLETE_ID }, create_charge: { label: "Lesson", amount_cents: 5000 },
    import_athletes: { rows: [{ name: "New Athlete" }], options: { dry_run: true } },
    get_coach_page: {}, list_clips: {}, get_clip_url: { clip_id: ATHLETE_ID },
  };
  for (const [name, args] of Object.entries(cases)) {
    const result = await server._registeredTools[name].handler(args);
    assert.strictEqual(result.isError, false, name);
  }
  assert.strictEqual(calls.length, Object.keys(cases).length);
  assert.ok(calls.every((c) => c.args.coachId === COACH_ID), "all tools inject the key's coach id");
  await server.close();
});

test("API and MCP subscription wrappers preserve shared input-validation precedence", async () => {
  const realFetch = global.fetch;
  const realUrl = process.env.SUPABASE_URL;
  const realKey = process.env.SUPABASE_SERVICE_KEY;
  const api = buildApiHandlers({ getStripeClient: () => { throw new Error("Stripe must not be reached"); } });
  const server = buildMcpServer({ apiCore: api.core, coachId: COACH_ID });
  const apiResponse = () => ({
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  const cases = [
    { id: ATHLETE_ID, when: "later", error: "invalid_when", unconfigured: false },
    { id: "malformed", when: undefined, error: "invalid_subscription_id", unconfigured: true },
    { id: ATHLETE_ID, when: "later", error: "invalid_when", unconfigured: true },
  ];
  try {
    global.fetch = async () => { throw new Error("ownership must not be reached"); };
    for (const c of cases) {
      if (c.unconfigured) {
        delete process.env.SUPABASE_URL;
        delete process.env.SUPABASE_SERVICE_KEY;
      }
      const res = apiResponse();
      await api.cancelSubscription({
        apiKey: { coachId: COACH_ID }, params: { id: c.id }, body: { when: c.when },
      }, res);
      assert.deepStrictEqual([res.statusCode, res.body], [400, { error: c.error }]);

      const result = await server._registeredTools.cancel_subscription.handler({
        subscription_id: c.id, ...(c.when === undefined ? {} : { when: c.when }),
      });
      assert.strictEqual(result.isError, true);
      assert.deepStrictEqual(JSON.parse(result.content[0].text), { error: c.error });
    }
  } finally {
    global.fetch = realFetch;
    process.env.SUPABASE_URL = realUrl;
    process.env.SUPABASE_SERVICE_KEY = realKey;
    await server.close();
  }
});
