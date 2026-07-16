// Calendar-sync factory and dark outbound primitives. Route registration and
// feature gating belong to index.js. This module has no import-time I/O.

const crypto = require("node:crypto");
const { escapeIcs, foldIcsLine, formatCalendarDate } = require("./ics");
const { encryptSecret, decryptSecret } = require("./crypto-box");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^cal_[0-9a-f]{48}$/;
const ZERO_TOKEN = `cal_${"0".repeat(48)}`;
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
const GOOGLE_API = "https://www.googleapis.com/calendar/v3";
const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
];
const SETTINGS_SELECT = "coach_id,ics_feed_token,ics_enabled";
const CONNECTION_SELECT =
  "coach_id,provider,google_email,refresh_token_enc,access_token_enc," +
  "access_token_expires_at,status,last_synced_at,sync_error_code";
const SLOT_SELECT =
  "id,coach_id,booked_by,status,starts_at,ends_at,timezone,title,session_id," +
  "calendar_blocked,gcal_event_id";
const CALLBACK_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>CoachTime</title></head><body><main><p>Google Calendar connected. Return to CoachTime.</p></main></body></html>";
const CALLBACK_ERROR_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>CoachTime</title></head><body><main><p>Unable to connect Google Calendar. Return to CoachTime.</p></main></body></html>";

class DbError extends Error {
  constructor(method, status, detail) {
    super("calendar database request failed");
    this.method = method;
    this.status = status;
    this.detail = detail;
  }
}

class ProviderError extends Error {
  constructor(code = "google_unavailable", status = 502) {
    super("calendar provider request failed");
    this.code = code;
    this.status = status;
  }
}

function validUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function exactObject(value, keys) {
  return value != null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key));
}

function emptyObject(value) {
  return exactObject(value, []);
}

function noQuery(req) {
  return req.query == null || emptyObject(req.query);
}

function noBody(req) {
  return req.body == null || emptyObject(req.body);
}

function scalar(value, max = 4096) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function relation(value) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function setHeader(res, name, value) {
  if (typeof res.set === "function") res.set(name, value);
  else if (typeof res.setHeader === "function") res.setHeader(name, value);
  return res;
}

function sendJson(res, status, value) {
  return res.status(status).json(value);
}

function sendError(res, status, code) {
  return sendJson(res, status, { error: code });
}

function noStore(res) {
  setHeader(res, "Cache-Control", "no-store, max-age=0");
  setHeader(res, "Pragma", "no-cache");
}

function feedSecurity(res, active) {
  setHeader(res, "Cache-Control", active ? "private, max-age=300" : "no-store, max-age=0");
  if (!active) setHeader(res, "Pragma", "no-cache");
  setHeader(res, "Referrer-Policy", "no-referrer");
  setHeader(res, "X-Robots-Tag", "noindex, nofollow, noarchive");
  if (active) setHeader(res, "Content-Disposition", 'inline; filename="coachtime.ics"');
}

function callbackHeaders(res) {
  noStore(res);
  setHeader(res, "Referrer-Policy", "no-referrer");
  setHeader(res, "X-Robots-Tag", "noindex, nofollow, noarchive");
  setHeader(res, "Content-Security-Policy", "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  setHeader(res, "Content-Type", "text/html; charset=utf-8");
}

function sendHtml(res, status, html) {
  callbackHeaders(res);
  return res.status(status).send(html);
}

function sb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return {
    url: url.replace(/\/+$/, ""),
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
  };
}

async function fetchResponse(url, options, kind) {
  try {
    return await fetch(url, options);
  } catch (_) {
    if (kind === "db") throw new DbError(options.method || "GET", 502, "network");
    throw new ProviderError();
  }
}

async function dbJson(response, method, expected = "array") {
  if (!response.ok) {
    throw new DbError(method, response.status, await response.text().catch(() => ""));
  }
  let value;
  try { value = await response.json(); } catch (_) {
    throw new DbError(method, 502, "invalid success body");
  }
  if ((expected === "array" && !Array.isArray(value)) ||
      (expected === "number" && !Number.isInteger(value))) {
    throw new DbError(method, 502, "invalid success shape");
  }
  return value;
}

