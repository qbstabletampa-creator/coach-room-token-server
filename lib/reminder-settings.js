// Reminder settings editor and rule-backed sweep provider.
// This module is deliberately inert: environment, time, auth, and fetch are
// consulted only when a returned handler/provider method is invoked.

class DbError extends Error {
  constructor(method, status, detail) {
    super(`supabase ${method} ${status}: ${detail || ""}`);
    this.name = "DbError";
    this.method = method;
    this.status = status;
    this.detail = String(detail || "");
  }
}

const TRIGGERS = new Set(["session_upcoming", "session_done_rebook", "no_booking", "low_credits", "homework_due"]);
const RECIPIENTS = new Set(["athlete", "coach", "both"]);
const UNITS = new Set(["minutes", "days"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const TOKENS = /\{([^{}]+)\}/g;
const RULE_FIELDS = ["trigger", "enabled", "offsets_minutes", "threshold_value", "threshold_unit", "recipient", "title", "body", "session_type_id"];
const PATCH_FIELDS = RULE_FIELDS.filter((x) => x !== "trigger");
const SETTINGS_FIELDS = ["quiet_start", "quiet_end", "timezone"];
const DTO_FIELDS = ["id", "trigger", "enabled", "offsets_minutes", "threshold_value", "threshold_unit", "recipient", "title", "body", "session_type_id", "preset_key", "is_preset", "created_at", "updated_at"];
const PRESET_ORDER = ["session_reminders", "rebook", "come_back", "low_credits", "homework_due"];
const PRESETS = Object.freeze([
  { preset_key: "session_reminders", trigger: "session_upcoming", enabled: true, offsets_minutes: [1440, 60], threshold_value: null, threshold_unit: null, recipient: "both", title: "Session reminder", body: "{athlete} · {service} starts {time}.", session_type_id: null, is_preset: true },
  { preset_key: "rebook", trigger: "session_done_rebook", enabled: false, offsets_minutes: [], threshold_value: 60, threshold_unit: "minutes", recipient: "athlete", title: "Keep the momentum", body: "Ready for the next session? Book with {coach}.", session_type_id: null, is_preset: true },
  { preset_key: "come_back", trigger: "no_booking", enabled: false, offsets_minutes: [], threshold_value: 21, threshold_unit: "days", recipient: "athlete", title: "Let’s get back to work", body: "It’s been a while, {athlete}. Book your next session with {coach}.", session_type_id: null, is_preset: true },
  { preset_key: "low_credits", trigger: "low_credits", enabled: false, offsets_minutes: [], threshold_value: null, threshold_unit: null, recipient: "athlete", title: "Credits running low", body: "You have {credits} coaching credits left. Grab the next package when you’re ready.", session_type_id: null, is_preset: true },
  { preset_key: "homework_due", trigger: "homework_due", enabled: false, offsets_minutes: [], threshold_value: 1, threshold_unit: "days", recipient: "athlete", title: "Homework due soon", body: "{homework} is due {due_date}.", session_type_id: null, is_preset: true },
]);

const tokenSets = {
  session_upcoming: new Set(["athlete", "coach", "time", "service"]),
  session_done_rebook: new Set(["athlete", "coach", "time", "service"]),
  no_booking: new Set(["athlete", "coach"]),
  low_credits: new Set(["athlete", "coach", "credits"]),
  homework_due: new Set(["athlete", "coach", "homework", "due_date"]),
};

function ownObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(obj, allowed, { required = [], nonempty = false } = {}) {
  if (!ownObject(obj)) return false;
  const keys = Object.keys(obj);
  return (!nonempty || keys.length > 0) && keys.every((k) => allowed.includes(k)) && required.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}
function codePoints(s) { return [...s].length; }
function cleanText(v, max) {
  if (typeof v !== "string") throw new TypeError("invalid text");
  const s = v.trim();
  if (!s || codePoints(s) > max) throw new TypeError("invalid text");
  return s;
}
function validTimezone(value) {
  if (typeof value !== "string") return false;
  const zone = value.trim();
  if (!zone || codePoints(zone) > 100 || /^[+-]\d\d(?::?\d\d)?$/.test(zone)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0); return true; } catch (_) { return false; }
}
function validateTemplates(trigger, title, body) {
  const allowed = tokenSets[trigger];
  for (const text of [title, body]) {
    TOKENS.lastIndex = 0;
    let m;
    while ((m = TOKENS.exec(text))) if (!allowed.has(m[1])) throw new TypeError("invalid template token");
    if (/[{}]/.test(text.replace(TOKENS, ""))) throw new TypeError("invalid template token");
  }
}
function validateOffsets(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 8 || v.some((x) => !Number.isInteger(x) || x < 15 || x > 10080)) throw new TypeError("invalid offsets");
  const out = [...new Set(v)].sort((a, b) => b - a);
  if (out.length !== v.length) throw new TypeError("invalid offsets");
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) if (Math.abs(out[i] - out[j]) < 30) throw new TypeError("overlapping offsets");
  return out;
}
function validateRule(input, { preset = false } = {}) {
  if (!ownObject(input) || !TRIGGERS.has(input.trigger)) throw new TypeError("invalid rule");
  const out = { ...input };
  if (typeof out.enabled !== "boolean") throw new TypeError("invalid enabled");
  if (!RECIPIENTS.has(out.recipient)) throw new TypeError("invalid recipient");
  out.title = cleanText(out.title, 120); out.body = cleanText(out.body, 500);
  validateTemplates(out.trigger, out.title, out.body);
  if (!(out.session_type_id === null || UUID_RE.test(out.session_type_id || ""))) throw new TypeError("invalid session type");
  if (preset && out.session_type_id !== null) throw new TypeError("preset must apply to all services");
  const emptyOffsets = () => { if (!Array.isArray(out.offsets_minutes) || out.offsets_minutes.length) throw new TypeError("invalid offsets"); out.offsets_minutes = []; };
  if (out.trigger === "session_upcoming") {
    out.offsets_minutes = validateOffsets(out.offsets_minutes);
    if (out.threshold_value !== null || out.threshold_unit !== null || (!preset && !out.session_type_id)) throw new TypeError("invalid upcoming rule");
  } else if (out.trigger === "session_done_rebook") {
    emptyOffsets();
    if (!Number.isInteger(out.threshold_value) || out.threshold_value < 0 || out.threshold_value > 10080 || out.threshold_unit !== "minutes" || (!preset && !out.session_type_id)) throw new TypeError("invalid rebook rule");
  } else if (out.trigger === "no_booking") {
    emptyOffsets();
    if (!Number.isInteger(out.threshold_value) || out.threshold_value < 1 || out.threshold_value > 365 || out.threshold_unit !== "days" || out.session_type_id !== null) throw new TypeError("invalid no-booking rule");
  } else if (out.trigger === "low_credits") {
    emptyOffsets();
    if (out.threshold_value !== null || out.threshold_unit !== null || out.session_type_id !== null || out.recipient !== "athlete") throw new TypeError("invalid low-credit rule");
  } else {
    emptyOffsets();
    if (!Number.isInteger(out.threshold_value) || out.threshold_value < 0 || out.threshold_value > 30 || out.threshold_unit !== "days" || out.session_type_id !== null || out.recipient !== "athlete") throw new TypeError("invalid homework rule");
  }
  return out;
}
function createRule(body) {
  if (!exactKeys(body, RULE_FIELDS, { required: ["trigger", "title", "body"] })) throw new TypeError("invalid body");
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const base = { trigger: body.trigger, enabled: has("enabled") ? body.enabled : true, offsets_minutes: has("offsets_minutes") ? body.offsets_minutes : [], threshold_value: has("threshold_value") ? body.threshold_value : null, threshold_unit: has("threshold_unit") ? body.threshold_unit : null, recipient: has("recipient") ? body.recipient : "athlete", title: body.title, body: body.body, session_type_id: has("session_type_id") ? body.session_type_id : null, preset_key: null, is_preset: false };
  return validateRule(base);
}
function mergeRule(row, patch) {
  if (!exactKeys(patch, PATCH_FIELDS, { nonempty: true })) throw new TypeError("invalid body");
  return validateRule({ ...row, ...patch }, { preset: row.is_preset === true });
}
function validatePatchShape(patch) {
  if (!exactKeys(patch, PATCH_FIELDS, { nonempty: true })) throw new TypeError("invalid body");
  if ("enabled" in patch && typeof patch.enabled !== "boolean") throw new TypeError("invalid enabled");
  if ("recipient" in patch && !RECIPIENTS.has(patch.recipient)) throw new TypeError("invalid recipient");
  if ("session_type_id" in patch && !(patch.session_type_id === null || UUID_RE.test(patch.session_type_id || ""))) throw new TypeError("invalid session type");
  if ("threshold_unit" in patch && !(patch.threshold_unit === null || UNITS.has(patch.threshold_unit))) throw new TypeError("invalid unit");
  if ("threshold_value" in patch && !(patch.threshold_value === null || (Number.isInteger(patch.threshold_value) && patch.threshold_value >= 0 && patch.threshold_value <= 10080))) throw new TypeError("invalid threshold");
  if ("offsets_minutes" in patch) { if (!Array.isArray(patch.offsets_minutes)) throw new TypeError("invalid offsets"); if (patch.offsets_minutes.length) validateOffsets(patch.offsets_minutes); }
  for (const [key, max] of [["title", 120], ["body", 500]]) if (key in patch) { const value = cleanText(patch[key], max); TOKENS.lastIndex = 0; let m; while ((m = TOKENS.exec(value))) if (![...tokenSets.session_upcoming, ...tokenSets.low_credits, ...tokenSets.homework_due].includes(m[1])) throw new TypeError("invalid template token"); if (/[{}]/.test(value.replace(TOKENS, ""))) throw new TypeError("invalid template token"); }
  return patch;
}
function ruleDto(row) {
  const out = {}; for (const k of DTO_FIELDS) out[k] = row[k] ?? (k === "offsets_minutes" ? [] : null);
  out.enabled = row.enabled === true; out.is_preset = row.is_preset === true;
  return out;
}
function storedRule(row) {
  if (!ownObject(row) || !UUID_RE.test(row.id || "") || !UUID_RE.test(row.coach_id || "") || typeof row.created_at !== "string" || typeof row.updated_at !== "string" || !Number.isFinite(Date.parse(row.created_at)) || !Number.isFinite(Date.parse(row.updated_at)) || typeof row.is_preset !== "boolean") throw new DbError("GET", 200, "invalid rule row");
  if (row.is_preset ? !PRESET_ORDER.includes(row.preset_key) || row.session_type_id !== null : row.preset_key !== null) throw new DbError("GET", 200, "invalid rule identity");
  const expected = PRESETS.find((p) => p.preset_key === row.preset_key); if (expected && expected.trigger !== row.trigger) throw new DbError("GET", 200, "invalid preset trigger");
  try { validateRule(row, { preset: row.is_preset }); } catch (_) { throw new DbError("GET", 200, "invalid rule row"); }
  return row;
}
function canonicalTime(v) { if (v === null) return null; if (typeof v !== "string" || !TIME_RE.test(v)) throw new TypeError("invalid time"); return v; }
function validateSettings(v) {
  const out = { quiet_start: canonicalTime(v.quiet_start), quiet_end: canonicalTime(v.quiet_end), timezone: typeof v.timezone === "string" ? v.timezone.trim() : v.timezone };
  if ((out.quiet_start === null) !== (out.quiet_end === null) || (out.quiet_start !== null && out.quiet_start === out.quiet_end) || !validTimezone(out.timezone)) throw new TypeError("invalid settings");
  return out;
}
function settingsDto(row) { const v = validateSettings({ ...row, quiet_start: row.quiet_start === null ? null : String(row.quiet_start).slice(0, 5), quiet_end: row.quiet_end === null ? null : String(row.quiet_end).slice(0, 5) }); if (typeof row.updated_at !== "string" || !Number.isFinite(Date.parse(row.updated_at))) throw new DbError("GET", 200, "invalid settings row"); return { ...v, updated_at: row.updated_at }; }
function quietAt(nowMs, timezone, start, end) {
  if (start === null || end === null) return false;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(nowMs);
  const value = `${parts.find((p) => p.type === "hour").value}:${parts.find((p) => p.type === "minute").value}`;
  return start < end ? value >= start && value < end : value >= start || value < end;
}
function expandTemplate(text, values) {
  return [...String(text).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").replace(TOKENS, (_, k) => String(values[k] ?? ""))].slice(0, text === values.__title ? 120 : 500).join("");
}

function service() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  return url && key ? { url: url.replace(/\/$/, ""), headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" } } : null;
}
async function strictJson(resp, method) {
  let raw; try { raw = await resp.text(); } catch (e) { throw new DbError(method, resp.status || 0, "response read failed"); }
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
function detailJson(err) { try { return JSON.parse(err.detail); } catch (_) { return {}; } }
function dbCode(err) { const d = detailJson(err); return String(d.code || ""); }
function dbMessage(err) { const d = detailJson(err); return `${d.message || ""} ${d.details || ""} ${d.hint || ""}`; }
function replyError(res, err) {
  if (err instanceof TypeError) return res.status(400).json({ error: "invalid_request" });
  return res.status(500).json({ error: "internal_error" });
}
function noShape(req, { params = false } = {}) {
  return exactKeys(req.query || {}, []) && exactKeys(req.body || {}, []) && (!params || exactKeys(req.params || {}, []));
}
async function coach(req, res, requireSupabaseUser) {
  if (typeof requireSupabaseUser !== "function") { res.status(503).json({ error: "not_configured" }); return null; }
  let authd; try { authd = await requireSupabaseUser(req); } catch (_) { res.status(401).json({ error: "unauthorized" }); return null; }
  if (!authd || !authd.user) { res.status(authd?.status || 401).json({ error: authd?.error || "unauthorized" }); return null; }
  if (authd.user.app_metadata?.role !== "coach") { res.status(403).json({ error: "forbidden" }); return null; }
  return authd.user.id;
}

function buildReminderSettingsHandlers({ requireSupabaseUser, now = () => new Date() } = {}) {
  async function begin(req, res) { const id = await coach(req, res, requireSupabaseUser); if (!id) return null; const s = service(); if (!s) { res.status(503).json({ error: "not_configured" }); return null; } return { id, s }; }
  const rulesPath = (id, extra = "") => `reminder_rules?coach_id=eq.${enc(id)}${extra}`;
  const readRules = async (s, id) => { const rows = await db(s, `${rulesPath(id)}&select=${DTO_FIELDS.join(",")},coach_id`); if (!Array.isArray(rows)) throw new DbError("GET", 200, "invalid representation"); return rows.map(storedRule); };
  const readRule = async (s, coachId, id) => { const rows = await db(s, `${rulesPath(coachId, `&id=eq.${enc(id)}`)}&select=${DTO_FIELDS.join(",")},coach_id&limit=1`); if (!Array.isArray(rows)) throw new DbError("GET", 200, "invalid representation"); return rows.length ? storedRule(rows[0]) : null; };
  const typeOwned = async (s, coachId, id) => { if (!id) return true; const rows = await db(s, `session_types?coach_id=eq.${enc(coachId)}&id=eq.${enc(id)}&select=id&limit=1`); if (!Array.isArray(rows)) throw new DbError("GET", 200, "invalid representation"); return rows.length === 1; };
  const one = (rows, method) => { if (!Array.isArray(rows) || rows.length !== 1 || !ownObject(rows[0])) throw new DbError(method, 200, "missing representation"); return rows[0]; };
  const mapMutationError = async (err, s, coachId, sessionTypeId) => {
    if (!(err instanceof DbError)) throw err;
    const code = dbCode(err), msg = dbMessage(err);
    if (code === "P0001" && /reminder_rule_limit/.test(msg)) return [409, "rule_limit"];
    if (code === "23505" && /(reminder_rules_(upcoming|rebook)_scope_unique)/.test(msg)) return [409, "window_conflict"];
    if (code === "23503" && sessionTypeId && !(await typeOwned(s, coachId, sessionTypeId))) return [404, "not_found"];
    return null;
  };
  async function repairSettings(s, coachId) {
    const path = `coach_reminder_settings?coach_id=eq.${enc(coachId)}&select=coach_id,quiet_start,quiet_end,timezone,updated_at`;
    let rows = await db(s, path); if (!Array.isArray(rows)) throw new DbError("GET", 200, "invalid representation");
    if (!rows.length) {
      try { await db(s, `coach_reminder_settings?on_conflict=coach_id`, { method: "POST", body: { coach_id: coachId, quiet_start: null, quiet_end: null, timezone: "America/New_York" }, prefer: "resolution=ignore-duplicates,return=representation" }); } catch (e) { if (!(e instanceof DbError && e.status === 409 && dbCode(e) === "23505")) throw e; }
      rows = await db(s, path);
    }
    return one(rows, "GET");
  }
  return {
    async getRules(req, res) {
      if (!noShape(req)) return replyError(res, new TypeError()); const ctx = await begin(req, res); if (!ctx) return;
      try {
        let rows = await readRules(ctx.s, ctx.id); if (!Array.isArray(rows)) throw new DbError("GET", 200, "invalid representation");
        const present = new Set(rows.filter((r) => r.is_preset).map((r) => r.preset_key)); const missing = PRESETS.filter((p) => !present.has(p.preset_key)); let seeded = [];
        if (missing.length) {
          try { const inserted = await db(ctx.s, `reminder_rules?on_conflict=coach_id,preset_key`, { method: "POST", body: missing.map((p) => ({ ...p, coach_id: ctx.id })), prefer: "resolution=ignore-duplicates,return=representation" }); if (!Array.isArray(inserted)) throw new DbError("POST", 200, "invalid representation"); seeded = inserted.map((x) => x.preset_key).filter((x) => PRESET_ORDER.includes(x)); }
          catch (e) { if (!(e instanceof DbError && e.status === 409 && dbCode(e) === "23505")) throw e; }
          rows = await readRules(ctx.s, ctx.id);
        }
        const rank = (r) => r.is_preset ? PRESET_ORDER.indexOf(r.preset_key) : 99;
        rows.sort((a, b) => rank(a) - rank(b) || (rank(a) === 99 ? (Date.parse(b.updated_at) - Date.parse(a.updated_at)) || String(a.id).localeCompare(String(b.id)) : 0));
        const seededSet = new Set(seeded); res.json({ rules: rows.map(ruleDto), seeded_preset_keys: PRESET_ORDER.filter((x) => seededSet.has(x)) });
      } catch (e) { replyError(res, e); }
    },
    async postRule(req, res) {
      let rule; if (!exactKeys(req.query || {}, []) || !exactKeys(req.params || {}, [])) return replyError(res, new TypeError()); try { rule = createRule(req.body); } catch (e) { return replyError(res, e); }
      const ctx = await begin(req, res); if (!ctx) return;
      try {
        if (!(await typeOwned(ctx.s, ctx.id, rule.session_type_id))) return res.status(404).json({ error: "not_found" });
        const count = await db(ctx.s, `reminder_rules?coach_id=eq.${enc(ctx.id)}&is_preset=eq.false&select=id`); if (!Array.isArray(count)) throw new DbError("GET", 200, "invalid representation"); if (count.length >= 25) return res.status(409).json({ error: "rule_limit" });
        const rows = await db(ctx.s, "reminder_rules", { method: "POST", body: { ...rule, coach_id: ctx.id }, prefer: "return=representation" }); res.status(201).json({ rule: ruleDto(storedRule(one(rows, "POST"))) });
      } catch (e) { const m = await mapMutationError(e, ctx.s, ctx.id, rule.session_type_id).catch(() => null); if (m) return res.status(m[0]).json({ error: m[1] }); replyError(res, e); }
    },
    async patchRule(req, res) {
      if (!exactKeys(req.query || {}, []) || !exactKeys(req.params || {}, ["id"], { required: ["id"] }) || !UUID_RE.test(req.params.id || "")) return replyError(res, new TypeError()); try { validatePatchShape(req.body); } catch (e) { return replyError(res, e); }
      const ctx = await begin(req, res); if (!ctx) return; let merged;
      try {
        const old = await readRule(ctx.s, ctx.id, req.params.id); if (!old) return res.status(404).json({ error: "not_found" }); merged = mergeRule(old, req.body);
        if (!(await typeOwned(ctx.s, ctx.id, merged.session_type_id))) return res.status(404).json({ error: "not_found" });
        const updated_at = now().toISOString(); const change = {}; for (const k of PATCH_FIELDS) if (Object.prototype.hasOwnProperty.call(req.body, k)) change[k] = merged[k]; change.updated_at = updated_at;
        const rows = await db(ctx.s, `${rulesPath(ctx.id, `&id=eq.${enc(req.params.id)}`)}`, { method: "PATCH", body: change, prefer: "return=representation" }); if (!Array.isArray(rows)) throw new DbError("PATCH", 200, "invalid representation"); if (!rows.length) return res.status(404).json({ error: "not_found" }); res.json({ rule: ruleDto(storedRule(one(rows, "PATCH"))) });
      } catch (e) { const m = await mapMutationError(e, ctx.s, ctx.id, merged?.session_type_id).catch(() => null); if (m) return res.status(m[0]).json({ error: m[1] }); replyError(res, e); }
    },
    async deleteRule(req, res) {
      if (!exactKeys(req.query || {}, []) || !exactKeys(req.body || {}, []) || !exactKeys(req.params || {}, ["id"], { required: ["id"] }) || !UUID_RE.test(req.params.id || "")) return replyError(res, new TypeError());
      const ctx = await begin(req, res); if (!ctx) return;
      try { const old = await readRule(ctx.s, ctx.id, req.params.id); if (!old) return res.status(404).json({ error: "not_found" }); if (old.is_preset) return res.status(409).json({ error: "preset_locked" }); const rows = await db(ctx.s, rulesPath(ctx.id, `&id=eq.${enc(req.params.id)}`), { method: "DELETE", prefer: "return=representation" }); if (!Array.isArray(rows) || !rows.length) return res.status(404).json({ error: "not_found" }); one(rows, "DELETE"); res.json({ deleted: true }); } catch (e) { replyError(res, e); }
    },
    async getSettings(req, res) {
      if (!noShape(req)) return replyError(res, new TypeError()); const ctx = await begin(req, res); if (!ctx) return;
      try { res.json({ settings: settingsDto(await repairSettings(ctx.s, ctx.id)) }); } catch (e) { replyError(res, e); }
    },
    async patchSettings(req, res) {
      if (!exactKeys(req.query || {}, []) || !exactKeys(req.params || {}, []) || !exactKeys(req.body, SETTINGS_FIELDS, { nonempty: true })) return replyError(res, new TypeError());
      try { if ("quiet_start" in req.body) canonicalTime(req.body.quiet_start); if ("quiet_end" in req.body) canonicalTime(req.body.quiet_end); if ("timezone" in req.body && !validTimezone(req.body.timezone)) throw new TypeError("invalid timezone"); if ("quiet_start" in req.body && "quiet_end" in req.body && ((req.body.quiet_start === null) !== (req.body.quiet_end === null) || (req.body.quiet_start !== null && req.body.quiet_start === req.body.quiet_end))) throw new TypeError("invalid quiet pair"); } catch (e) { return replyError(res, e); }
      const ctx = await begin(req, res); if (!ctx) return;
      try { const old = await repairSettings(ctx.s, ctx.id); const merged = validateSettings({ quiet_start: old.quiet_start ? String(old.quiet_start).slice(0, 5) : null, quiet_end: old.quiet_end ? String(old.quiet_end).slice(0, 5) : null, timezone: old.timezone, ...req.body }); const updated_at = now().toISOString(); const rows = await db(ctx.s, `coach_reminder_settings?coach_id=eq.${enc(ctx.id)}`, { method: "PATCH", body: { ...merged, updated_at }, prefer: "return=representation" }); if (!Array.isArray(rows) || !rows.length) return res.status(404).json({ error: "not_found" }); res.json({ settings: settingsDto(one(rows, "PATCH")) }); } catch (e) { replyError(res, e); }
    },
  };
}

// Provider implementation follows the same strict storage boundary. Candidate
// evaluators live on the immutable returned plan and never mutate business rows.
function buildReminderRulesProvider({ now = () => new Date(), fetchImpl = (...args) => fetch(...args) } = {}) {
  return { async load({ nowMs, widthMs }) {
    if (!Number.isFinite(nowMs) || !Number.isFinite(widthMs) || widthMs <= 0) throw new TypeError("invalid load window");
    const s = service(); if (!s) throw new DbError("GET", 0, "not configured");
    const select = DTO_FIELDS.concat("coach_id").join(",");
    const stored = await db(s, `reminder_rules?select=${select}`, { fetchImpl }); if (!Array.isArray(stored)) throw new DbError("GET", 200, "invalid representation");
    const settingsRows = await db(s, "coach_reminder_settings?select=coach_id,quiet_start,quiet_end,timezone,updated_at", { fetchImpl }); if (!Array.isArray(settingsRows)) throw new DbError("GET", 200, "invalid representation");
    const rules = stored.map((r) => ({ ...r, ...validateRule(storedRule(r), { preset: r.is_preset === true }) }));
    const coachIds = new Set(rules.map((r) => r.coach_id)); const settings = new Map();
    for (const row of settingsRows) { if (!UUID_RE.test(row.coach_id || "")) throw new DbError("GET", 200, "invalid settings owner"); const v = settingsDto({ ...row, quiet_start: row.quiet_start ? String(row.quiet_start).slice(0, 5) : null, quiet_end: row.quiet_end ? String(row.quiet_end).slice(0, 5) : null }); settings.set(row.coach_id, v); coachIds.add(row.coach_id); }
    for (const id of coachIds) if (!settings.has(id)) settings.set(id, { quiet_start: null, quiet_end: null, timezone: "America/New_York", updated_at: null });
    const byCoach = new Map(); for (const r of rules) { if (!byCoach.has(r.coach_id)) byCoach.set(r.coach_id, []); byCoach.get(r.coach_id).push(r); }
    const defaultSession = PRESETS[0];
    const effective = (coachId) => byCoach.get(coachId) || [];
    const windowOf = (rule, minutes) => ({ key: minutes === 1440 ? "24h" : minutes === 60 ? "1h" : `${minutes}m`, type: minutes === 1440 ? "session.reminder.24h" : `session.reminder.${minutes === 60 ? "1h" : `${minutes}m`}`, offsetMs: minutes * 60000, title: rule.title, body: rule.body, ruleId: rule.id || "preset:default", recipient: rule.recipient });
    const scanOffsets = new Set([1440, 60]); for (const r of rules) if (r.enabled && r.trigger === "session_upcoming") for (const n of r.offsets_minutes) scanOffsets.add(n);
    const scanWindows = [...scanOffsets].sort((a,b)=>b-a).map((n) => windowOf(defaultSession, n));
    const plan = {
      scanWindows,
      sessionWindowsFor(coachId, sessionTypeId) {
        const rr = effective(coachId).filter((r) => r.trigger === "session_upcoming"); const specific = rr.find((r) => r.session_type_id && r.session_type_id === sessionTypeId); const global = rr.find((r) => r.is_preset && r.session_type_id === null); const chosen = specific || global || { ...defaultSession, id: `preset:${coachId}` }; return chosen.enabled ? chosen.offsets_minutes.map((n) => windowOf(chosen, n)) : [];
      },
      async runLifecycle({ notify }) { return runPasses(false, notify); },
      async runHomeworkDue({ notify }) { return runPasses(true, notify); },
    };
    async function query(path) { return db(s, path, { fetchImpl }); }
    async function logHit(userId, type, referenceId) {
      try { const rows = await query(`notification_log?user_id=eq.${enc(userId)}&type=eq.${enc(type)}&reference_id=eq.${enc(referenceId)}&channel=eq.inapp&select=id&limit=1`); return Array.isArray(rows) && rows.length > 0; } catch (_) { return false; }
    }
    async function deliver({ userId, email, type, title, body, data, referenceId }, notify) {
      if (!userId || await logHit(userId, type, referenceId)) return 0;
      try { if (typeof notify !== "function") throw new Error("notify missing"); await notify({ userId, email: email || undefined, type, title, body, data, dedupeKey: referenceId }); } catch (_) { return 0; }
      try { await db(s, "notification_log", { method: "POST", body: { user_id: userId, type, reference_id: referenceId, channel: "inapp" }, prefer: "return=minimal", fetchImpl }); } catch (_) {}
      return 1;
    }
    async function runPasses(homeworkOnly, notify) {
      let scanned = 0, sent = 0;
      const selected = rules.filter((r) => r.enabled && (homeworkOnly ? r.trigger === "homework_due" : ["session_done_rebook", "no_booking", "low_credits"].includes(r.trigger)));
      for (const rule of selected) {
        const setting = settings.get(rule.coach_id) || { quiet_start:null, quiet_end:null, timezone:"America/New_York" };
        const quiet = quietAt(nowMs, setting.timezone, setting.quiet_start, setting.quiet_end);
        if (rule.trigger === "session_done_rebook") {
          const cutoff = new Date(nowMs - rule.threshold_value * 60000).toISOString(), floor = new Date(nowMs - 7*86400000).toISOString();
          const rows = await query(`bookable_slots?coach_id=eq.${enc(rule.coach_id)}&status=in.(booked,completed)&booked_by=not.is.null&ends_at=lte.${enc(cutoff)}&ends_at=gte.${enc(floor)}&select=id,coach_id,booked_by,ends_at,title,session_type_id,athlete:booked_by(user_id,name,parent_email)`);
          if (!Array.isArray(rows)) throw new DbError("GET",200,"invalid representation");
          for (const row of rows) { if (rule.session_type_id && row.session_type_id !== rule.session_type_id) continue; if (!rule.session_type_id && rules.some((candidate) => !candidate.is_preset && candidate.trigger === "session_done_rebook" && candidate.coach_id === rule.coach_id && candidate.session_type_id === row.session_type_id)) continue; scanned++; if (quiet) continue; const future = await query(`bookable_slots?coach_id=eq.${enc(rule.coach_id)}&booked_by=eq.${enc(row.booked_by)}&status=eq.booked&starts_at=gt.${enc(new Date(nowMs).toISOString())}&select=id&limit=1`); if (!Array.isArray(future)) throw new DbError("GET",200,"invalid representation"); if (future.length) continue; const a=row.athlete||{}; const ref=`${rule.id}:${row.booked_by}:${row.id}`; sent += await sendRecipients(rule,a,{ type:"reminder.rebook", ref, data:{ruleId:rule.id,athleteId:row.booked_by,slotId:row.id,href:"/athlete"}, service:row.title },notify); }
        } else if (rule.trigger === "no_booking") {
          const athletes = await query(`athletes?coach_id=eq.${enc(rule.coach_id)}&select=id,user_id,name,parent_email,created_at`); if (!Array.isArray(athletes)) throw new DbError("GET",200,"invalid representation");
          for (const a of athletes) { scanned++; if(quiet) continue; const slots=await query(`bookable_slots?coach_id=eq.${enc(rule.coach_id)}&booked_by=eq.${enc(a.id)}&status=in.(booked,completed)&select=id,starts_at,status&order=starts_at.desc`); if(!Array.isArray(slots)) throw new DbError("GET",200,"invalid representation"); if(slots.some(x=>x.status==="booked"&&Date.parse(x.starts_at)>nowMs)) continue; const past=slots.find(x=>Date.parse(x.starts_at)<=nowMs); const baseline=Date.parse(past?.starts_at||a.created_at); if(!Number.isFinite(baseline)||baseline>nowMs-rule.threshold_value*86400000) continue; const week=isoWeek(nowMs,setting.timezone); const ref=`${rule.id}:${a.id}:${week}`; sent += await sendRecipients(rule,a,{type:"reminder.no_booking",ref,data:{ruleId:rule.id,athleteId:a.id,href:"/athlete"}},notify); }
        } else if (rule.trigger === "low_credits") {
          const coachRows=await query(`coaches?id=eq.${enc(rule.coach_id)}&select=id,full_name,low_balance_threshold&limit=1`); if(!Array.isArray(coachRows)) throw new DbError("GET",200,"invalid representation"); if(!coachRows.length) continue;
          const athletes=await query(`athletes?coach_id=eq.${enc(rule.coach_id)}&select=id,user_id,name,parent_email`); if(!Array.isArray(athletes)) throw new DbError("GET",200,"invalid representation");
          for(const a of athletes){ const purchases=await query(`package_purchases?coach_id=eq.${enc(rule.coach_id)}&athlete_id=eq.${enc(a.id)}&select=id,status,credits_remaining,created_at&order=created_at.asc`); if(!Array.isArray(purchases)) throw new DbError("GET",200,"invalid representation"); if(!purchases.length) continue; scanned++; if(quiet) continue; const balance=purchases.filter(x=>x.status==="active").reduce((n,x)=>n+Number(x.credits_remaining||0),0); if(balance>Number(coachRows[0].low_balance_threshold)) continue; const ledger=await query(`credit_deductions?coach_id=eq.${enc(rule.coach_id)}&purchase_id=in.(${purchases.map((p)=>p.id).join(",")})&purchase.athlete_id=eq.${enc(a.id)}&action=in.(refund,admin_adjust)&select=id,created_at,purchase:purchase_id!inner(athlete_id)&order=created_at.desc`); if(!Array.isArray(ledger)) throw new DbError("GET",200,"invalid representation"); const increases=purchases.map((p)=>({id:p.id,created_at:p.created_at})).concat(ledger); increases.sort((x,y)=>Date.parse(y.created_at)-Date.parse(x.created_at)); const anchor=increases[0].id; const ref=`${rule.id}:${a.id}:low-episode:${anchor}`; sent += await sendRecipients({...rule,recipient:"athlete"},a,{type:"reminder.low_credits",ref,data:{ruleId:rule.id,athleteId:a.id,balance,href:"/athlete"},credits:balance},notify); }
        } else {
          const due=await query(`homework?coach_id=eq.${enc(rule.coach_id)}&status=eq.assigned&due_date=not.is.null&athlete.coach_id=eq.${enc(rule.coach_id)}&select=id,coach_id,athlete_id,title,due_date,athlete:athlete_id!inner(user_id,name,parent_email,coach_id)`); if(!Array.isArray(due)) throw new DbError("GET",200,"invalid representation"); const local=localDate(nowMs,setting.timezone);
          for(const h of due){ const a=h.athlete||{}; if(a.coach_id!==rule.coach_id) continue; scanned++; if(quiet) continue; if(local<h.due_date||local>h.due_date) { const first=addDays(h.due_date,-rule.threshold_value); if(local<first||local>h.due_date) continue; } const ref=`${rule.id}:${h.athlete_id}:${h.id}:${h.due_date}`; sent += await sendRecipients(rule,a,{type:"reminder.homework_due",ref,data:{ruleId:rule.id,athleteId:h.athlete_id,homeworkId:h.id,href:"/athlete/homework"},homework:h.title,due_date:h.due_date},notify); }
        }
      }
      return { scanned, sent };
    }
    async function sendRecipients(rule,a,event,notify){ const people=[]; if(rule.recipient==="coach"||rule.recipient==="both") people.push({userId:rule.coach_id,role:"coach"}); if((rule.recipient==="athlete"||rule.recipient==="both")&&a.user_id) people.push({userId:a.user_id,email:a.parent_email,role:"athlete"}); let n=0; for(const p of people){ const values={athlete:String(a.name|| (p.role==="coach"?"Your athlete":"You")).trim(),coach:"your coach",time:"your session",service:String(event.service||"coaching session").trim(),credits:event.credits,homework:String(event.homework||"homework").trim(),due_date:event.due_date}; n+=await deliver({...event,userId:p.userId,email:p.email,title:render(rule.title,values,120),body:render(rule.body,values,500),referenceId:event.ref},notify); } return n; }
    Object.freeze(plan.scanWindows); return Object.freeze(plan);
  } };
}

function render(text, values, max) { return [...String(text).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").replace(TOKENS,(_,k)=>String(values[k]??""))].slice(0,max).join(""); }
function localDate(ms, zone){ const p=new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(ms); return `${p.find(x=>x.type==="year").value}-${p.find(x=>x.type==="month").value}-${p.find(x=>x.type==="day").value}`; }
function addDays(ymd,n){ const d=new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function isoWeek(ms,zone){ const d=new Date(`${localDate(ms,zone)}T00:00:00Z`); const day=d.getUTCDay()||7; d.setUTCDate(d.getUTCDate()+4-day); const y=d.getUTCFullYear(); const first=new Date(Date.UTC(y,0,1)); const w=Math.ceil((((d-first)/86400000)+1)/7); return `${y}-W${String(w).padStart(2,"0")}`; }

module.exports = { buildReminderSettingsHandlers, buildReminderRulesProvider, DbError, PRESETS, PRESET_ORDER, validateRule, createRule, mergeRule, ruleDto, validateSettings, validTimezone, validateTemplates, quietAt, render, localDate, isoWeek };
