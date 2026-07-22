// User-config: the app-wide configurability KV surface (namespaces labels/pins/
// views/layout) exposed to coaches. This module is the schema CONSUMER of the
// public.user_config table (migration 0031 in the app repo): it reads/writes
// with the SERVICE KEY and manually appends coach_id=eq.<id> to every PostgREST
// query, exactly like every other token-server module. RLS ("tenant all") is the
// backstop; the manual coach_id lock is defense in depth.
//
// Two lanes share the validators + PostgREST helpers below:
//   * Lane A (buildUserConfigHandlers): coach-JWT Express handlers, gated in
//     index.js behind USER_CONFIG_ENABLED. Hand-rolled exactKeys shape checks run
//     BEFORE auth; replyError maps TypeError -> 400 invalid_request, DbError ->
//     500 internal_error; missing dep/config -> 503 not_configured. Mirrors
//     lib/reminder-settings.js in every convention.
//   * Lane B (getConfig/setConfig/... exported below): pure { status, data }
//     functions the api-rest apiCore + MCP tools reuse with a server-derived
//     coachId. Same validators, same tenant lock.
//
// This module is deliberately inert: env, auth, and fetch are consulted only when
// a returned handler/function is invoked.

class DbError extends Error {
  constructor(method, status, detail) {
    super(`supabase ${method} ${status}: ${detail || ""}`);
    this.name = "DbError";
    this.method = method;
    this.status = status;
    this.detail = String(detail || "");
  }
}

