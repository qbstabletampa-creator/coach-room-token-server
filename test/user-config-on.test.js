// User-config editor (Lane A REST) + Lane B apiCore/MCP tests. Mirrors
// reminder-settings-on.test.js: a fake Supabase is a stubbed global.fetch that
// returns real Response objects, req()/res() recorders drive the handlers, and
// every assertion pins a real behavior (shape-before-auth, app_metadata-only
// authority, tenant filter on every URL, upsert conflict param, malformed 2xx
// mapping to 500, the per-namespace key cap 409, and the value-size 400).

const test = require("node:test");
const assert = require("node:assert/strict");

const mod = require("../lib/user-config");
const { buildMcpServer } = require("../lib/mcp");
const { buildApiHandlers } = require("../lib/api-rest");

const COACH = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-07-21T12:00:00.000Z";
process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_KEY = "service";

function req(overrides = {}) { return { query: {}, params: {}, body: {}, ...overrides }; }
function res() { return { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } }; }
function coachAuth() { return async () => ({ user: { id: COACH, app_metadata: { role: "coach" }, user_metadata: { role: "athlete" } } }); }
function response(value, status = 200) { return new Response(typeof value === "string" ? value : JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }

test("exports the inert Lane A builder and the Lane B core functions", () => {
  assert.equal(typeof mod.buildUserConfigHandlers, "function");
  assert.deepEqual(Object.keys(mod.buildUserConfigHandlers({})), ["getConfig", "getNamespace", "putKey", "deleteKey"]);
  for (const fn of ["getConfig", "setConfig", "deleteConfig", "renameLabel", "listSavedViews", "saveView", "deleteView", "getPins", "setPins"]) {
    assert.equal(typeof mod[fn], "function", fn);
  }
});

test("all request shape validation precedes auth", async () => {
  let auth = 0;
  const h = mod.buildUserConfigHandlers({ requireSupabaseUser: async () => { auth++; return coachAuth()(); } });
  const big = "x".repeat(20000);
  for (const [name, request] of [
    ["getConfig", req({ query: { extra: "1" } })],
    ["getNamespace", req({ params: { namespace: "not-allowed" } })],
    ["putKey", req({ params: { namespace: "labels", key: "tab.you" }, body: { extra: true } })],
    ["putKey", req({ params: { namespace: "labels", key: "tab.you" }, body: { value: big } })],
    ["putKey", req({ params: { namespace: "bogus", key: "tab.you" }, body: { value: { text: "x" } } })],
    ["putKey", req({ params: { namespace: "labels", key: "bad key!" }, body: { value: { text: "x" } } })],
    ["deleteKey", req({ params: { namespace: "labels", key: "tab.you" }, body: { extra: 1 } })],
  ]) { const out = res(); await h[name](request, out); assert.deepEqual([out.statusCode, out.body], [400, { error: "invalid_request" }], name); }
  assert.equal(auth, 0);
});

test("coach authority is app_metadata only and missing dependencies/config are 503", async () => {
  let out = res();
  await mod.buildUserConfigHandlers({ requireSupabaseUser: async () => ({ user: { id: COACH, app_metadata: {}, user_metadata: { role: "coach" } } }) }).getConfig(req(), out);
  assert.deepEqual([out.statusCode, out.body], [403, { error: "forbidden" }]);
  out = res(); await mod.buildUserConfigHandlers({}).getConfig(req(), out); assert.equal(out.statusCode, 503);
  const saved = process.env.SUPABASE_SERVICE_KEY; delete process.env.SUPABASE_SERVICE_KEY;
  try { out = res(); await mod.buildUserConfigHandlers({ requireSupabaseUser: coachAuth() }).getConfig(req(), out); assert.equal(out.statusCode, 503); }
  finally { process.env.SUPABASE_SERVICE_KEY = saved; }
});

test("GET snapshot groups rows by namespace and every query is tenant-filtered", async () => {
  const calls = []; const real = global.fetch;
  global.fetch = async (url, opts) => { calls.push([String(url), opts]); return response([
    { namespace: "labels", key: "tab.you", value: { text: "You" } },
    { namespace: "pins", key: "menu", value: { items: [] } },
  ]); };
  try {
    const out = res(); await mod.buildUserConfigHandlers({ requireSupabaseUser: coachAuth() }).getConfig(req(), out);
    assert.equal(out.statusCode, 200);
    assert.deepEqual(out.body, { config: { labels: { "tab.you": { text: "You" } }, pins: { menu: { items: [] } } } });
    assert.ok(calls.every(([u]) => u.includes(`coach_id=eq.${COACH}`)), "tenant filter present on every URL");
  } finally { global.fetch = real; }
});

test("PUT upserts with the merge-duplicates conflict target and re-derives the tenant in the body", async () => {
  const calls = []; const real = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push([String(url), opts]);
    if ((opts.method || "GET") === "GET") return response([]); // namespace has no keys yet
    const body = JSON.parse(opts.body); return response([{ namespace: body.namespace, key: body.key, value: body.value, updated_at: NOW }], 201);
  };
  try {
    const out = res();
    await mod.buildUserConfigHandlers({ requireSupabaseUser: coachAuth(), now: () => new Date(NOW) })
      .putKey(req({ params: { namespace: "labels", key: "tab.you" }, body: { value: { text: "You" } } }), out);
    assert.equal(out.statusCode, 200);
    assert.deepEqual(out.body.entry, { namespace: "labels", key: "tab.you", value: { text: "You" }, updated_at: NOW });
    const post = calls.find(([, o]) => (o.method || "GET") === "POST");
    assert.ok(post[0].includes("on_conflict=coach_id,namespace,key"), "conflict target on the upsert URL");
    assert.match(post[1].headers.prefer, /resolution=merge-duplicates/);
    assert.equal(JSON.parse(post[1].body).coach_id, COACH, "the body coach_id is the derived tenant");
    assert.ok(calls.every(([u]) => u.includes(`coach_id=eq.${COACH}`)), "tenant filter present on every URL");
  } finally { global.fetch = real; }
});

