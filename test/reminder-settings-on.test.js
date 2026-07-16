const test = require("node:test");
const assert = require("node:assert/strict");

const mod = require("../lib/reminder-settings");
const COACH = "11111111-1111-4111-8111-111111111111";
const RULE = "22222222-2222-4222-8222-222222222222";
const TYPE = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-07-16T12:00:00.000Z";
process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_KEY = "service";

function req(overrides = {}) { return { query: {}, params: {}, body: {}, ...overrides }; }
function res() { return { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } }; }
function coachAuth() { return async () => ({ user: { id: COACH, app_metadata: { role: "coach" }, user_metadata: { role: "athlete" } } }); }
function response(value, status = 200) { return new Response(typeof value === "string" ? value : JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function presetRow(p, n = 0) { return { id: `${n + 4}0000000-0000-4000-8000-000000000000`, coach_id: COACH, ...p, created_at: NOW, updated_at: NOW }; }

test("exports inert builders and pure contract helpers", () => {
  assert.equal(typeof mod.buildReminderSettingsHandlers, "function");
  assert.equal(typeof mod.buildReminderRulesProvider, "function");
  assert.deepEqual(mod.PRESETS.map((x) => x.preset_key), mod.PRESET_ORDER);
  assert.equal(mod.PRESETS.find((x) => x.preset_key === "low_credits").recipient, "athlete");
  assert.deepEqual(Object.keys(mod.buildReminderSettingsHandlers({})), ["getRules", "postRule", "patchRule", "deleteRule", "getSettings", "patchSettings"]);
});

test("all request shape validation precedes auth", async () => {
  let auth = 0;
  const h = mod.buildReminderSettingsHandlers({ requireSupabaseUser: async () => { auth++; return coachAuth()(); } });
  for (const [name, request] of [
    ["getRules", req({ query: { extra: "1" } })],
    ["postRule", req({ body: { trigger: "low_credits", title: "x", body: "{time}" } })],
    ["patchRule", req({ params: { id: "not-a-uuid" }, body: { enabled: true } })],
    ["deleteRule", req({ params: { id: RULE }, body: { extra: true } })],
    ["getSettings", req({ body: { extra: true } })],
    ["patchSettings", req({ body: { timezone: "-05:00" } })],
  ]) { const out = res(); await h[name](request, out); assert.deepEqual([out.statusCode, out.body], [400, { error: "invalid_request" }], name); }
  assert.equal(auth, 0);
});

test("coach authority is app_metadata only and missing dependencies/config are 503", async () => {
  let out = res(); await mod.buildReminderSettingsHandlers({ requireSupabaseUser: async () => ({ user: { id: COACH, app_metadata: {}, user_metadata: { role: "coach" } } }) }).getRules(req(), out);
  assert.deepEqual([out.statusCode, out.body], [403, { error: "forbidden" }]);
  out = res(); await mod.buildReminderSettingsHandlers({}).getRules(req(), out); assert.equal(out.statusCode, 503);
  const saved = process.env.SUPABASE_SERVICE_KEY; delete process.env.SUPABASE_SERVICE_KEY;
  try { out = res(); await mod.buildReminderSettingsHandlers({ requireSupabaseUser: coachAuth() }).getRules(req(), out); assert.equal(out.statusCode, 503); } finally { process.env.SUPABASE_SERVICE_KEY = saved; }
});

test("rule validation normalizes offsets and pins trigger coupling/templates", () => {
  const row = mod.createRule({ trigger: "session_upcoming", title: " Soon ", body: "{service} for {athlete}", offsets_minutes: [60, 1440], session_type_id: TYPE, recipient: "both" });
  assert.deepEqual(row.offsets_minutes, [1440, 60]); assert.equal(row.title, "Soon");
  assert.throws(() => mod.createRule({ trigger: "session_upcoming", title: "x", body: "x", offsets_minutes: [60, 80], session_type_id: TYPE }));
  assert.throws(() => mod.createRule({ trigger: "low_credits", title: "x", body: "{credits}", threshold_value: 2 }));
  assert.throws(() => mod.createRule({ trigger: "homework_due", title: "x", body: "{time}", threshold_value: 1, threshold_unit: "days" }));
});

test("CREATE rejects explicit null or undefined typed values and presets stay all-services", () => {
  const base = { trigger:"session_upcoming", title:"Soon", body:"{service}", offsets_minutes:[60], session_type_id:TYPE };
  for (const patch of [{enabled:null},{enabled:undefined},{recipient:null},{recipient:undefined},{offsets_minutes:null},{offsets_minutes:undefined}]) {
    assert.throws(() => mod.createRule({...base,...patch}));
  }
  assert.throws(() => mod.validateRule({...mod.PRESETS[0],session_type_id:TYPE},{preset:true}));
  assert.throws(() => mod.mergeRule(presetRow(mod.PRESETS[0]),{session_type_id:TYPE}));
});

test("missing preset repair is tenant-filtered, exact, and DTO-stripped", async () => {
  const calls = []; let rows = [presetRow(mod.PRESETS[0], 0)];
  const real = global.fetch;
  global.fetch = async (url, opts) => { calls.push([String(url), opts]); if ((opts.method || "GET") === "POST") { const body = JSON.parse(opts.body); const inserted = body.map((x, i) => presetRow(x, i + 1)); rows.push(...inserted); return response(inserted, 201); } return response(rows); };
  try { const out = res(); await mod.buildReminderSettingsHandlers({ requireSupabaseUser: coachAuth() }).getRules(req(), out); assert.equal(out.statusCode, 200); assert.deepEqual(out.body.seeded_preset_keys, mod.PRESET_ORDER.slice(1)); assert.equal(out.body.rules.length, 5); assert.ok(calls.every(([u]) => !u.includes("reminder_rules?") || u.includes(`coach_id=eq.${COACH}`) || u.includes("on_conflict=coach_id,preset_key"))); assert.equal("coach_id" in out.body.rules[0], false); assert.equal(calls[1][1].headers.prefer, "resolution=ignore-duplicates,return=representation"); }
  finally { global.fetch = real; }
});

test("POST validates owned FK and every write repeats derived tenant", async () => {
  const calls = [], real = global.fetch;
  global.fetch = async (url, opts) => { calls.push([String(url), opts]); const u = String(url); if (u.includes("session_types")) return response([{ id: TYPE }]); if (u.includes("is_preset=eq.false")) return response([]); const body = JSON.parse(opts.body); return response([{ id: RULE, ...body, created_at: NOW, updated_at: NOW }], 201); };
  try { const out = res(); await mod.buildReminderSettingsHandlers({ requireSupabaseUser: coachAuth() }).postRule(req({ body: { trigger: "session_upcoming", offsets_minutes: [60], session_type_id: TYPE, recipient: "both", title: "Soon", body: "{service}" } }), out); assert.equal(out.statusCode, 201); assert.equal(out.body.rule.id, RULE); assert.ok(calls[0][0].includes(`coach_id=eq.${COACH}`)); assert.equal(JSON.parse(calls.at(-1)[1].body).coach_id, COACH); }
  finally { global.fetch = real; }
});

test("foreign IDs are uniform 404 and preset DELETE is locked", async () => {
  const real = global.fetch;
  try {
    global.fetch = async () => response([]); let out = res(); await mod.buildReminderSettingsHandlers({ requireSupabaseUser: coachAuth() }).deleteRule(req({ params: { id: RULE } }), out); assert.deepEqual([out.statusCode, out.body], [404, { error: "not_found" }]);
    global.fetch = async () => response([presetRow(mod.PRESETS[0])]); out = res(); await mod.buildReminderSettingsHandlers({ requireSupabaseUser: coachAuth() }).deleteRule(req({ params: { id: RULE } }), out); assert.deepEqual([out.statusCode, out.body], [409, { error: "preset_locked" }]);
  } finally { global.fetch = real; }
});

test("settings repair, merge, overnight windows, and canonical DTO", async () => {
  const real = global.fetch; let row = null;
  global.fetch = async (_url, opts) => { const method = opts.method || "GET"; if (method === "GET") return response(row ? [row] : []); if (method === "POST") { row = { ...JSON.parse(opts.body), updated_at: NOW }; return response([row], 201); } row = { ...row, ...JSON.parse(opts.body) }; return response([row]); };
  try { const h = mod.buildReminderSettingsHandlers({ requireSupabaseUser: coachAuth(), now: () => new Date(NOW) }); let out = res(); await h.getSettings(req(), out); assert.deepEqual(out.body.settings, { quiet_start: null, quiet_end: null, timezone: "America/New_York", updated_at: NOW }); out = res(); await h.patchSettings(req({ body: { quiet_start: "21:00", quiet_end: "08:00", timezone: " America/Los_Angeles " } }), out); assert.equal(out.statusCode, 200); assert.equal(out.body.settings.timezone, "America/Los_Angeles"); assert.equal(mod.quietAt(Date.parse("2026-07-16T06:00:00Z"), "America/Los_Angeles", "21:00", "08:00"), true); }
  finally { global.fetch = real; }
});

test("malformed 2xx JSON is internal_error, never fake success", async () => {
  const real = global.fetch; global.fetch = async () => response("not-json");
  try { const out = res(); await mod.buildReminderSettingsHandlers({ requireSupabaseUser: coachAuth() }).getRules(req(), out); assert.deepEqual([out.statusCode, out.body], [500, { error: "internal_error" }]); } finally { global.fetch = real; }
});

test("POST and PATCH reject malformed rule mutation representations", async () => {
  const valid = presetRow({ ...mod.PRESETS[3], enabled: true });
  const real = global.fetch;
  try {
    global.fetch = async (_url, opts = {}) => (opts.method || "GET") === "POST" ? response([{}], 201) : response([]);
    let out = res(); await mod.buildReminderSettingsHandlers({ requireSupabaseUser: coachAuth() }).postRule(req({ body: { trigger: "low_credits", title: "Low", body: "{credits}" } }), out);
    assert.deepEqual([out.statusCode, out.body], [500, { error: "internal_error" }]);

    global.fetch = async (_url, opts = {}) => (opts.method || "GET") === "PATCH" ? response([{}]) : response([valid]);
    out = res(); await mod.buildReminderSettingsHandlers({ requireSupabaseUser: coachAuth(), now: () => new Date(NOW) }).patchRule(req({ params: { id: valid.id }, body: { enabled: false } }), out);
    assert.deepEqual([out.statusCode, out.body], [500, { error: "internal_error" }]);
  } finally { global.fetch = real; }
});

test("PATCH distinguishes a non-array representation from an empty owned result", async () => {
  const valid = presetRow({ ...mod.PRESETS[3], enabled: true });
  const real = global.fetch;
  try {
    for (const [representation, expected] of [
      [{ unexpected: "object" }, [500, { error: "internal_error" }]],
      [[], [404, { error: "not_found" }]],
    ]) {
      global.fetch = async (_url, opts = {}) => (opts.method || "GET") === "PATCH" ? response(representation) : response([valid]);
      const out = res();
      await mod.buildReminderSettingsHandlers({ requireSupabaseUser: coachAuth(), now: () => new Date(NOW) }).patchRule(req({ params: { id: valid.id }, body: { enabled: false } }), out);
      assert.deepEqual([out.statusCode, out.body], expected);
    }
  } finally { global.fetch = real; }
});