// The namespace allowlist mirrors the 0031 check constraint. New surfaces become
// new namespaces here + in the DDL, no other code change.
const NAMESPACES = new Set(["labels", "pins", "views", "layout"]);
// Per-namespace key-count caps (bound agent write abuse; the 409 mirrors the
// reminder rule_limit pattern). 16 KB value cap matches the 0031 DDL backstop.
const NS_CAPS = Object.freeze({ labels: 500, pins: 50, views: 100, layout: 100 });
const KEY_MAX = 200; // char_length(key) between 1 and 200 in the DDL
const VALUE_MAX_BYTES = 16384; // pg_column_size(value) <= 16384 in the DDL
// Keys are stable dotted/colon/dashed ids: tab.you, athletes:__last, dashboard.cards.
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ownObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(obj, allowed, { required = [], nonempty = false } = {}) {
  if (!ownObject(obj)) return false;
  const keys = Object.keys(obj);
  return (!nonempty || keys.length > 0) && keys.every((k) => allowed.includes(k)) && required.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

// ---- validators (throw TypeError; each lane maps that to 400) ----
function validNamespace(ns) { if (typeof ns !== "string" || !NAMESPACES.has(ns)) throw new TypeError("invalid namespace"); return ns; }
function validKey(key) { if (typeof key !== "string" || key.length < 1 || key.length > KEY_MAX || !KEY_RE.test(key)) throw new TypeError("invalid key"); return key; }
function normalizeValue(value) {
  if (value === undefined || value === null) throw new TypeError("invalid value");
  let json;
  try { json = JSON.stringify(value); } catch (_) { throw new TypeError("invalid value"); }
  if (typeof json !== "string") throw new TypeError("invalid value"); // functions/undefined
  if (Buffer.byteLength(json, "utf8") > VALUE_MAX_BYTES) throw new TypeError("value too large");
  return value;
}

// ---- PostgREST helpers (service role, same posture as reminder-settings.js) ----
function service() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  return url && key ? { url: url.replace(/\/$/, ""), headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" } } : null;
}
async function strictJson(resp, method) {
  let raw; try { raw = await resp.text(); } catch (_) { throw new DbError(method, resp.status || 0, "response read failed"); }
  if (!resp.ok) throw new DbError(method, resp.status || 0, raw);
  try { return JSON.parse(raw); } catch (_) { throw new DbError(method, resp.status || 0, "invalid json"); }
}
async function db(s, path, { method = "GET", body, prefer, fetchImpl = (...a) => fetch(...a) } = {}) {
  let resp;
  const headers = { ...s.headers }; if (prefer) headers.prefer = prefer;
  try { resp = await fetchImpl(`${s.url}/rest/v1/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch (_) { throw new DbError(method, 0, "network failure"); }
  return strictJson(resp, method);
}
function enc(v) { return encodeURIComponent(v); }
function tableFilter(coachId, extra = "") { return `user_config?coach_id=eq.${enc(coachId)}${extra}`; }

// ---- shared reads/writes (throw DbError on any storage failure) ----
async function readSnapshot(s, coachId) {
  const rows = await db(s, `${tableFilter(coachId)}&select=namespace,key,value&order=namespace.asc,key.asc`);
  if (!Array.isArray(rows)) throw new DbError("GET", 200, "invalid representation");
  const config = {};
  for (const r of rows) {
    if (!ownObject(r) || typeof r.namespace !== "string" || typeof r.key !== "string") throw new DbError("GET", 200, "invalid config row");
    (config[r.namespace] || (config[r.namespace] = {}))[r.key] = r.value;
  }
  return config;
}
async function readNamespace(s, coachId, ns) {
  const rows = await db(s, `${tableFilter(coachId, `&namespace=eq.${enc(ns)}`)}&select=key,value&order=key.asc`);
  if (!Array.isArray(rows)) throw new DbError("GET", 200, "invalid representation");
  const entries = {};
  for (const r of rows) { if (!ownObject(r) || typeof r.key !== "string") throw new DbError("GET", 200, "invalid config row"); entries[r.key] = r.value; }
  return entries;
}
async function nsKeys(s, coachId, ns) {
  const rows = await db(s, `${tableFilter(coachId, `&namespace=eq.${enc(ns)}`)}&select=key`);
  if (!Array.isArray(rows)) throw new DbError("GET", 200, "invalid representation");
  return rows.map((r) => r && r.key).filter((k) => typeof k === "string");
}
// True when writing this key would push the namespace past its cap (new key only).
async function overCap(s, coachId, ns, key) {
  const keys = await nsKeys(s, coachId, ns);
  return !keys.includes(key) && keys.length >= (NS_CAPS[ns] || 0);
}
async function upsertRow(s, coachId, ns, key, value, updatedAt) {
  const rows = await db(s, `${tableFilter(coachId)}&on_conflict=coach_id,namespace,key`, {
    method: "POST",
    body: { coach_id: coachId, namespace: ns, key, value, updated_at: updatedAt },
    prefer: "resolution=merge-duplicates,return=representation",
  });
  if (!Array.isArray(rows) || rows.length !== 1 || !ownObject(rows[0])) throw new DbError("POST", 200, "missing representation");
  const row = rows[0];
  if (typeof row.namespace !== "string" || typeof row.key !== "string" || typeof row.updated_at !== "string") throw new DbError("POST", 200, "invalid representation");
  return { namespace: row.namespace, key: row.key, value: row.value, updated_at: row.updated_at };
}
async function deleteRow(s, coachId, ns, key) {
  const rows = await db(s, tableFilter(coachId, `&namespace=eq.${enc(ns)}&key=eq.${enc(key)}`), { method: "DELETE", prefer: "return=representation" });
  if (!Array.isArray(rows)) throw new DbError("DELETE", 200, "invalid representation");
  return rows.length > 0;
}

// ---- error mapping (Lane A) ----
function replyError(res, err) {
  if (err instanceof TypeError) return res.status(400).json({ error: "invalid_request" });
  return res.status(500).json({ error: "internal_error" });
}
async function coach(req, res, requireSupabaseUser) {
  if (typeof requireSupabaseUser !== "function") { res.status(503).json({ error: "not_configured" }); return null; }
  let authd; try { authd = await requireSupabaseUser(req); } catch (_) { res.status(401).json({ error: "unauthorized" }); return null; }
  if (!authd || !authd.user) { res.status(authd?.status || 401).json({ error: authd?.error || "unauthorized" }); return null; }
  if (authd.user.app_metadata?.role !== "coach") { res.status(403).json({ error: "forbidden" }); return null; }
  return authd.user.id;
}

// ===========================================================================
// Lane A: coach-JWT Express handlers (gated by USER_CONFIG_ENABLED in index.js)
// ===========================================================================
function buildUserConfigHandlers({ requireSupabaseUser, now = () => new Date() } = {}) {
  async function begin(req, res) {
    const id = await coach(req, res, requireSupabaseUser); if (!id) return null;
    const s = service(); if (!s) { res.status(503).json({ error: "not_configured" }); return null; }
    return { id, s };
  }
  return {
    async getConfig(req, res) {
      if (!exactKeys(req.query || {}, []) || !exactKeys(req.body || {}, []) || !exactKeys(req.params || {}, [])) return replyError(res, new TypeError());
      const ctx = await begin(req, res); if (!ctx) return;
      try { res.json({ config: await readSnapshot(ctx.s, ctx.id) }); } catch (e) { replyError(res, e); }
    },
    async getNamespace(req, res) {
      if (!exactKeys(req.query || {}, []) || !exactKeys(req.body || {}, []) || !exactKeys(req.params || {}, ["namespace"], { required: ["namespace"] })) return replyError(res, new TypeError());
      let ns; try { ns = validNamespace(req.params.namespace); } catch (e) { return replyError(res, e); }
      const ctx = await begin(req, res); if (!ctx) return;
      try { res.json({ namespace: ns, entries: await readNamespace(ctx.s, ctx.id, ns) }); } catch (e) { replyError(res, e); }
    },
    async putKey(req, res) {
      if (!exactKeys(req.query || {}, []) || !exactKeys(req.params || {}, ["namespace", "key"], { required: ["namespace", "key"] }) || !exactKeys(req.body, ["value"], { required: ["value"] })) return replyError(res, new TypeError());
      let ns, key, value;
      try { ns = validNamespace(req.params.namespace); key = validKey(req.params.key); value = normalizeValue(req.body.value); } catch (e) { return replyError(res, e); }
      const ctx = await begin(req, res); if (!ctx) return;
      try {
        if (await overCap(ctx.s, ctx.id, ns, key)) return res.status(409).json({ error: "key_limit" });
        res.json({ entry: await upsertRow(ctx.s, ctx.id, ns, key, value, now().toISOString()) });
      } catch (e) { replyError(res, e); }
    },
    async deleteKey(req, res) {
      if (!exactKeys(req.query || {}, []) || !exactKeys(req.body || {}, []) || !exactKeys(req.params || {}, ["namespace", "key"], { required: ["namespace", "key"] })) return replyError(res, new TypeError());
      let ns, key; try { ns = validNamespace(req.params.namespace); key = validKey(req.params.key); } catch (e) { return replyError(res, e); }
      const ctx = await begin(req, res); if (!ctx) return;
      try { res.json({ deleted: await deleteRow(ctx.s, ctx.id, ns, key) }); } catch (e) { replyError(res, e); }
    },
  };
}

// ===========================================================================
// Lane B: pure { status, data } core reused by api-rest apiCore + MCP tools.
// coachId is always server-derived by the caller. Validation failures surface as
// 400; storage/network failures throw DbError (the apiCore run() wrapper turns
// that into a clean 502, never a stack-leaking 500).
// ===========================================================================
function bad(error) { return { status: 400, data: { error } }; }
function notConfigured() { return { status: 503, data: { error: "not_configured" } }; }

async function getConfig({ coachId, namespace }) {
  const s = service(); if (!s) return notConfigured();
  if (namespace !== undefined) { try { validNamespace(namespace); } catch (_) { return bad("invalid_namespace"); }
    return { status: 200, data: { namespace, entries: await readNamespace(s, coachId, namespace) } }; }
  return { status: 200, data: { config: await readSnapshot(s, coachId) } };
}
async function setConfig({ coachId, namespace, key, value }) {
  let ns, k, v; try { ns = validNamespace(namespace); k = validKey(key); v = normalizeValue(value); } catch (_) { return bad("invalid_request"); }
  const s = service(); if (!s) return notConfigured();
  if (await overCap(s, coachId, ns, k)) return { status: 409, data: { error: "key_limit" } };
  return { status: 200, data: { entry: await upsertRow(s, coachId, ns, k, v, new Date().toISOString()) } };
}
async function deleteConfig({ coachId, namespace, key }) {
  let ns, k; try { ns = validNamespace(namespace); k = validKey(key); } catch (_) { return bad("invalid_request"); }
  const s = service(); if (!s) return notConfigured();
  return { status: 200, data: { deleted: await deleteRow(s, coachId, ns, k), namespace: ns, key: k } };
}
// sugar over the labels namespace
async function renameLabel({ coachId, labelId, text }) {
  if (typeof text !== "string" || !text.trim() || text.length > 1000) return bad("invalid_request");
  return setConfig({ coachId, namespace: "labels", key: labelId, value: { text } });
}
// sugar over the views namespace: keys are `<screen>:<viewId>`
function viewKey(screen, viewId) { return `${screen}:${viewId}`; }
async function listSavedViews({ coachId, screen }) {
  if (typeof screen !== "string" || !KEY_RE.test(screen)) return bad("invalid_request");
  const s = service(); if (!s) return notConfigured();
  const entries = await readNamespace(s, coachId, "views");
  const prefix = `${screen}:`;
  const views = Object.entries(entries).filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
  return { status: 200, data: { screen, views } };
}
async function saveView({ coachId, view }) {
  if (!ownObject(view) || typeof view.screen !== "string" || typeof view.id !== "string" || !KEY_RE.test(view.screen) || !KEY_RE.test(view.id)) return bad("invalid_request");
  return setConfig({ coachId, namespace: "views", key: viewKey(view.screen, view.id), value: view });
}
async function deleteView({ coachId, screen, viewId }) {
  if (typeof screen !== "string" || typeof viewId !== "string" || !KEY_RE.test(screen) || !KEY_RE.test(viewId)) return bad("invalid_request");
  return deleteConfig({ coachId, namespace: "views", key: viewKey(screen, viewId) });
}
// sugar over pins/menu: the whole ordered array is one atomic write
async function getPins({ coachId }) {
  const s = service(); if (!s) return notConfigured();
  const entries = await readNamespace(s, coachId, "pins");
  const menu = entries.menu;
  const items = ownObject(menu) && Array.isArray(menu.items) ? menu.items : [];
  return { status: 200, data: { items } };
}
async function setPins({ coachId, items }) {
  if (!Array.isArray(items)) return bad("invalid_request");
  return setConfig({ coachId, namespace: "pins", key: "menu", value: { items } });
}

module.exports = {
  buildUserConfigHandlers,
  // Lane B core
  getConfig, setConfig, deleteConfig, renameLabel, listSavedViews, saveView, deleteView, getPins, setPins,
  // exposed for reuse/tests
  DbError, NAMESPACES, NS_CAPS, validNamespace, validKey, normalizeValue,
};
