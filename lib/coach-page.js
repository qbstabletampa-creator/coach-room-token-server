// Coach-page editor factory and public projection. Route registration and feature
// gating live in index.js; importing/building this module performs no I/O.

const crypto = require("node:crypto");

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const REPLY_TIMES = new Set(["within_day", "within_2_days", "within_week"]);
const SOCIAL_PLATFORMS = new Set(["instagram", "youtube", "tiktok", "facebook", "x", "web"]);
const SECTION_KEYS = ["about", "how_i_work", "locations", "gallery", "services", "steps", "socials"];
const SECTION_SET = new Set(SECTION_KEYS);
const IMAGE_TYPES = {
  "image/jpeg": { extension: "jpg", matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/png": { extension: "png", matches: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  "image/webp": { extension: "webp", matches: (b) => b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP" },
};
const PROFILE_SELECT = "headline,years_experience,languages,reply_time,how_i_work";
const LOCATION_SELECT = "id,coach_id,name,address,note,active,sort";
const PHOTO_SELECT = "id,coach_id,object_path,caption,active,sort,consent_attested_at,identifiable_minor,guardian_consent_recorded_at";
const PHOTO_INTERNAL_SELECT = `${PHOTO_SELECT},upload_key,sha256`;
const SOCIAL_SELECT = "id,coach_id,platform,url,sort";
const SECTION_SELECT = "id,coach_id,section_key,visible,sort";

class DbError extends Error {
  constructor(method, status, detail) {
    super(`supabase ${method} ${status}: ${detail}`);
    this.name = "DbError";
    this.status = status;
    this.detail = detail;
  }
}
class StorageError extends Error {
  constructor(operation, status, detail) {
    super(`storage ${operation} ${status}: ${detail}`);
    this.name = "StorageError";
    this.status = status;
    this.detail = detail;
  }
}

function exactKeys(value, allowed) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key));
}
function validUuid(value) { return typeof value === "string" && UUID_RE.test(value); }
function codePoints(value) { return [...value].length; }
function emptyObject(value) { return value == null || (exactKeys(value, []) && Object.keys(value).length === 0); }
function defaultsSections() { return SECTION_KEYS.map((key, sort) => ({ key, visible: true, sort })); }
function mergeSections(rows) {
  const byKey = new Map();
  if (Array.isArray(rows)) {
    const candidates = rows.filter((row) => row && SECTION_SET.has(row.section_key) &&
          typeof row.visible === "boolean" && Number.isInteger(row.sort) && row.sort >= 0 && row.sort <= 6)
      .map((row) => ({ ...row, stableKey: validUuid(row.id) ? row.id.toLowerCase() : row.section_key }))
      .sort((a, b) => a.stableKey.localeCompare(b.stableKey));
    for (const row of candidates) {
      if (byKey.has(row.section_key) ||
          typeof row.visible !== "boolean" || !Number.isInteger(row.sort) || row.sort < 0 || row.sort > 6) continue;
      byKey.set(row.section_key, { key: row.section_key, visible: row.visible, requestedSort: row.sort, stableKey: row.stableKey });
    }
  }
  // Direct-RLS writes can contain duplicate sorts or omit keys. Preserve valid
  // row intent with a stable tiebreak, fill defaults, then renumber so callers
  // always receive exactly one complete 0..6 permutation.
  return defaultsSections()
    .map((item) => byKey.get(item.key) || { key: item.key, visible: item.visible, requestedSort: item.sort, stableKey: item.key })
    .sort((a, b) => a.requestedSort - b.requestedSort || a.stableKey.localeCompare(b.stableKey) || SECTION_KEYS.indexOf(a.key) - SECTION_KEYS.indexOf(b.key))
    .map(({ key, visible }, sort) => ({ key, visible, sort }));
}

