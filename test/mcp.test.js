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
// 2. tools/list returns all 14 tools
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