test("PUT of a new key past the per-namespace cap is 409 key_limit and never writes", async () => {
  const real = global.fetch; let posted = false;
  const full = Array.from({ length: 50 }, (_, i) => ({ key: `p${i}` })); // pins cap is 50
  global.fetch = async (url, opts) => { if ((opts.method || "GET") === "GET") return response(full); posted = true; return response([{}], 201); };
  try {
    const out = res();
    await mod.buildUserConfigHandlers({ requireSupabaseUser: coachAuth() })
      .putKey(req({ params: { namespace: "pins", key: "menu" }, body: { value: { items: [] } } }), out);
    assert.deepEqual([out.statusCode, out.body], [409, { error: "key_limit" }]);
    assert.equal(posted, false, "the write never fires once the cap is hit");
  } finally { global.fetch = real; }
});

test("PUT of an EXISTING key past the cap still succeeds (update is not a new key)", async () => {
  const real = global.fetch;
  const full = Array.from({ length: 50 }, (_, i) => ({ key: i === 0 ? "menu" : `p${i}` }));
  global.fetch = async (url, opts) => { if ((opts.method || "GET") === "GET") return response(full); const b = JSON.parse(opts.body); return response([{ namespace: b.namespace, key: b.key, value: b.value, updated_at: NOW }], 201); };
  try {
    const out = res();
    await mod.buildUserConfigHandlers({ requireSupabaseUser: coachAuth(), now: () => new Date(NOW) })
      .putKey(req({ params: { namespace: "pins", key: "menu" }, body: { value: { items: [] } } }), out);
    assert.equal(out.statusCode, 200);
  } finally { global.fetch = real; }
});