function guardianConsentRecorded(row) {
  return !!(row && typeof row.guardian_consent_recorded_at === "string" &&
    Number.isFinite(Date.parse(row.guardian_consent_recorded_at)));
}
function publishablePhoto(row) {
  return !!(row && typeof row.consent_attested_at === "string" &&
    Number.isFinite(Date.parse(row.consent_attested_at)) && typeof row.identifiable_minor === "boolean" &&
    (!row.identifiable_minor || guardianConsentRecorded(row)));
}
function nullableText(value, max, required = false) {
  if (value === null && !required) return null;
  if (typeof value !== "string") throw new TypeError("invalid text");
  const out = value.trim();
  if (!out) {
    if (required) throw new TypeError("required text");
    return null;
  }
  if (codePoints(out) > max) throw new TypeError("text too long");
  return out;
}
function normalizeProfile(value, partial = true) {
  const keys = ["headline", "years_experience", "languages", "reply_time", "how_i_work"];
  if (!exactKeys(value, keys) || (partial && Object.keys(value).length === 0)) throw new TypeError("invalid profile");
  const out = {};
  if (Object.hasOwn(value, "headline")) out.headline = nullableText(value.headline, 120);
  if (Object.hasOwn(value, "years_experience")) {
    if (value.years_experience !== null && (!Number.isInteger(value.years_experience) || value.years_experience < 1 || value.years_experience > 80)) throw new TypeError("invalid experience");
    out.years_experience = value.years_experience;
  }
  if (Object.hasOwn(value, "languages")) {
    if (!Array.isArray(value.languages) || value.languages.length > 6) throw new TypeError("invalid languages");
    const seen = new Set();
    out.languages = value.languages.map((language) => {
      const normalized = nullableText(language, 40, true);
      const folded = normalized.toLocaleLowerCase();
      if (seen.has(folded)) throw new TypeError("duplicate language");
      seen.add(folded); return normalized;
    });
  }
  if (Object.hasOwn(value, "reply_time")) {
    if (value.reply_time !== null && !REPLY_TIMES.has(value.reply_time)) throw new TypeError("invalid reply time");
    out.reply_time = value.reply_time;
  }
  if (Object.hasOwn(value, "how_i_work")) out.how_i_work = nullableText(value.how_i_work, 2000);
  return out;
}
function normalizeLocation(value, partial = false) {
  const keys = ["name", "address", "note", "active", "sort"];
  if (!exactKeys(value, keys) || (partial && Object.keys(value).length === 0) || (!partial && !Object.hasOwn(value, "name"))) throw new TypeError("invalid location");
  const out = {};
  if (Object.hasOwn(value, "name")) out.name = nullableText(value.name, 100, true);
  for (const key of ["address", "note"]) if (Object.hasOwn(value, key)) out[key] = nullableText(value[key], 300);
  if (Object.hasOwn(value, "active")) { if (typeof value.active !== "boolean") throw new TypeError("invalid active"); out.active = value.active; }
  if (Object.hasOwn(value, "sort")) { if (!Number.isInteger(value.sort) || value.sort < 0 || value.sort > 999) throw new TypeError("invalid sort"); out.sort = value.sort; }
  if (!partial) { if (!Object.hasOwn(out, "address")) out.address = null; if (!Object.hasOwn(out, "note")) out.note = null; if (!Object.hasOwn(out, "active")) out.active = true; if (!Object.hasOwn(out, "sort")) out.sort = 0; }
  return out;
}
function canonicalSocialUrl(platform, raw) {
  if (!SOCIAL_PLATFORMS.has(platform) || typeof raw !== "string" || !raw || raw.length > 500) throw new TypeError("invalid social");
  let url; try { url = new URL(raw); } catch (_) { throw new TypeError("invalid URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.href.length > 500) throw new TypeError("invalid URL");
  const hosts = { instagram: ["instagram.com"], youtube: ["youtube.com", "youtu.be"], tiktok: ["tiktok.com"], facebook: ["facebook.com"], x: ["x.com", "twitter.com"] };
  const allowed = hosts[platform];
  if (allowed && !allowed.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new TypeError("invalid host");
  return url.href;
}
function normalizeSocial(value, partial = false) {
  const keys = ["platform", "url", "sort"];
  if (!exactKeys(value, keys) || (partial && Object.keys(value).length === 0) || (!partial && (!Object.hasOwn(value, "platform") || !Object.hasOwn(value, "url")))) throw new TypeError("invalid social");
  const out = {};
  if (Object.hasOwn(value, "platform")) { if (!SOCIAL_PLATFORMS.has(value.platform)) throw new TypeError("invalid platform"); out.platform = value.platform; }
  if (Object.hasOwn(value, "url") && typeof value.url !== "string") throw new TypeError("invalid URL");
  if (Object.hasOwn(value, "sort")) { if (!Number.isInteger(value.sort) || value.sort < 0 || value.sort > 999) throw new TypeError("invalid sort"); out.sort = value.sort; }
  if (!partial) { out.url = canonicalSocialUrl(out.platform, value.url); if (!Object.hasOwn(out, "sort")) out.sort = 0; }
  else if (Object.hasOwn(value, "platform") && Object.hasOwn(value, "url")) out.url = canonicalSocialUrl(out.platform, value.url);
  else if (Object.hasOwn(value, "url")) out.url = canonicalSocialUrl("web", value.url);
  return out;
}
function normalizePhoto(value) {
  const keys = ["caption", "active", "sort"];
  if (!exactKeys(value, keys) || Object.keys(value).length === 0) throw new TypeError("invalid photo");
  const out = {};
  if (Object.hasOwn(value, "caption")) out.caption = nullableText(value.caption, 200);
  if (Object.hasOwn(value, "active")) { if (typeof value.active !== "boolean") throw new TypeError("invalid active"); out.active = value.active; }
  if (Object.hasOwn(value, "sort")) { if (!Number.isInteger(value.sort) || value.sort < 0 || value.sort > 999) throw new TypeError("invalid sort"); out.sort = value.sort; }
  return out;
}
function normalizeSections(value) {
  if (!exactKeys(value, ["sections"]) || !Array.isArray(value.sections) || value.sections.length !== 7) throw new TypeError("invalid sections");
  const keys = new Set(), sorts = new Set();
  const out = value.sections.map((item) => {
    if (!exactKeys(item, ["key", "visible", "sort"]) || !SECTION_SET.has(item.key) || typeof item.visible !== "boolean" || !Number.isInteger(item.sort) || item.sort < 0 || item.sort > 6 || keys.has(item.key) || sorts.has(item.sort)) throw new TypeError("invalid section");
    keys.add(item.key); sorts.add(item.sort); return { key: item.key, visible: item.visible, sort: item.sort };
  });
  if (keys.size !== 7 || sorts.size !== 7) throw new TypeError("invalid sections");
  return out.sort((a, b) => a.sort - b.sort);
}
function detectImage(body, contentType) {
  if (!Buffer.isBuffer(body) || body.length === 0) throw new TypeError("invalid image");
  const declared = typeof contentType === "string" ? contentType.split(";", 1)[0].trim().toLowerCase() : "";
  const type = IMAGE_TYPES[declared];
  if (!type) return { unsupported: true };
  if (!type.matches(body)) throw new TypeError("image magic mismatch");
  return { contentType: declared, extension: type.extension };
}
function galleryTtl(value = process.env.COACH_GALLERY_SIGN_TTL_S) {
  if (value == null || value === "") return 900;
  const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 60 && parsed <= 3600 ? parsed : 900;
}
function parseObjectPath(coachId, path) {
  if (!validUuid(coachId) || typeof path !== "string") return null;
  const match = /^([0-9a-fA-F-]{36})\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})\.(jpg|png|webp)$/.exec(path);
  if (!match || match[1].toLowerCase() !== coachId.toLowerCase()) return null;
  return { path: `${coachId}/${match[2].toLowerCase()}.${match[3]}`, extension: match[3] };
}
function profileDto(row) {
  if (!row || (row.headline !== null && row.headline !== undefined && (typeof row.headline !== "string" || !row.headline || codePoints(row.headline) > 120)) ||
      (row.years_experience !== null && row.years_experience !== undefined && (!Number.isInteger(row.years_experience) || row.years_experience < 1 || row.years_experience > 80)) ||
      !Array.isArray(row.languages) || row.languages.length > 6 || row.languages.some((v) => typeof v !== "string" || !v || codePoints(v) > 40) ||
      (row.reply_time !== null && row.reply_time !== undefined && !REPLY_TIMES.has(row.reply_time)) ||
      (row.how_i_work !== null && row.how_i_work !== undefined && (typeof row.how_i_work !== "string" || !row.how_i_work || codePoints(row.how_i_work) > 2000))) throw new TypeError("invalid profile row");
  return { headline: row.headline ?? null, years_experience: row.years_experience ?? null, languages: row.languages.slice(), reply_time: row.reply_time ?? null, how_i_work: row.how_i_work ?? null };
}
function locationDto(row) {
  if (!row || !validUuid(row.id) || typeof row.name !== "string" || !row.name || codePoints(row.name) > 100 ||
      (row.address !== null && row.address !== undefined && (typeof row.address !== "string" || !row.address || codePoints(row.address) > 300)) ||
      (row.note !== null && row.note !== undefined && (typeof row.note !== "string" || !row.note || codePoints(row.note) > 300)) ||
      typeof row.active !== "boolean" || !Number.isInteger(row.sort) || row.sort < 0 || row.sort > 999) throw new TypeError("invalid location row");
  return { id: row.id, name: row.name, address: row.address ?? null, note: row.note ?? null, active: row.active, sort: row.sort };
}
function socialDto(row) {
  if (!row || !validUuid(row.id) || !SOCIAL_PLATFORMS.has(row.platform) || canonicalSocialUrl(row.platform, row.url) !== row.url || !Number.isInteger(row.sort) || row.sort < 0 || row.sort > 999) throw new TypeError("invalid social row");
  return { id: row.id, platform: row.platform, url: row.url, sort: row.sort };
}
function photoDto(row, url) {
  if (!row || !validUuid(row.id) || typeof url !== "string" || !url.startsWith("https://") ||
      (row.caption !== null && row.caption !== undefined && (typeof row.caption !== "string" || !row.caption || codePoints(row.caption) > 200)) ||
      typeof row.active !== "boolean" || !Number.isInteger(row.sort) || row.sort < 0 || row.sort > 999 ||
      typeof row.consent_attested_at !== "string" || !Number.isFinite(Date.parse(row.consent_attested_at))) throw new TypeError("invalid photo row");
  return { id: row.id, url, caption: row.caption ?? null, active: row.active, sort: row.sort, consent_attested_at: row.consent_attested_at };
}

function config() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ""), key, bucket: process.env.COACH_GALLERY_BUCKET || "coach-gallery-private", ttl: galleryTtl(), headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" } };
}
async function requestJson(s, method, path, body, headers = {}) {
  let response;
  try { response = await fetch(`${s.url}/rest/v1/${path}`, { method, headers: { ...s.headers, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch (err) { throw new DbError(method, 0, err && err.message || "network failure"); }
  if (!response.ok) throw new DbError(method, response.status, await response.text().catch(() => ""));
  let value; try { value = await response.json(); } catch (err) { throw new DbError(method, response.status, "invalid JSON response"); }
  if (!Array.isArray(value)) throw new DbError(method, response.status, "invalid representation");
  return value;
}
const sbGet = (s, path) => requestJson(s, "GET", path);
const sbPost = (s, path, body, prefer = "return=representation") => requestJson(s, "POST", path, body, { prefer });
const sbPatch = (s, path, body) => requestJson(s, "PATCH", path, body, { prefer: "return=representation" });
const sbDelete = (s, path) => requestJson(s, "DELETE", path, undefined, { prefer: "return=representation" });
function one(rows) { if (!Array.isArray(rows)) throw new DbError("SHAPE", 500, "expected array"); return rows.length ? rows[0] : null; }
function dbPayload(err) { if (!(err instanceof DbError)) return null; try { const value = JSON.parse(err.detail); return value && typeof value === "object" ? value : null; } catch (_) { return null; } }
function namedViolation(err, code, name) { const p = dbPayload(err); return !!(p && p.code === code && new RegExp(`(?:constraint[^a-z0-9_]+)?${name}`, "i").test(`${p.details || ""} ${p.message || ""} ${p.hint || ""}`)); }
function storagePath(s, objectPath, suffix = "object") { return `${s.url}/storage/v1/${suffix}/${encodeURIComponent(s.bucket)}/${objectPath.split("/").map(encodeURIComponent).join("/")}`; }
async function storageJson(s, operation, url, options) {
  let response; try { response = await fetch(url, options); } catch (err) { throw new StorageError(operation, 0, "network failure"); }
  if (!response.ok) throw new StorageError(operation, response.status, await response.text().catch(() => ""));
  let value; try { value = await response.json(); } catch (_) { throw new StorageError(operation, response.status, "invalid JSON response"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StorageError(operation, response.status, "invalid representation");
  return value;
}
async function uploadObject(s, path, bytes, contentType) {
  const value = await storageJson(s, "upload", storagePath(s, path), { method: "POST", headers: { apikey: s.key, authorization: `Bearer ${s.key}`, "content-type": contentType, "x-upsert": "false" }, body: bytes });
  if (typeof (value.Key || value.key || value.path) !== "string") throw new StorageError("upload", 200, "invalid representation");
}
async function signObject(s, path) {
  const value = await storageJson(s, "sign", storagePath(s, path, "object/sign"), { method: "POST", headers: s.headers, body: JSON.stringify({ expiresIn: s.ttl }) });
  const raw = value.signedURL || value.signedUrl;
  if (typeof raw !== "string") throw new StorageError("sign", 200, "invalid representation");
  let url; try { url = new URL(raw, `${s.url}/`); } catch (_) { throw new StorageError("sign", 200, "invalid URL"); }
  if (url.protocol !== "https:") throw new StorageError("sign", 200, "invalid URL");
  return url.href;
}
async function deleteObject(s, path) {
  let response; try { response = await fetch(storagePath(s, path), { method: "DELETE", headers: { apikey: s.key, authorization: `Bearer ${s.key}` } }); } catch (err) { throw new StorageError("delete", 0, "network failure"); }
  if (!response.ok) throw new StorageError("delete", response.status, await response.text().catch(() => ""));
}
function send(res, status, body) { return res.status(status).json(body); }
function fail(res, status, error) { return send(res, status, { error }); }
function unexpected(res, operation, err) {
  const status = err instanceof StorageError ? 502 : 500;
  console.error(`[coach-page] ${operation} failed:`, err && err.name || "Error", err && err.status || "");
  return fail(res, status, status === 502 ? "storage_unavailable" : "internal_error");
}
function validateBase(req, withId = false, body = "empty") {
  if (!exactKeys(req.query || {}, [])) return "invalid_query";
  if (withId && (!exactKeys(req.params || {}, ["id"]) || !validUuid(req.params.id))) return "invalid_id";
  if (!withId && !exactKeys(req.params || {}, [])) return "invalid_id";
  if (body === "empty" && !emptyObject(req.body)) return "invalid_body";
  return null;
}

function buildCoachPageHandlers(deps) {
  const { requireSupabaseUser, now = () => new Date(), randomUUID = () => crypto.randomUUID() } = deps || {};
  async function identity(req, res) {
    if (typeof requireSupabaseUser !== "function") { fail(res, 503, "not_configured"); return null; }
    let auth;
    try { auth = await requireSupabaseUser(req); }
    catch (err) { unexpected(res, "authentication", err); return null; }
    if (auth && auth.error) {
      if (auth.status === 503) fail(res, 503, auth.error);
      else if (auth.status === 401 || auth.status === 403) fail(res, 401, "authentication_required");
      else fail(res, 500, "internal_error");
      return null;
    }
    if (!auth || !auth.user) { fail(res, 401, "authentication_required"); return null; }
    if (!auth.user.app_metadata || auth.user.app_metadata.role !== "coach") { fail(res, 403, "forbidden"); return null; }
    if (!validUuid(auth.user.id)) { fail(res, 403, "forbidden"); return null; }
    return { coachId: auth.user.id };
  }
  async function ready(req, res) { const who = await identity(req, res); if (!who) return null; const s = config(); if (!s) { fail(res, 503, "not_configured"); return null; } return { ...who, s }; }
  async function owned(s, table, select, coachId, id) { return one(await sbGet(s, `${table}?id=eq.${encodeURIComponent(id)}&coach_id=eq.${encodeURIComponent(coachId)}&select=${select}&limit=1`)); }
  async function signRow(s, coachId, row, requirePublishable = false) {
    if (requirePublishable && (!row.active || !publishablePhoto(row))) return null;
    // Recheck the live tenant row before minting any bearer capability. A DB
    // failure here is required-state failure and must escape optional signing.
    const fresh = await owned(s, "coach_photos", PHOTO_SELECT, coachId, row.id);
    if (!fresh || fresh.object_path !== row.object_path || (requirePublishable && (!fresh.active || !publishablePhoto(fresh)))) return null;
    const parsed = parseObjectPath(coachId, fresh.object_path);
    if (!parsed) throw new StorageError("sign", 0, "invalid stored path");
    const url = await signObject(s, parsed.path);
    return photoDto(fresh, url);
  }
  async function mutationResult(s, table, select, coachId, id, rows) { const row = one(rows); if (row) return row; const fresh = await owned(s, table, select, coachId, id); if (!fresh) return null; throw new DbError("STATE", 500, "mutation returned no representation for live row"); }
  async function ownedMutation(s, table, select, coachId, id, action) {
    try { return await action(); }
    catch (err) {
      const payload = dbPayload(err);
      if (err instanceof DbError && err.status === 409 && payload && payload.code === "23503") {
        if (!await owned(s, table, select, coachId, id)) return null;
      }
      throw err;
    }
  }

  async function getCoachPage(req, res) { try {
    const invalid = validateBase(req); if (invalid) return fail(res, 400, invalid);
    const ctx = await ready(req, res); if (!ctx) return;
    const cid = encodeURIComponent(ctx.coachId);
    const profile = one(await sbGet(ctx.s, `coaches?id=eq.${cid}&select=${PROFILE_SELECT}&limit=1`)); if (!profile) return fail(res, 404, "not_found");
    const locations = await sbGet(ctx.s, `coach_locations?coach_id=eq.${cid}&select=${LOCATION_SELECT}&order=sort.asc,created_at.asc`);
    const photos = await sbGet(ctx.s, `coach_photos?coach_id=eq.${cid}&select=${PHOTO_SELECT}&order=sort.asc,created_at.asc`);
    const socials = await sbGet(ctx.s, `coach_socials?coach_id=eq.${cid}&select=${SOCIAL_SELECT}&order=sort.asc,created_at.asc`);
    const sections = await sbGet(ctx.s, `coach_page_sections?coach_id=eq.${cid}&select=${SECTION_SELECT}&order=sort.asc`);
    const gallery = [];
    for (const row of photos) { try { const signed = await signRow(ctx.s, ctx.coachId, row); if (signed) gallery.push(signed); } catch (err) { if (err instanceof DbError) throw err; console.error("[coach-page] omitted invalid photo:", row && row.id || "unknown"); } }
    return send(res, 200, { coach_page: { profile: profileDto(profile), locations: locations.map(locationDto), gallery, socials: socials.map(socialDto), sections: mergeSections(sections) } });
  } catch (err) { return unexpected(res, "getCoachPage", err); } }

  async function patchProfile(req, res) { try {
    if (!exactKeys(req.query || {}, []) || !exactKeys(req.params || {}, [])) return fail(res, 400, "invalid_query");
    let body; try { body = normalizeProfile(req.body); } catch (_) { return fail(res, 400, "invalid_body"); }
    const ctx = await ready(req, res); if (!ctx) return;
    const rows = await sbPatch(ctx.s, `coaches?id=eq.${encodeURIComponent(ctx.coachId)}&select=${PROFILE_SELECT}`, body);
    const row = one(rows); if (!row) return fail(res, 404, "not_found"); return send(res, 200, { profile: profileDto(row) });
  } catch (err) { return unexpected(res, "patchProfile", err); } }

  async function postLocation(req, res) { try {
    if (!exactKeys(req.query || {}, []) || !exactKeys(req.params || {}, [])) return fail(res, 400, "invalid_query");
    let body; try { body = normalizeLocation(req.body); } catch (_) { return fail(res, 400, "invalid_body"); }
    const ctx = await ready(req, res); if (!ctx) return; const cid = encodeURIComponent(ctx.coachId);
    const count = await sbGet(ctx.s, `coach_locations?coach_id=eq.${cid}&select=id`); if (count.length >= 8) return fail(res, 400, "limit_reached");
    let row; try { row = one(await sbPost(ctx.s, "coach_locations", { coach_id: ctx.coachId, ...body })); }
    catch (err) { if (namedViolation(err, "23514", "coach_locations_limit")) { const again = await sbGet(ctx.s, `coach_locations?coach_id=eq.${cid}&select=id`); if (again.length >= 8) return fail(res, 400, "limit_reached"); } throw err; }
    if (!row) throw new DbError("POST", 500, "missing representation"); return send(res, 201, { location: locationDto(row) });
  } catch (err) { return unexpected(res, "postLocation", err); } }

  async function patchLocation(req, res) { try {
    if (!exactKeys(req.query || {}, []) || !exactKeys(req.params || {}, ["id"]) || !validUuid(req.params.id)) return fail(res, 400, "invalid_id");
    let body; try { body = normalizeLocation(req.body, true); } catch (_) { return fail(res, 400, "invalid_body"); }
    const ctx = await ready(req, res); if (!ctx) return; if (!await owned(ctx.s, "coach_locations", LOCATION_SELECT, ctx.coachId, req.params.id)) return fail(res, 404, "not_found");
    const path = `coach_locations?id=eq.${encodeURIComponent(req.params.id)}&coach_id=eq.${encodeURIComponent(ctx.coachId)}&select=${LOCATION_SELECT}`;
    const mutated = await ownedMutation(ctx.s, "coach_locations", LOCATION_SELECT, ctx.coachId, req.params.id, () => sbPatch(ctx.s, path, body));
    if (mutated === null) return fail(res, 404, "not_found");
    const row = await mutationResult(ctx.s, "coach_locations", LOCATION_SELECT, ctx.coachId, req.params.id, mutated);
    if (!row) return fail(res, 404, "not_found"); return send(res, 200, { location: locationDto(row) });
  } catch (err) { return unexpected(res, "patchLocation", err); } }
  async function deleteLocation(req, res) { return deleteSimple(req, res, "coach_locations", LOCATION_SELECT, "deleteLocation"); }

  async function postSocial(req, res) { try {
    if (!exactKeys(req.query || {}, []) || !exactKeys(req.params || {}, [])) return fail(res, 400, "invalid_query");
    let body; try { body = normalizeSocial(req.body); } catch (_) { return fail(res, 400, "invalid_body"); }
    const ctx = await ready(req, res); if (!ctx) return; const cid = encodeURIComponent(ctx.coachId);
    const count = await sbGet(ctx.s, `coach_socials?coach_id=eq.${cid}&select=id`); if (count.length >= 6) return fail(res, 400, "limit_reached");
    let row; try { row = one(await sbPost(ctx.s, "coach_socials", { coach_id: ctx.coachId, ...body })); }
    catch (err) { if (namedViolation(err, "23505", "coach_socials_platform_unique")) { const live = one(await sbGet(ctx.s, `coach_socials?coach_id=eq.${cid}&platform=eq.${encodeURIComponent(body.platform)}&select=id&limit=1`)); if (live) return fail(res, 409, "social_exists"); } throw err; }
    if (!row) throw new DbError("POST", 500, "missing representation"); return send(res, 201, { social: socialDto(row) });
  } catch (err) { return unexpected(res, "postSocial", err); } }

  async function patchSocial(req, res) { try {
    if (!exactKeys(req.query || {}, []) || !exactKeys(req.params || {}, ["id"]) || !validUuid(req.params.id)) return fail(res, 400, "invalid_id");
    let body; try { body = normalizeSocial(req.body, true); } catch (_) { return fail(res, 400, "invalid_body"); }
    const ctx = await ready(req, res); if (!ctx) return; const existing = await owned(ctx.s, "coach_socials", SOCIAL_SELECT, ctx.coachId, req.params.id); if (!existing) return fail(res, 404, "not_found");
    const platform = body.platform || existing.platform; if (Object.hasOwn(body, "url")) { try { body.url = canonicalSocialUrl(platform, body.url); } catch (_) { return fail(res, 400, "invalid_body"); } }
    else if (Object.hasOwn(body, "platform")) { try { body.url = canonicalSocialUrl(platform, existing.url); } catch (_) { return fail(res, 400, "invalid_body"); } }
    const path = `coach_socials?id=eq.${encodeURIComponent(req.params.id)}&coach_id=eq.${encodeURIComponent(ctx.coachId)}&select=${SOCIAL_SELECT}`;
    let rows; try { rows = await ownedMutation(ctx.s, "coach_socials", SOCIAL_SELECT, ctx.coachId, req.params.id, () => sbPatch(ctx.s, path, body)); if (rows === null) return fail(res, 404, "not_found"); }
    catch (err) { if (namedViolation(err, "23505", "coach_socials_platform_unique")) { const live = one(await sbGet(ctx.s, `coach_socials?coach_id=eq.${encodeURIComponent(ctx.coachId)}&platform=eq.${encodeURIComponent(platform)}&select=id&limit=1`)); if (live && live.id !== req.params.id) return fail(res, 409, "social_exists"); } throw err; }
    const row = await mutationResult(ctx.s, "coach_socials", SOCIAL_SELECT, ctx.coachId, req.params.id, rows); if (!row) return fail(res, 404, "not_found"); return send(res, 200, { social: socialDto(row) });
  } catch (err) { return unexpected(res, "patchSocial", err); } }
  async function deleteSocial(req, res) { return deleteSimple(req, res, "coach_socials", SOCIAL_SELECT, "deleteSocial"); }

  async function patchPhoto(req, res) { try {
    if (!exactKeys(req.query || {}, []) || !exactKeys(req.params || {}, ["id"]) || !validUuid(req.params.id)) return fail(res, 400, "invalid_id");
    let body; try { body = normalizePhoto(req.body); } catch (_) { return fail(res, 400, "invalid_body"); }
    const ctx = await ready(req, res); if (!ctx) return; const existing = await owned(ctx.s, "coach_photos", PHOTO_SELECT, ctx.coachId, req.params.id); if (!existing) return fail(res, 404, "not_found");
    if (body.active === true && !publishablePhoto(existing)) return fail(res, 400, "guardian_consent_required");
    const publishGate = body.active === true ? "&consent_attested_at=not.is.null&or=(identifiable_minor.eq.false,guardian_consent_recorded_at.not.is.null)" : "";
    const path = `coach_photos?id=eq.${encodeURIComponent(req.params.id)}&coach_id=eq.${encodeURIComponent(ctx.coachId)}${publishGate}&select=${PHOTO_SELECT}`;
    const mutated = await ownedMutation(ctx.s, "coach_photos", PHOTO_SELECT, ctx.coachId, req.params.id, () => sbPatch(ctx.s, path, body)); if (mutated === null) return fail(res, 404, "not_found");
    if (body.active === true && mutated.length === 0) {
      const fresh = await owned(ctx.s, "coach_photos", PHOTO_SELECT, ctx.coachId, req.params.id);
      if (!fresh) return fail(res, 404, "not_found");
      if (!publishablePhoto(fresh)) return fail(res, 400, "guardian_consent_required");
    }
    const row = await mutationResult(ctx.s, "coach_photos", PHOTO_SELECT, ctx.coachId, req.params.id, mutated); if (!row) return fail(res, 404, "not_found");
    const signed = await signRow(ctx.s, ctx.coachId, row); if (!signed) return fail(res, 404, "not_found");
    return send(res, 200, { photo: signed });
  } catch (err) { return unexpected(res, "patchPhoto", err); } }

  async function deletePhoto(req, res) { try {
    const invalid = validateBase(req, true); if (invalid) return fail(res, 400, invalid);
    const ctx = await ready(req, res); if (!ctx) return; const existing = await owned(ctx.s, "coach_photos", PHOTO_SELECT, ctx.coachId, req.params.id); if (!existing) return fail(res, 404, "not_found");
    const path = `coach_photos?id=eq.${encodeURIComponent(req.params.id)}&coach_id=eq.${encodeURIComponent(ctx.coachId)}&select=${PHOTO_SELECT}`;
    const mutated = await ownedMutation(ctx.s, "coach_photos", PHOTO_SELECT, ctx.coachId, req.params.id, () => sbDelete(ctx.s, path)); if (mutated === null) return fail(res, 404, "not_found");
    const row = await mutationResult(ctx.s, "coach_photos", PHOTO_SELECT, ctx.coachId, req.params.id, mutated); if (!row) return fail(res, 404, "not_found");
    const parsed = parseObjectPath(ctx.coachId, row.object_path); if (parsed) try { await deleteObject(ctx.s, parsed.path); } catch (err) { console.error("[coach-page] photo cleanup failed (non-fatal):", err.name, err.status || ""); }
    return send(res, 200, { deleted: true });
  } catch (err) { return unexpected(res, "deletePhoto", err); } }

  async function postPhoto(req, res) { try {
    if (!exactKeys(req.query || {}, []) || !exactKeys(req.params || {}, [])) return fail(res, 400, "invalid_query");
    const headers = req.headers || {}, key = headers["idempotency-key"], consent = headers["x-coach-page-consent"];
    const identifiableMinor = headers["x-coach-page-identifiable-minor"];
    const guardianConsent = headers["x-coach-page-guardian-consent"];
    if (!validUuid(key) || consent !== "confirmed" || !["true", "false"].includes(identifiableMinor) ||
        !["true", "false"].includes(guardianConsent)) return fail(res, 400, "invalid_body");
    let caption = null; if (Object.hasOwn(headers, "x-coach-page-caption")) { try { caption = nullableText(decodeURIComponent(headers["x-coach-page-caption"]), 200); } catch (_) { return fail(res, 400, "invalid_body"); } }
    let image; try { image = detectImage(req.body, headers["content-type"]); } catch (_) { return fail(res, 400, "invalid_body"); }
    if (image.unsupported) return fail(res, 415, "unsupported_media_type");
    const ctx = await ready(req, res); if (!ctx) return; const cid = encodeURIComponent(ctx.coachId), sha256 = crypto.createHash("sha256").update(req.body).digest("hex");
    async function winner() { return one(await sbGet(ctx.s, `coach_photos?coach_id=eq.${cid}&upload_key=eq.${encodeURIComponent(key)}&select=${PHOTO_INTERNAL_SELECT}&limit=1`)); }
    let existing = await winner(); if (existing) { if (existing.sha256 !== sha256) return fail(res, 409, "idempotency_conflict"); const signed = await signRow(ctx.s, ctx.coachId, existing); if (!signed) return fail(res, 404, "not_found"); return send(res, 200, { photo: signed }); }
    const count = await sbGet(ctx.s, `coach_photos?coach_id=eq.${cid}&select=id`); if (count.length >= 12) return fail(res, 400, "limit_reached");
    const generated = randomUUID(); if (!validUuid(generated) || !/^.{14}4/i.test(generated) || !/^[89ab]/i.test(generated[19])) throw new TypeError("randomUUID returned non-v4 UUID");
    const objectPath = `${ctx.coachId}/${generated.toLowerCase()}.${image.extension}`;
    const cleanup = async () => { try { await deleteObject(ctx.s, objectPath); } catch (err) { console.error("[coach-page] upload cleanup failed (non-fatal):", err.name, err.status || ""); } };
    try { await uploadObject(ctx.s, objectPath, req.body, image.contentType); } catch (err) { await cleanup(); throw err; }
    let row;
    const recordedAt = now().toISOString();
    try { row = one(await sbPost(ctx.s, "coach_photos", { coach_id: ctx.coachId, object_path: objectPath, upload_key: key, sha256, caption, active: false, sort: 0, consent_attested_at: recordedAt, identifiable_minor: identifiableMinor === "true", guardian_consent_recorded_at: guardianConsent === "true" ? recordedAt : null })); }
    catch (err) {
      if (namedViolation(err, "23505", "coach_photos_upload_key_unique")) { existing = await winner(); await cleanup(); if (existing) { if (existing.sha256 !== sha256) return fail(res, 409, "idempotency_conflict"); const signed = await signRow(ctx.s, ctx.coachId, existing); if (!signed) return fail(res, 404, "not_found"); return send(res, 200, { photo: signed }); } }
      else if (namedViolation(err, "23514", "coach_photos_limit")) { await cleanup(); const again = await sbGet(ctx.s, `coach_photos?coach_id=eq.${cid}&select=id`); if (again.length >= 12) return fail(res, 400, "limit_reached"); throw err; }
      else await cleanup();
      throw err;
    }
    if (!row) { await cleanup(); throw new DbError("POST", 500, "missing representation"); }
    const signed = await signRow(ctx.s, ctx.coachId, row); if (!signed) return fail(res, 404, "not_found");
    return send(res, 201, { photo: signed });
  } catch (err) { return unexpected(res, "postPhoto", err); } }

  async function putSections(req, res) { try {
    if (!exactKeys(req.query || {}, []) || !exactKeys(req.params || {}, [])) return fail(res, 400, "invalid_query");
    let sections; try { sections = normalizeSections(req.body); } catch (_) { return fail(res, 400, "invalid_body"); }
    const ctx = await ready(req, res); if (!ctx) return; const payload = sections.map((item) => ({ coach_id: ctx.coachId, section_key: item.key, visible: item.visible, sort: item.sort }));
    await sbPost(ctx.s, "coach_page_sections?on_conflict=coach_id,section_key", payload, "resolution=merge-duplicates,return=representation");
    const rows = await sbGet(ctx.s, `coach_page_sections?coach_id=eq.${encodeURIComponent(ctx.coachId)}&select=${SECTION_SELECT}&order=sort.asc`);
    if (rows.length !== 7) throw new DbError("STATE", 500, "section verification failed");
    const actual = rows.map((r) => ({ key: r.section_key, visible: r.visible, sort: r.sort })).sort((a, b) => a.sort - b.sort);
    if (JSON.stringify(actual) !== JSON.stringify(sections)) throw new DbError("STATE", 500, "section verification failed");
    return send(res, 200, { sections: actual });
  } catch (err) { return unexpected(res, "putSections", err); } }

  async function deleteSimple(req, res, table, select, operation) { try {
    const invalid = validateBase(req, true); if (invalid) return fail(res, 400, invalid);
    const ctx = await ready(req, res); if (!ctx) return; if (!await owned(ctx.s, table, select, ctx.coachId, req.params.id)) return fail(res, 404, "not_found");
    const path = `${table}?id=eq.${encodeURIComponent(req.params.id)}&coach_id=eq.${encodeURIComponent(ctx.coachId)}&select=${select}`;
    const mutated = await ownedMutation(ctx.s, table, select, ctx.coachId, req.params.id, () => sbDelete(ctx.s, path)); if (mutated === null) return fail(res, 404, "not_found");
    const row = await mutationResult(ctx.s, table, select, ctx.coachId, req.params.id, mutated); if (!row) return fail(res, 404, "not_found"); return send(res, 200, { deleted: true });
  } catch (err) { return unexpected(res, operation, err); } }

  return { getCoachPage, patchProfile, postLocation, patchLocation, deleteLocation, postPhoto, patchPhoto, deletePhoto, postSocial, patchSocial, deleteSocial, putSections };
}

async function readPublicCoachPage(input) {
  if (!exactKeys(input, ["coachId"]) || !validUuid(input.coachId)) throw new TypeError("invalid coachId");
  const s = config(); if (!s) throw new DbError("CONFIG", 503, "not configured");
  const cid = encodeURIComponent(input.coachId);
  const profile = one(await sbGet(s, `coaches?id=eq.${cid}&select=${PROFILE_SELECT}&limit=1`)); if (!profile) throw new DbError("GET", 404, "coach not found");
  const locations = await sbGet(s, `coach_locations?coach_id=eq.${cid}&active=eq.true&select=${LOCATION_SELECT}&order=sort.asc,created_at.asc`);
  const photos = await sbGet(s, `coach_photos?coach_id=eq.${cid}&active=eq.true&consent_attested_at=not.is.null&or=(identifiable_minor.eq.false,guardian_consent_recorded_at.not.is.null)&select=${PHOTO_SELECT}&order=sort.asc,created_at.asc`);
  const socials = await sbGet(s, `coach_socials?coach_id=eq.${cid}&select=${SOCIAL_SELECT}&order=sort.asc,created_at.asc`);
  const sections = await sbGet(s, `coach_page_sections?coach_id=eq.${cid}&select=${SECTION_SELECT}&order=sort.asc`);
  const gallery = [];
  for (const row of photos) { try {
    if (!row.active || !publishablePhoto(row)) continue;
    const fresh = one(await sbGet(s, `coach_photos?id=eq.${encodeURIComponent(row.id)}&coach_id=eq.${cid}&active=eq.true&consent_attested_at=not.is.null&or=(identifiable_minor.eq.false,guardian_consent_recorded_at.not.is.null)&select=${PHOTO_SELECT}&limit=1`));
    if (!fresh || fresh.object_path !== row.object_path || !publishablePhoto(fresh)) continue;
    const parsed = parseObjectPath(input.coachId, fresh.object_path); if (!parsed) throw new StorageError("sign", 0, "invalid stored path");
    const url = await signObject(s, parsed.path);
    gallery.push({ url, caption: fresh.caption ?? null, sort: fresh.sort });
  } catch (err) { if (err instanceof DbError) throw err; console.error("[coach-page] omitted invalid public photo:", row && row.id || "unknown"); } }
  return { profile: profileDto(profile), locations: locations.map((row) => { const dto = locationDto(row); return { name: dto.name, address: dto.address, note: dto.note, sort: dto.sort }; }), gallery, socials: socials.map((row) => { const dto = socialDto(row); return { platform: dto.platform, url: dto.url, sort: dto.sort }; }), sections: mergeSections(sections) };
}

module.exports = { buildCoachPageHandlers, readPublicCoachPage, DbError, StorageError, requestJson, sbGet, sbPost, sbPatch, sbDelete, one, exactKeys, validUuid, normalizeProfile, normalizeLocation, normalizeSocial, normalizePhoto, normalizeSections, canonicalSocialUrl, defaultsSections, mergeSections, guardianConsentRecorded, publishablePhoto, detectImage, galleryTtl, parseObjectPath, profileDto, locationDto, socialDto, photoDto };