async function sbRequest(s, method, path, body, expected = "array", prefer) {
  const headers = { ...s.headers };
  if (prefer) headers.prefer = prefer;
  const response = await fetchResponse(`${s.url}/rest/v1/${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, "db");
  return dbJson(response, method, expected);
}

const sbGet = (s, path) => sbRequest(s, "GET", path);
const sbPost = (s, path, body, expected = "array", prefer = "return=representation") =>
  sbRequest(s, "POST", path, body, expected, prefer);
const sbPatch = (s, path, body) =>
  sbRequest(s, "PATCH", path, body, "array", "return=representation");

function one(rows) {
  return Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
}

function dbPayload(error) {
  if (!(error instanceof DbError) || typeof error.detail !== "string") return null;
  try {
    const parsed = JSON.parse(error.detail);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (_) { return null; }
}

function uniqueConstraint(error, name) {
  const value = dbPayload(error);
  if (!value || value.code !== "23505") return false;
  const detail = `${value.message || ""} ${value.details || ""} ${value.hint || ""}`;
  return detail.includes(name);
}

function publicBase() {
  return (process.env.CALENDAR_PUBLIC_URL || process.env.SCHEDULING_PUBLIC_URL ||
    "https://coachtime.app").replace(/\/+$/, "");
}

function validHexKey(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function googleConfig(needsState = true) {
  const config = {
    clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_CALENDAR_REDIRECT_URI,
    tokenKey: process.env.CALENDAR_TOKEN_KEY,
    stateSecret: process.env.CALENDAR_OAUTH_STATE_SECRET,
  };
  let redirect;
  try { redirect = new URL(config.redirectUri); } catch (_) { return null; }
  if (!config.clientId || !config.clientSecret || !validHexKey(config.tokenKey) ||
      !redirect || redirect.protocol !== "https:" ||
      !redirect.pathname.endsWith("/calendar/google/callback")) return null;
  if (needsState && (!validHexKey(config.stateSecret) ||
      config.stateSecret.toLowerCase() === config.tokenKey.toLowerCase())) return null;
  return config;
}

function feedToken(randomBytes) {
  const bytes = randomBytes(24);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new TypeError("randomBytes must return bytes");
  }
  const buffer = Buffer.from(bytes);
  if (buffer.length !== 24) throw new TypeError("randomBytes returned wrong length");
  return `cal_${buffer.toString("hex")}`;
}

function settingRow(row) {
  return row && validUuid(row.coach_id) && TOKEN_RE.test(row.ics_feed_token || "") &&
    typeof row.ics_enabled === "boolean" ? {
      coach_id: row.coach_id.toLowerCase(),
      ics_feed_token: row.ics_feed_token,
      ics_enabled: row.ics_enabled,
    } : null;
}

function connectionPublic(row) {
  if (!row) return null;
  if (!validUuid(row.coach_id) || row.provider !== "google" ||
      !["active", "error"].includes(row.status) ||
      !(row.google_email == null || typeof row.google_email === "string") ||
      !(row.last_synced_at == null || Number.isFinite(Date.parse(row.last_synced_at)))) {
    throw new DbError("PARSE", 502, "invalid connection row");
  }
  return {
    email: row.google_email == null ? null : row.google_email,
    status: row.status,
    needs_reconnect: row.status === "error" && row.sync_error_code === "reauthorize",
    last_synced_at: row.last_synced_at == null ? null : new Date(row.last_synced_at).toISOString(),
  };
}

function connectionSecret(row) {
  if (!row || !validUuid(row.coach_id) || row.provider !== "google" ||
      typeof row.refresh_token_enc !== "string" || !row.refresh_token_enc ||
      !(row.access_token_enc == null || typeof row.access_token_enc === "string") ||
      !(row.access_token_expires_at == null || Number.isFinite(Date.parse(row.access_token_expires_at))) ||
      !["active", "error"].includes(row.status)) {
    throw new DbError("PARSE", 502, "invalid connection row");
  }
  return row;
}

function connectionDto(coachId, settings, connection) {
  return {
    ics: {
      enabled: settings.ics_enabled,
      feed_url: settings.ics_enabled
        ? `${publicBase()}/calendar/${coachId}/feed.ics?token=${encodeURIComponent(settings.ics_feed_token)}`
        : null,
    },
    google: connectionPublic(connection),
  };
}

async function readSettings(s, coachId) {
  const rows = await sbGet(s,
    `coach_calendar_settings?coach_id=eq.${encodeURIComponent(coachId)}&select=${SETTINGS_SELECT}&limit=2`);
  if (rows.length > 1) throw new DbError("GET", 500, "duplicate settings rows");
  if (!rows.length) return null;
  const parsed = settingRow(rows[0]);
  if (!parsed || parsed.coach_id !== coachId.toLowerCase()) {
    throw new DbError("PARSE", 502, "invalid settings row");
  }
  return parsed;
}

async function ensureSettings(s, coachId, randomBytes) {
  const existing = await readSettings(s, coachId);
  if (existing) return existing;
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = feedToken(randomBytes);
    try {
      const rows = await sbPost(s, "coach_calendar_settings", {
        coach_id: coachId,
        ics_feed_token: token,
        ics_enabled: true,
      });
      if (rows.length !== 1) throw new DbError("POST", 502, "missing settings representation");
      const parsed = settingRow(rows[0]);
      if (!parsed || parsed.coach_id !== coachId.toLowerCase() || parsed.ics_feed_token !== token) {
        throw new DbError("PARSE", 502, "invalid settings representation");
      }
      return parsed;
    } catch (error) {
      if (error.status === 409 && uniqueConstraint(error, "coach_calendar_settings_pkey")) {
        const raced = await readSettings(s, coachId);
        if (!raced) throw new DbError("POST", 500, "settings race vanished");
        return raced;
      }
      if (error.status === 409 &&
          uniqueConstraint(error, "coach_calendar_settings_feed_token_idx")) continue;
      throw error;
    }
  }
  throw new DbError("POST", 500, "feed token collision limit");
}

async function rotateSettings(s, coachId, enabled, randomBytes) {
  let current = await ensureSettings(s, coachId, randomBytes);
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = feedToken(randomBytes);
    try {
      const rows = await sbPatch(s,
        `coach_calendar_settings?coach_id=eq.${encodeURIComponent(coachId)}` +
        `&ics_feed_token=eq.${encodeURIComponent(current.ics_feed_token)}`,
        { ics_feed_token: token, ics_enabled: enabled });
      if (rows.length > 1) throw new DbError("PATCH", 500, "duplicate settings rows");
      if (rows.length === 1) {
        const parsed = settingRow(rows[0]);
        if (!parsed || parsed.coach_id !== coachId.toLowerCase() ||
            parsed.ics_feed_token !== token || parsed.ics_enabled !== enabled) {
          throw new DbError("PARSE", 502, "invalid settings mutation row");
        }
        return parsed;
      }
      const raced = await readSettings(s, coachId);
      if (!raced) return null;
      current = raced;
    } catch (error) {
      if (error.status === 409 &&
          uniqueConstraint(error, "coach_calendar_settings_feed_token_idx")) continue;
      throw error;
    }
  }
  throw new DbError("PATCH", 500, "settings rotation race limit");
}

async function readConnection(s, coachId, activeOnly = false) {
  const path = `calendar_connections?coach_id=eq.${encodeURIComponent(coachId)}` +
    `${activeOnly ? "&status=eq.active" : ""}&select=${CONNECTION_SELECT}&limit=2`;
  const rows = await sbGet(s, path);
  if (rows.length > 1) throw new DbError("GET", 500, "duplicate connection rows");
  return rows.length ? connectionSecret(rows[0]) : null;
}

async function providerJson(url, options, validate) {
  const response = await fetchResponse(url, options, "provider");
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new ProviderError();
    error.providerStatus = response.status;
    error.providerDetail = detail;
    throw error;
  }
  let value;
  try { value = await response.json(); } catch (_) { throw new ProviderError(); }
  if (!validate(value)) throw new ProviderError("invalid_provider_data");
  return value;
}

function tokenJson(value, requireRefresh) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    typeof value.access_token === "string" && value.access_token.length > 0 &&
    Number.isFinite(value.expires_in) && value.expires_in > 0 &&
    (!requireRefresh || (typeof value.refresh_token === "string" && value.refresh_token.length > 0));
}

async function tokenExchange(config, params, requireRefresh) {
  return providerJson(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  }, (value) => tokenJson(value, requireRefresh));
}

async function markConnection(s, coachId, body, extra = "") {
  return sbPatch(s,
    `calendar_connections?coach_id=eq.${encodeURIComponent(coachId)}${extra}`,
    body);
}

async function markConnectionFailure(s, connection, code) {
  const expiry = connection.access_token_expires_at == null
    ? null : new Date(connection.access_token_expires_at).toISOString();
  const rows = await markConnection(s, connection.coach_id,
    { status: "error", sync_error_code: code },
    `&refresh_token_enc=eq.${encodeURIComponent(connection.refresh_token_enc)}` +
    (expiry == null
      ? "&access_token_expires_at=is.null"
      : `&access_token_expires_at=eq.${encodeURIComponent(expiry)}`));
  if (rows.length > 1) throw new DbError("PATCH", 500, "duplicate failure representations");
  if (!rows.length) {
    // The connection generation changed while this request was in flight. A
    // reconnect or refresh is authoritative, so observe it without modifying it.
    await readConnection(s, connection.coach_id, true);
  }
}

async function accessToken(s, connection, instant) {
  const coachId = connection.coach_id;
  if (connection.access_token_enc && connection.access_token_expires_at &&
      Date.parse(connection.access_token_expires_at) > instant.getTime() + 60000) {
    try {
      return decryptSecret(connection.access_token_enc, { coachId, column: "access_token_enc" });
    } catch (_) {
      await markConnectionFailure(s, connection, "decrypt_failed");
      const error = new Error("calendar token decrypt failed");
      error.connectionFailureHandled = true;
      throw error;
    }
  }
  let refresh;
  try {
    refresh = decryptSecret(connection.refresh_token_enc, { coachId, column: "refresh_token_enc" });
  } catch (_) {
    await markConnectionFailure(s, connection, "decrypt_failed");
    const error = new Error("calendar token decrypt failed");
    error.connectionFailureHandled = true;
    throw error;
  }
  const config = googleConfig(false);
  if (!config) throw new ProviderError("google_not_configured", 503);
  let tokens;
  try {
    tokens = await tokenExchange(config, {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }, false);
  } catch (error) {
    if (error instanceof ProviderError && error.providerDetail) {
      try {
        const parsed = JSON.parse(error.providerDetail);
        if (parsed && parsed.error === "invalid_grant") {
          await markConnectionFailure(s, connection, "reauthorize");
          error.connectionFailureHandled = true;
        }
      } catch (_) { /* provider body is never exposed */ }
    }
    throw error;
  }
  const previousExpiry = connection.access_token_expires_at == null
    ? null : new Date(connection.access_token_expires_at).toISOString();
  const calculatedExpiry = instant.getTime() + Math.floor(tokens.expires_in * 1000);
  const previousExpiryMs = previousExpiry == null ? -Infinity : Date.parse(previousExpiry);
  // The expiry is the schema's monotonic refresh generation. It must change even
  // if a provider returns an unusually short lifetime equal to the old value.
  const expiresAt = new Date(Math.max(calculatedExpiry, previousExpiryMs + 1)).toISOString();
  const encrypted = encryptSecret(tokens.access_token, { coachId, column: "access_token_enc" });
  const rows = await markConnection(s, coachId, {
    access_token_enc: encrypted,
    access_token_expires_at: expiresAt,
    status: "active",
    sync_error_code: null,
  }, `&refresh_token_enc=eq.${encodeURIComponent(connection.refresh_token_enc)}` +
    (previousExpiry == null
      ? "&access_token_expires_at=is.null"
      : `&access_token_expires_at=eq.${encodeURIComponent(previousExpiry)}`));
  if (rows.length > 1) throw new DbError("PATCH", 500, "duplicate refresh representations");
  if (!rows.length) {
    // Another refresher won. Its token is authoritative; never overwrite it
    // with this request's now-stale provider response.
    const winner = await readConnection(s, coachId, true);
    if (!winner || !winner.access_token_enc || !winner.access_token_expires_at ||
        Date.parse(winner.access_token_expires_at) <= instant.getTime() + 60000) {
      throw new DbError("PATCH", 500, "connection refresh race");
    }
    try {
      return decryptSecret(winner.access_token_enc, { coachId, column: "access_token_enc" });
    } catch (_) {
      throw new DbError("DECRYPT", 500, "refresh winner integrity failure");
    }
  }
  const stored = connectionSecret(rows[0]);
  if (stored.coach_id.toLowerCase() !== coachId.toLowerCase() ||
      stored.refresh_token_enc !== connection.refresh_token_enc ||
      stored.access_token_enc !== encrypted || stored.access_token_expires_at !== expiresAt) {
    throw new DbError("PARSE", 502, "invalid refresh representation");
  }
  return tokens.access_token;
}

function validInstant(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function interval(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.start !== "string" || typeof value.end !== "string") return null;
  const start = Date.parse(value.start);
  const end = Date.parse(value.end);
  return Number.isFinite(start) && Number.isFinite(end) && start < end ? { start, end } : null;
}

function computeBlockTransitions(slots, busyIntervals) {
  if (!Array.isArray(slots) || !Array.isArray(busyIntervals)) {
    throw new TypeError("invalid block transition input");
  }
  const busy = busyIntervals.map(interval);
  if (busy.some((value) => !value)) throw new ProviderError("invalid_provider_data");
  const blockIds = [];
  const reopenIds = [];
  const seenBlock = new Set();
  const seenReopen = new Set();
  for (const slot of slots) {
    if (!slot || !validUuid(slot.id) || !validUuid(slot.coach_id) ||
        typeof slot.starts_at !== "string" || typeof slot.ends_at !== "string" ||
        typeof slot.calendar_blocked !== "boolean") {
      throw new DbError("PARSE", 502, "invalid slot row");
    }
    const start = Date.parse(slot.starts_at);
    const end = Date.parse(slot.ends_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      throw new DbError("PARSE", 502, "invalid slot interval");
    }
    const overlaps = busy.some((item) => start < item.end && end > item.start);
    if (slot.status === "open" && slot.calendar_blocked === false && overlaps && !seenBlock.has(slot.id)) {
      seenBlock.add(slot.id); blockIds.push(slot.id);
    } else if (slot.status === "cancelled" && slot.calendar_blocked === true &&
        !overlaps && !seenReopen.has(slot.id)) {
      seenReopen.add(slot.id); reopenIds.push(slot.id);
    }
  }
  return { block_ids: blockIds, reopen_ids: reopenIds };
}

async function reconcileBusyBlocks({ coachId, now } = {}) {
  if (!validUuid(coachId) || !validInstant(now)) throw new TypeError("invalid reconcile input");
  const s = sb();
  if (!s) throw new DbError("CONFIG", 503, "not configured");
  const connection = await readConnection(s, coachId, true);
  if (!connection) return { blocked: 0, reopened: 0 };
  const token = await accessToken(s, connection, now);
  const end = new Date(now.getTime() + 84 * 86400000);
  const freebusy = await providerJson(`${GOOGLE_API}/freeBusy`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      items: [{ id: "primary" }],
    }),
  }, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !value.calendars || typeof value.calendars !== "object" || Array.isArray(value.calendars) ||
        !Object.prototype.hasOwnProperty.call(value.calendars, "primary")) return false;
    const primary = value.calendars.primary;
    if (!primary || typeof primary !== "object" || Array.isArray(primary) ||
        !Array.isArray(primary.busy)) return false;
    if (primary.errors !== undefined &&
        (!Array.isArray(primary.errors) || primary.errors.length > 0)) return false;
    return true;
  });
  const busy = freebusy.calendars.primary.busy;
  busy.forEach((item) => { if (!interval(item)) throw new ProviderError("invalid_provider_data"); });
  const rows = await sbGet(s,
    `bookable_slots?coach_id=eq.${encodeURIComponent(coachId)}` +
    `&starts_at=gte.${encodeURIComponent(now.toISOString())}` +
    `&starts_at=lt.${encodeURIComponent(end.toISOString())}` +
    `&status=in.(open,cancelled)&select=id,coach_id,status,starts_at,ends_at,calendar_blocked&order=starts_at.asc,id.asc`);
  const transitions = computeBlockTransitions(rows, busy);
  let blocked = 0;
  let reopened = 0;
  for (const id of transitions.block_ids) {
    const patched = await sbPatch(s,
      `bookable_slots?id=eq.${encodeURIComponent(id)}&coach_id=eq.${encodeURIComponent(coachId)}` +
      "&status=eq.open&calendar_blocked=eq.false",
      { status: "cancelled", calendar_blocked: true });
    blocked += patched.length;
  }
  for (const id of transitions.reopen_ids) {
    const patched = await sbPatch(s,
      `bookable_slots?id=eq.${encodeURIComponent(id)}&coach_id=eq.${encodeURIComponent(coachId)}` +
      "&status=eq.cancelled&calendar_blocked=eq.true",
      { status: "open", calendar_blocked: false });
    reopened += patched.length;
  }
  return { blocked, reopened };
}

function cleanIcsField(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, "");
}

function escapedIcsField(value) {
  return escapeIcs(cleanIcsField(value));
}

function feedIcs(rows, instant, coachId) {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CoachTime//Calendar Sync//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
  ];
  for (const row of rows) {
    const athlete = row && relation(row.athletes);
    if (!row || !validUuid(row.id) || !validUuid(row.coach_id) ||
        row.coach_id.toLowerCase() !== coachId.toLowerCase() || row.status !== "booked" ||
        typeof row.starts_at !== "string" || typeof row.ends_at !== "string" ||
        !(row.athletes && typeof row.athletes === "object") ||
        (Array.isArray(row.athletes) && row.athletes.length !== 1) ||
        !athlete || Array.isArray(athlete) || typeof athlete.name !== "string" ||
        !(row.session_id == null || validUuid(row.session_id))) {
      throw new DbError("PARSE", 502, "invalid feed row");
    }
    const start = new Date(row.starts_at);
    const end = new Date(row.ends_at);
    if (!validInstant(start) || !validInstant(end) || start >= end) {
      throw new DbError("PARSE", 502, "invalid feed interval");
    }
    lines.push(
      "BEGIN:VEVENT",
      `UID:${cleanIcsField(row.id.toLowerCase())}@coachtime`,
      `DTSTAMP:${formatCalendarDate(instant)}`,
      `DTSTART:${formatCalendarDate(start)}`,
      `DTEND:${formatCalendarDate(end)}`,
      foldIcsLine(`SUMMARY:${escapedIcsField(`CoachTime — ${athlete.name}`)}`),
    );
    if (row.session_id) {
      const join = cleanIcsField(`${publicBase()}/join/${row.session_id}`);
      lines.push(
        foldIcsLine(`URL:${escapedIcsField(join)}`),
        foldIcsLine(`DESCRIPTION:${escapedIcsField(`Join CoachTime: ${join}`)}`),
      );
    }
    lines.push("STATUS:CONFIRMED", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function safeNow(nowFn) {
  const value = nowFn();
  if (!validInstant(value)) throw new TypeError("invalid now seam");
  return value;
}

function unexpected(res, error) {
  if (error instanceof ProviderError) {
    if (error.code === "google_not_configured" || error.status === 503) {
      return sendError(res, 503, "google_not_configured");
    }
    return sendError(res, 502, "google_unavailable");
  }
  if (error instanceof DbError && error.status === 503) return sendError(res, 503, "not_configured");
  return sendError(res, 500, "internal_error");
}

function mirrorSlotInput(args) {
  if (!exactObject(args, ["coachId", "athleteId", "slot"]) ||
      !validUuid(args.coachId) || !validUuid(args.athleteId)) return false;
  const slot = args.slot;
  const keys = ["id", "coach_id", "booked_by", "status", "starts_at", "ends_at",
    "timezone", "title", "session_id", "gcal_event_id"];
  return exactObject(slot, keys) && validUuid(slot.id) && validUuid(slot.coach_id) &&
    (slot.booked_by == null || validUuid(slot.booked_by)) &&
    ["booked", "open", "cancelled", "completed"].includes(slot.status) &&
    typeof slot.starts_at === "string" && Number.isFinite(Date.parse(slot.starts_at)) &&
    typeof slot.ends_at === "string" && Number.isFinite(Date.parse(slot.ends_at)) &&
    Date.parse(slot.starts_at) < Date.parse(slot.ends_at) &&
    typeof slot.timezone === "string" && slot.timezone.length > 0 &&
    (slot.title == null || typeof slot.title === "string") &&
    (slot.session_id == null || validUuid(slot.session_id)) &&
    (slot.gcal_event_id == null || (typeof slot.gcal_event_id === "string" && slot.gcal_event_id.length >= 5));
}

function deterministicEventId(slotId) {
  return `ct${crypto.createHash("sha256").update(slotId.toLowerCase()).digest("hex")}`;
}

async function googleDelete(token, eventId) {
  const response = await fetchResponse(
    `${GOOGLE_API}/calendars/primary/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE", headers: { authorization: `Bearer ${token}` } }, "provider");
  if (response.status !== 204 && response.status !== 404) throw new ProviderError();
}

async function mirrorCalendarBooking(args) {
  if (!mirrorSlotInput(args)) throw new TypeError("invalid mirror input");
  const { coachId, athleteId, slot } = args;
  const s = sb(); if (!s) throw new DbError("CONFIG", 503, "not configured");
  const rows = await sbGet(s,
    `bookable_slots?id=eq.${encodeURIComponent(slot.id)}&coach_id=eq.${encodeURIComponent(coachId)}` +
    `&booked_by=eq.${encodeURIComponent(athleteId)}&status=eq.booked&select=${SLOT_SELECT}&limit=2`);
  if (rows.length > 1) throw new DbError("GET", 500, "duplicate slot rows");
  if (!rows.length) return { mirrored: false, reason: "not_booked" };
  const owned = rows[0];
  if (!validUuid(owned.id) || owned.coach_id.toLowerCase() !== coachId.toLowerCase() ||
      owned.booked_by.toLowerCase() !== athleteId.toLowerCase() || owned.status !== "booked" ||
      !Number.isFinite(Date.parse(owned.starts_at)) || !Number.isFinite(Date.parse(owned.ends_at))) {
    throw new DbError("PARSE", 502, "invalid slot row");
  }
  const athleteRows = await sbGet(s,
    `athletes?id=eq.${encodeURIComponent(athleteId)}&coach_id=eq.${encodeURIComponent(coachId)}&select=id,coach_id,name&limit=2`);
  if (athleteRows.length !== 1 || typeof athleteRows[0].name !== "string") {
    return { mirrored: false, reason: "not_booked" };
  }
  const connection = await readConnection(s, coachId, true);
  if (!connection) return { mirrored: false, reason: "not_connected" };
  if (owned.gcal_event_id) {
    return { mirrored: true, event_id: owned.gcal_event_id, disposition: "existing" };
  }
  const instant = new Date();
  const token = await accessToken(s, connection, instant);
  const eventId = deterministicEventId(owned.id);
  const eventBody = {
    id: eventId,
    summary: `CoachTime — ${athleteRows[0].name}`,
    description: owned.session_id
      ? `Join CoachTime: ${publicBase()}/join/${owned.session_id}`
      : "Booked in CoachTime.",
    start: { dateTime: owned.starts_at },
    end: { dateTime: owned.ends_at },
    extendedProperties: { private: { coachTimeSlotId: owned.id, coachTimeManaged: "1" } },
  };
  let disposition = "created";
  let response = await fetchResponse(`${GOOGLE_API}/calendars/primary/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(eventBody),
  }, "provider");
  if (response.status === 409) {
    const existing = await providerJson(
      `${GOOGLE_API}/calendars/primary/events/${encodeURIComponent(eventId)}`,
      { headers: { authorization: `Bearer ${token}` } },
      (value) => value && value.id === eventId && value.extendedProperties &&
        value.extendedProperties.private &&
        value.extendedProperties.private.coachTimeSlotId === owned.id &&
        value.extendedProperties.private.coachTimeManaged === "1");
    if (!existing) throw new ProviderError();
    disposition = "existing";
  } else {
    if (!response.ok) throw new ProviderError();
    let created;
    try { created = await response.json(); } catch (_) { throw new ProviderError(); }
    if (!created || created.id !== eventId) throw new ProviderError("invalid_provider_data");
  }
  const patched = await sbPatch(s,
    `bookable_slots?id=eq.${encodeURIComponent(owned.id)}&coach_id=eq.${encodeURIComponent(coachId)}` +
    `&booked_by=eq.${encodeURIComponent(athleteId)}&status=eq.booked&gcal_event_id=is.null`,
    { gcal_event_id: eventId, gcal_event_updated_at: instant.toISOString() });
  if (!patched.length) {
    const fresh = await sbGet(s,
      `bookable_slots?id=eq.${encodeURIComponent(owned.id)}&coach_id=eq.${encodeURIComponent(coachId)}` +
      `&booked_by=eq.${encodeURIComponent(athleteId)}&status=eq.booked&select=gcal_event_id&limit=1`);
    if (fresh.length && fresh[0].gcal_event_id === eventId) {
      return { mirrored: true, event_id: eventId, disposition: "existing" };
    }
    await googleDelete(token, eventId).catch(() => {});
    return { mirrored: false, reason: "not_booked" };
  }
  return { mirrored: true, event_id: eventId, disposition };
}

function cancelInput(args) {
  return exactObject(args, ["coachId", "athleteId", "slot"]) &&
    validUuid(args.coachId) && (args.athleteId == null || validUuid(args.athleteId)) &&
    mirrorSlotInput({ coachId: args.coachId, athleteId: args.athleteId || args.coachId, slot: args.slot });
}

async function cancelCalendarBooking(args) {
  if (!cancelInput(args)) throw new TypeError("invalid cancel input");
  const { coachId, slot } = args;
  const s = sb(); if (!s) throw new DbError("CONFIG", 503, "not configured");
  if (!slot.gcal_event_id) return { cancelled: false, reason: "no_event" };
  const rows = await sbGet(s,
    `bookable_slots?id=eq.${encodeURIComponent(slot.id)}&coach_id=eq.${encodeURIComponent(coachId)}` +
    `&gcal_event_id=eq.${encodeURIComponent(slot.gcal_event_id)}&select=${SLOT_SELECT}&limit=2`);
  if (rows.length !== 1) return { cancelled: false, reason: "no_event" };
  const owned = rows[0];
  if (!["open", "cancelled"].includes(owned.status) || owned.booked_by != null) {
    return { cancelled: false, reason: "slot_not_cancelled" };
  }
  const connection = await readConnection(s, coachId, false);
  if (!connection) return { cancelled: false, reason: "not_connected" };
  const token = await accessToken(s, connection, new Date());
  const response = await fetchResponse(
    `${GOOGLE_API}/calendars/primary/events/${encodeURIComponent(owned.gcal_event_id)}`,
    { method: "DELETE", headers: { authorization: `Bearer ${token}` } }, "provider");
  if (response.status !== 204 && response.status !== 404) throw new ProviderError();
  const patched = await sbPatch(s,
    `bookable_slots?id=eq.${encodeURIComponent(owned.id)}&coach_id=eq.${encodeURIComponent(coachId)}` +
    `&status=in.(open,cancelled)&booked_by=is.null&gcal_event_id=eq.${encodeURIComponent(owned.gcal_event_id)}`,
    { gcal_event_id: null, gcal_event_updated_at: new Date().toISOString() });
  if (!patched.length) throw new DbError("PATCH", 500, "cancel mirror race");
  return {
    cancelled: true,
    disposition: response.status === 404 ? "already_absent" : "deleted",
  };
}

function buildCalendarHandlers({ requireSupabaseUser, now = () => new Date(), randomBytes = crypto.randomBytes } = {}) {
  if (typeof requireSupabaseUser !== "function") throw new TypeError("requireSupabaseUser is required");
  // Process-local observability for consecutive transient failures. The frozen
  // v1 schema has no durable counter column; eligibility is still determined by
  // the active status and the scheduled 15-minute sweep cadence.
  const transientFailures = new Map();
  if (typeof now !== "function" || typeof randomBytes !== "function") throw new TypeError("invalid calendar dependencies");

  async function coach(req, res) {
    const result = await requireSupabaseUser(req);
    if (!result || result.error) {
      sendError(res, result && result.status || 401, result && result.error || "unauthorized");
      return null;
    }
    const user = result.user || {};
    if (!validUuid(user.id) || !user.app_metadata || user.app_metadata.role !== "coach") {
      sendError(res, 403, "forbidden"); return null;
    }
    return user.id.toLowerCase();
  }

  async function getConnection(req, res) {
    if (!noQuery(req) || !noBody(req)) return sendError(res, 400, "invalid_request");
    try {
      const coachId = await coach(req, res); if (!coachId) return;
      const s = sb(); if (!s) return sendError(res, 503, "not_configured");
      const settings = await ensureSettings(s, coachId, randomBytes);
      const connection = await readConnection(s, coachId);
      return sendJson(res, 200, connectionDto(coachId, settings, connection));
    } catch (error) { return unexpected(res, error); }
  }

  async function postFeedReset(req, res) {
    if (!noQuery(req) || !emptyObject(req.body)) return sendError(res, 400, "invalid_request");
    try {
      const coachId = await coach(req, res); if (!coachId) return;
      const s = sb(); if (!s) return sendError(res, 503, "not_configured");
      const settings = await rotateSettings(s, coachId, true, randomBytes);
      if (!settings) return sendError(res, 404, "not_found");
      const connection = await readConnection(s, coachId);
      return sendJson(res, 200, connectionDto(coachId, settings, connection));
    } catch (error) { return unexpected(res, error); }
  }

  async function deleteFeed(req, res) {
    if (!noQuery(req) || !noBody(req)) return sendError(res, 400, "invalid_request");
    try {
      const coachId = await coach(req, res); if (!coachId) return;
      const s = sb(); if (!s) return sendError(res, 503, "not_configured");
      const settings = await rotateSettings(s, coachId, false, randomBytes);
      if (!settings) return sendError(res, 404, "not_found");
      return res.status(204).send();
    } catch (error) { return unexpected(res, error); }
  }

  async function postGoogleConnect(req, res) {
    if (!noQuery(req) || !emptyObject(req.body)) return sendError(res, 400, "invalid_request");
    try {
      const coachId = await coach(req, res); if (!coachId) return;
      if (!sb()) return sendError(res, 503, "not_configured");
      const config = googleConfig(true);
      if (!config) return sendError(res, 503, "google_not_configured");
      const instant = safeNow(now);
      const iat = Math.floor(instant.getTime() / 1000);
      const payload = {
        v: 1, coach_id: coachId, iat, exp: iat + 600,
        nonce: Buffer.from(randomBytes(16)).toString("base64url"),
      };
      if (!/^[A-Za-z0-9_-]{22}$/.test(payload.nonce)) throw new TypeError("invalid nonce entropy");
      const segment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      const signature = crypto.createHmac("sha256", Buffer.from(config.stateSecret, "hex"))
        .update(segment).digest("base64url");
      const state = `${segment}.${signature}`;
      const url = new URL(GOOGLE_AUTH);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("include_granted_scopes", "true");
      url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
      url.searchParams.set("state", state);
      return sendJson(res, 200, { auth_url: url.toString() });
    } catch (error) { return unexpected(res, error); }
  }

  function verifyState(raw, config, instant) {
    if (!scalar(raw, 4096)) return null;
    const parts = raw.split(".");
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
    const expected = crypto.createHmac("sha256", Buffer.from(config.stateSecret, "hex"))
      .update(parts[0]).digest();
    let supplied;
    try { supplied = Buffer.from(parts[1], "base64url"); } catch (_) { return null; }
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
    let payload;
    try {
      const canonical = Buffer.from(parts[0], "base64url");
      if (canonical.toString("base64url") !== parts[0]) return null;
      payload = JSON.parse(canonical.toString("utf8"));
    } catch (_) { return null; }
    if (!exactObject(payload, ["v", "coach_id", "iat", "exp", "nonce"]) ||
        payload.v !== 1 || !validUuid(payload.coach_id) ||
        !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) ||
        payload.exp !== payload.iat + 600 || !/^[A-Za-z0-9_-]{22}$/.test(payload.nonce)) return null;
    const current = Math.floor(instant.getTime() / 1000);
    if (payload.iat > current || payload.exp <= current) return null;
    return payload;
  }

  async function getGoogleCallback(req, res) {
    const query = req.query;
    if (!exactObject(query, ["code", "state"]) || !scalar(query.code, 4096) || !scalar(query.state, 4096) || !noBody(req)) {
      return sendHtml(res, 400, CALLBACK_ERROR_HTML);
    }
    try {
      const config = googleConfig(true);
      if (!config) return sendHtml(res, 503, CALLBACK_ERROR_HTML);
      const instant = safeNow(now);
      const state = verifyState(query.state, config, instant);
      if (!state) return sendHtml(res, 400, CALLBACK_ERROR_HTML);
      const s = sb(); if (!s) return sendHtml(res, 503, CALLBACK_ERROR_HTML);
      const tokens = await tokenExchange(config, {
        code: query.code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
      }, true);
      let email = null;
      try {
        const info = await providerJson(GOOGLE_USERINFO,
          { headers: { authorization: `Bearer ${tokens.access_token}` } },
          (value) => value && typeof value === "object" &&
            (value.email == null || typeof value.email === "string"));
        email = info.email || null;
      } catch (_) { email = null; }
      const coachId = state.coach_id.toLowerCase();
      const expiresAt = new Date(instant.getTime() + Math.floor(tokens.expires_in * 1000)).toISOString();
      const body = {
        coach_id: coachId,
        provider: "google",
        google_email: email,
        refresh_token_enc: encryptSecret(tokens.refresh_token, { coachId, column: "refresh_token_enc" }),
        access_token_enc: encryptSecret(tokens.access_token, { coachId, column: "access_token_enc" }),
        access_token_expires_at: expiresAt,
        status: "active",
        sync_error_code: null,
      };
      const stored = await sbPost(s,
        `calendar_connections?on_conflict=coach_id&coach_id=eq.${encodeURIComponent(coachId)}`,
        body, "array", "resolution=merge-duplicates,return=representation");
      if (stored.length !== 1) throw new DbError("POST", 502, "missing connection representation");
      const durable = connectionSecret(stored[0]);
      if (durable.coach_id.toLowerCase() !== coachId || durable.provider !== "google" ||
          durable.refresh_token_enc !== body.refresh_token_enc ||
          durable.access_token_enc !== body.access_token_enc ||
          durable.access_token_expires_at !== expiresAt || durable.status !== "active") {
        throw new DbError("PARSE", 502, "invalid connection representation");
      }
      try {
        await reconcileBusyBlocks({ coachId, now: instant });
        await markConnection(s, coachId, {
          status: "active", sync_error_code: null, last_synced_at: instant.toISOString(),
        });
      } catch (error) {
        const code = error instanceof ProviderError && error.code === "invalid_provider_data"
          ? "invalid_provider_data" : error && /decrypt/i.test(error.message) ? "decrypt_failed" : "google_unavailable";
        if ((code === "decrypt_failed" || code === "reauthorize") &&
            !error.connectionFailureHandled) {
          await markConnection(s, coachId, { status: "error", sync_error_code: code }).catch(() => {});
        }
      }
      return sendHtml(res, 200, CALLBACK_HTML);
    } catch (error) {
      const status = error instanceof ProviderError ? 502 : 500;
      return sendHtml(res, status, CALLBACK_ERROR_HTML);
    }
  }

  async function deleteGoogle(req, res) {
    if (!noQuery(req) || !noBody(req)) return sendError(res, 400, "invalid_request");
    try {
      const coachId = await coach(req, res); if (!coachId) return;
      const s = sb(); if (!s) return sendError(res, 503, "not_configured");
      const connection = await readConnection(s, coachId);
      if (!connection) return res.status(204).send();
      let token;
      try {
        const column = connection.access_token_enc ? "access_token_enc" : "refresh_token_enc";
        token = decryptSecret(connection[column], { coachId, column });
      } catch (_) { throw new DbError("DECRYPT", 500, "integrity failure"); }
      try {
        await fetchResponse(`${GOOGLE_REVOKE}?token=${encodeURIComponent(token)}`,
          { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } }, "provider");
      } catch (_) { /* local disconnect remains authoritative */ }
      const result = await sbPost(s, "rpc/disconnect_calendar_connection",
        { p_coach_id: coachId }, "number", "return=representation");
      if (!Number.isInteger(result) || result < 0) throw new DbError("POST", 502, "invalid rpc result");
      return res.status(204).send();
    } catch (error) { return unexpected(res, error); }
  }

  async function getFeed(req, res) {
    feedSecurity(res, false);
    if (!exactObject(req.query, ["token"]) || !scalar(req.query.token, 128) || !noBody(req)) {
      // Shape is still normalized into the same indexed lookup when configured.
    }
    try {
      const s = sb(); if (!s) return sendError(res, 503, "not_configured");
      const raw = exactObject(req.query, ["token"]) && scalar(req.query.token, 128)
        ? req.query.token : "";
      const token = TOKEN_RE.test(raw) ? raw : ZERO_TOKEN;
      const rows = await sbGet(s,
        `coach_calendar_settings?ics_feed_token=eq.${encodeURIComponent(token)}&select=coach_id,ics_enabled&limit=1`);
      const row = rows.length === 1 ? rows[0] : null;
      const pathCoach = req.params && req.params.coachId;
      if (!row || !validUuid(row.coach_id) || row.ics_enabled !== true ||
          !validUuid(pathCoach) || pathCoach !== pathCoach.toLowerCase() ||
          row.coach_id.toLowerCase() !== pathCoach) {
        return sendError(res, 404, "not_found");
      }
      const instant = safeNow(now);
      const horizon = new Date(instant.getTime() + 365 * 86400000);
      const slots = await sbGet(s,
        `bookable_slots?coach_id=eq.${encodeURIComponent(pathCoach)}&status=eq.booked` +
        `&starts_at=gt.${encodeURIComponent(instant.toISOString())}` +
        `&starts_at=lte.${encodeURIComponent(horizon.toISOString())}` +
        "&select=id,coach_id,status,starts_at,ends_at,session_id,athletes:booked_by(name)" +
        "&order=starts_at.asc&limit=500");
      const text = feedIcs(slots, instant, pathCoach);
      feedSecurity(res, true);
      setHeader(res, "Content-Type", "text/calendar; charset=utf-8");
      return res.status(200).send(text);
    } catch (error) { return unexpected(res, error); }
  }

  async function getCronSync(req, res) {
    if (!noQuery(req) || !noBody(req)) return sendError(res, 400, "invalid_request");
    const secret = process.env.CRON_SECRET;
    const supplied = typeof req.get === "function" ? req.get("x-cron-secret") :
      req.headers && req.headers["x-cron-secret"];
    if (!secret || supplied !== secret) return sendError(res, 401, "unauthorized");
    const s = sb();
    if (!s) return sendJson(res, 200, { scanned: 0, synced: 0, failed: 0, blocked: 0, reopened: 0 });
    let connections;
    try {
      connections = await sbGet(s,
        `calendar_connections?status=eq.active&select=coach_id&order=coach_id.asc`);
      if (connections.some((row) => !row || !validUuid(row.coach_id))) {
        throw new DbError("PARSE", 502, "invalid scan row");
      }
    } catch (_) { return sendError(res, 500, "calendar_sync_failed"); }
    const counters = { scanned: 0, synced: 0, failed: 0, blocked: 0, reopened: 0 };
    for (const item of connections) {
      counters.scanned++;
      const instant = safeNow(now);
      try {
        const result = await reconcileBusyBlocks({ coachId: item.coach_id, now: instant });
        transientFailures.delete(item.coach_id);
        counters.synced++;
        counters.blocked += result.blocked;
        counters.reopened += result.reopened;
        await markConnection(s, item.coach_id, {
          status: "active", sync_error_code: null, last_synced_at: instant.toISOString(),
        }, "&status=eq.active");
      } catch (error) {
        counters.failed++;
        const code = error instanceof ProviderError && error.code === "invalid_provider_data"
          ? "invalid_provider_data" : error && /decrypt/i.test(error.message) ? "decrypt_failed" :
            error instanceof ProviderError && error.providerDetail && error.providerDetail.includes("invalid_grant")
              ? "reauthorize" : "google_unavailable";
        if (code === "reauthorize" || code === "decrypt_failed") {
          if (!error.connectionFailureHandled) {
            await markConnection(s, item.coach_id,
              { status: "error", sync_error_code: code }, "&status=eq.active").catch(() => {});
          }
        } else {
          // Transient/provider-data failures remain eligible for the next
          // scheduled sweep. The 15-minute cron cadence is the v1 backoff.
          await markConnection(s, item.coach_id,
            { status: "active", sync_error_code: null }, "&status=eq.active").catch(() => {});
          transientFailures.set(item.coach_id, (transientFailures.get(item.coach_id) || 0) + 1);
        }
      }
    }
    return sendJson(res, 200, counters);
  }

  return {
    getConnection, postFeedReset, deleteFeed, postGoogleConnect,
    getGoogleCallback, deleteGoogle, getFeed, getCronSync,
  };
}

module.exports = {
  buildCalendarHandlers,
  mirrorCalendarBooking,
  cancelCalendarBooking,
  reconcileBusyBlocks,
  computeBlockTransitions,
};