test("DELETE is tenant-filtered and reports whether a row was removed", async () => {
  const calls = []; const real = global.fetch;
  global.fetch = async (url, opts) => { calls.push(String(url)); return response([{ namespace: "labels", key: "tab.you" }]); };
  try {
    const out = res();
    await mod.buildUserConfigHandlers({ requireSupabaseUser: coachAuth() })
      .deleteKey(req({ params: { namespace: "labels", key: "tab.you" } }), out);
    assert.deepEqual([out.statusCode, out.body], [200, { deleted: true }]);
    assert.ok(calls.every((u) => u.includes(`coach_id=eq.${COACH}`) && u.includes("namespace=eq.labels") && u.includes("key=eq.tab.you")));
  } finally { global.fetch = real; }
});

test("malformed 2xx JSON is internal_error, never fake success", async () => {
  const real = global.fetch; global.fetch = async () => response("not-json");
  try { const out = res(); await mod.buildUserConfigHandlers({ requireSupabaseUser: coachAuth() }).getConfig(req(), out); assert.deepEqual([out.statusCode, out.body], [500, { error: "internal_error" }]); }
  finally { global.fetch = real; }
});

// ===== Lane B: apiCore contract ({status,data}) =====
test("Lane B setConfig rejects a bad namespace with 400 and never touches the DB", async () => {
  const real = global.fetch; let hit = false; global.fetch = async () => { hit = true; return response([]); };
  try {
    const out = await mod.setConfig({ coachId: COACH, namespace: "nope", key: "k", value: { text: "x" } });
    assert.equal(out.status, 400);
    assert.equal(hit, false);
  } finally { global.fetch = real; }
});

test("Lane B getConfig full snapshot and single namespace are both tenant-locked", async () => {
  const calls = []; const real = global.fetch;
  global.fetch = async (url) => { calls.push(String(url)); return response([{ namespace: "labels", key: "tab.you", value: { text: "You" } }]); };
  try {
    const snap = await mod.getConfig({ coachId: COACH });
    assert.deepEqual(snap, { status: 200, data: { config: { labels: { "tab.you": { text: "You" } } } } });
    const ns = await mod.getConfig({ coachId: COACH, namespace: "labels" });
    assert.equal(ns.status, 200); assert.deepEqual(ns.data.entries, { "tab.you": { text: "You" } });
    assert.ok(calls.every((u) => u.includes(`coach_id=eq.${COACH}`)));
  } finally { global.fetch = real; }
});

// ===== Lane B: MCP twins delegate with the server-derived coachId =====
test("every config MCP tool delegates with the server-derived coach id", async () => {
  const calls = [];
  const apiCore = new Proxy({}, { get: (_t, method) => async (args) => { calls.push({ method: String(method), args }); return { status: 200, data: { ok: true } }; } });
  const server = buildMcpServer({ apiCore, coachId: COACH });
  const cases = {
    get_config: {},
    set_config_key: { namespace: "labels", key: "tab.you", value: { text: "You" } },
    delete_config_key: { namespace: "labels", key: "tab.you" },
    rename_label: { label_id: "tab.you", text: "You" },
    list_saved_views: { screen: "athletes" },
    save_view: { view: { id: "v1", name: "Mine", screen: "athletes", filters: {}, sort: null } },
    delete_view: { screen: "athletes", view_id: "v1" },
    get_pins: {},
    set_pins: { items: [{ id: "a", label: "A", route: "/a", icon: "star" }] },
  };
  for (const [name, args] of Object.entries(cases)) {
    const result = await server._registeredTools[name].handler(args);
    assert.strictEqual(result.isError, false, name);
  }
  assert.equal(calls.length, Object.keys(cases).length);
  assert.ok(calls.every((c) => c.args.coachId === COACH), "all config tools inject the key's coach id");
  const rename = calls.find((c) => c.method === "renameLabel");
  assert.deepEqual([rename.args.labelId, rename.args.text], ["tab.you", "You"]);
  const delView = calls.find((c) => c.method === "deleteView");
  assert.deepEqual([delView.args.screen, delView.args.viewId], ["athletes", "v1"]);
  await server.close();
});
