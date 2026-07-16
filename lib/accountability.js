// Accountability/homework route factory. Registration and feature gating live
// in index.js; importing and building this module perform no I/O.

const crypto = require("node:crypto");
const {
  brandedEmailShell, buildPlainText, escapeHtml, sendTransactionalEmail,
} = require("./email-shell");
const { sendAccountabilityPage } = require("./accountability-page");

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const DAY_MS = 24 * 60 * 60 * 1000;
const ROW_SELECT = "id,coach_id,athlete_id,session_id,title,detail,due_date,status,completed_at,completed_via,created_at,athletes(id,name,user_id,parent_email)";
const PUBLIC_SELECT = "id,coach_id,athlete_id,title,detail,status,complete_token,complete_token_expires_at";
const COMPLETION_EVENT_SELECT = "id,coach_id,athlete_id,title";

class DbError extends Error {
  constructor(method, status, detail) {
    super(`supabase ${method} ${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

function sb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return { url, key, headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" } };
}

async function requestJson(s, method, path, body) {
  let response;
  try {
    response = await fetch(`${s.url}/rest/v1/${path}`, {
      method, headers: method === "GET" ? s.headers : { ...s.headers, prefer: "return=representation" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw new DbError(method, 0, err && err.message || "network failure");
  }
  if (!response.ok) throw new DbError(method, response.status, await response.text().catch(() => ""));
  try { return await response.json(); }
  catch (err) { throw new DbError(method, response.status, err && err.message || "invalid JSON response"); }
}
const sbGet = (s, path) => requestJson(s, "GET", path);
const sbPost = (s, path, body) => requestJson(s, "POST", path, body);
const sbPatch = (s, path, body) => requestJson(s, "PATCH", path, body);

function one(rows) { return Array.isArray(rows) && rows.length ? rows[0] : null; }
function relation(value) { return Array.isArray(value) ? value[0] || null : value || null; }
function exactKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key));
}
function validUuid(value) { return typeof value === "string" && UUID_RE.test(value); }
function hasJsonContentType(req) {
  const value = req && req.headers && req.headers["content-type"];
  return typeof value === "string" && /^application\/json(?:\s*;|$)/i.test(value);
}
function codePoints(value) { return [...value].length; }
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return y >= 1 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
function completionTokenExpiry(assignedAt, dueDate) {
  const start = assignedAt instanceof Date ? assignedAt : new Date(assignedAt);
  if (!Number.isFinite(start.getTime())) throw new TypeError("invalid assignment instant");
  const noDue = new Date(start.getTime() + 90 * DAY_MS);
  if (dueDate == null) return noDue.toISOString();
  if (!validDate(dueDate)) throw new TypeError("invalid due date");
  const floor = new Date(start.getTime() + 30 * DAY_MS);
  const throughDue = new Date(`${dueDate}T00:00:00.000Z`);
  throughDue.setUTCDate(throughDue.getUTCDate() + 31);
  return new Date(Math.max(floor.getTime(), throughDue.getTime())).toISOString();
}
function homeworkDto(row) {
  const athlete = relation(row.athletes) || {};
  return {
    id: row.id, athlete: { id: athlete.id || row.athlete_id, name: athlete.name || "" },
    session_id: row.session_id || null, title: row.title, detail: row.detail || null,
    due_date: row.due_date || null, status: row.status, completed_at: row.completed_at || null,
    completed_via: row.completed_via || null, created_at: row.created_at,
  };
}
function send(res, status, data) { return res.status(status).json(data); }
function error(res, status, code) { return send(res, status, { error: code }); }
function noStore(res) {
  res.set({ "Cache-Control": "no-store, max-age=0", Pragma: "no-cache", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow, noarchive" });
}
function parseDbPayload(err) {
  if (!(err instanceof DbError)) return null;
  try { const out = JSON.parse(err.detail); return out && typeof out === "object" ? out : null; } catch (_) { return null; }
}

function buildAccountabilityHandlers(deps) {
  const { requireSupabaseUser, notify, sendEmail = sendTransactionalEmail,
    now = () => new Date(), randomUUID = () => crypto.randomUUID() } = deps || {};

  async function identity(req, res, allowAthlete) {
    if (typeof requireSupabaseUser !== "function") { error(res, 503, "not_configured"); return null; }
    const authd = await requireSupabaseUser(req);
    if (!authd || authd.error) { error(res, authd && authd.status || 401, authd && authd.error || "unauthorized"); return null; }
    const user = authd.user || {};
    if (user.app_metadata && user.app_metadata.role === "coach") return { role: "coach", coachId: user.id };
    if (!allowAthlete) { error(res, 403, "forbidden"); return null; }
    const s = sb();
    if (!s) { error(res, 503, "not_configured"); return null; }
    const rows = await sbGet(s, `athletes?user_id=eq.${encodeURIComponent(user.id)}&select=id,coach_id,name,user_id&limit=2`);
    if (!Array.isArray(rows) || rows.length !== 1) { error(res, 403, "forbidden"); return null; }
    return { role: "athlete", coachId: rows[0].coach_id, athleteId: rows[0].id, athleteName: rows[0].name || "" };
  }
  async function safeNotify(payload) {
    if (typeof notify !== "function") return;
    try { await notify(payload); } catch (err) { console.error("[accountability] notify failed (non-fatal):", err); }
  }
  async function safeEmail(payload) {
    if (typeof sendEmail !== "function") return;
    try { await sendEmail(payload); } catch (err) { console.error("[accountability] email failed (non-fatal):", err); }
  }
  async function ownedHomework(s, id, who) {
    let path = `homework?id=eq.${encodeURIComponent(id)}&coach_id=eq.${encodeURIComponent(who.coachId)}`;
    if (who.role === "athlete") path += `&athlete_id=eq.${encodeURIComponent(who.athleteId)}`;
    return one(await sbGet(s, `${path}&select=${ROW_SELECT}&limit=1`));
  }
  function completedEvent(row) {
    const athlete = relation(row.athletes) || {};
    return { userId: row.coach_id, type: "homework.completed", title: "Homework completed",
      body: `${athlete.name || "An athlete"} completed ${row.title}.`,
      data: { homeworkId: row.id, athleteId: row.athlete_id, href: "/homework" },
      dedupeKey: `homework.completed:${row.id}` };
  }
  async function rereadCompletion(s, id, who) {
    const fresh = await ownedHomework(s, id, who);
    if (!fresh) return { kind: "missing" };
    if (fresh.status === "done") return { kind: "done", row: fresh };
    return { kind: "invalid" };
  }

  async function postHomework(req, res) {
    try {
      const body = req.body;
      const allowed = ["athlete_id", "title", "detail", "due_date", "session_id"];
      if (!exactKeys(body, allowed) || !Object.hasOwn(body, "athlete_id") || !Object.hasOwn(body, "title") ||
          !validUuid(body.athlete_id) || typeof body.title !== "string") return error(res, 400, "invalid_body");
      const title = body.title.trim();
      if (!title || codePoints(title) > 200) return error(res, 400, "invalid_body");
      let detail = body.detail == null ? null : body.detail;
      if (typeof detail !== "string" && detail !== null) return error(res, 400, "invalid_body");
      detail = detail == null || !detail.trim() ? null : detail.trim();
      if (detail && codePoints(detail) > 2000) return error(res, 400, "invalid_body");
      let dueDate = body.due_date == null || body.due_date === "" ? null : body.due_date;
      if (typeof dueDate === "string") dueDate = dueDate.trim() || null;
      if (dueDate !== null && !validDate(dueDate)) return error(res, 400, "invalid_body");
      const sessionId = body.session_id == null ? null : body.session_id;
      if (sessionId !== null && !validUuid(sessionId)) return error(res, 400, "invalid_body");
      const who = await identity(req, res, false); if (!who) return;
      if (who.role !== "coach") return error(res, 403, "forbidden");
      const s = sb(); if (!s) return error(res, 503, "not_configured");
      const athlete = one(await sbGet(s, `athletes?id=eq.${encodeURIComponent(body.athlete_id)}&coach_id=eq.${encodeURIComponent(who.coachId)}&select=id,coach_id,name,parent_email,user_id&limit=1`));
      if (!athlete) return error(res, 404, "not_found");
      if (sessionId) {
        const session = one(await sbGet(s, `sessions?id=eq.${encodeURIComponent(sessionId)}&coach_id=eq.${encodeURIComponent(who.coachId)}&athlete_id=eq.${encodeURIComponent(athlete.id)}&select=id&limit=1`));
        if (!session) return error(res, 404, "not_found");
      }
      const instant = now();
      const token = randomUUID();
      if (!validUuid(token)) throw new TypeError("randomUUID returned invalid UUID");
      let inserted;
      try {
        inserted = one(await sbPost(s, "homework", { coach_id: who.coachId, athlete_id: athlete.id,
          session_id: sessionId, drill_block_id: null, title, detail, due_date: dueDate, status: "assigned",
          complete_token: token, complete_token_expires_at: completionTokenExpiry(instant, dueDate) }));
      } catch (err) {
        const payload = parseDbPayload(err);
        if (err.status === 409 && payload && payload.code === "23503") {
          const stillOwned = one(await sbGet(s, `athletes?id=eq.${encodeURIComponent(athlete.id)}&coach_id=eq.${encodeURIComponent(who.coachId)}&select=id&limit=1`));
          if (!stillOwned) return error(res, 404, "not_found");
          if (sessionId) {
            const liveSession = one(await sbGet(s, `sessions?id=eq.${encodeURIComponent(sessionId)}&coach_id=eq.${encodeURIComponent(who.coachId)}&athlete_id=eq.${encodeURIComponent(athlete.id)}&select=id&limit=1`));
            if (!liveSession) return error(res, 404, "not_found");
          }
        }
        throw err;
      }
      if (!inserted || !inserted.id) throw new DbError("POST", 500, "missing representation");
      const row = one(await sbGet(s, `homework?id=eq.${encodeURIComponent(inserted.id)}&coach_id=eq.${encodeURIComponent(who.coachId)}&select=${ROW_SELECT}&limit=1`));
      if (!row) return error(res, 404, "not_found");
      const base = String(process.env.ACCOUNTABILITY_PUBLIC_URL || process.env.SCHEDULING_PUBLIC_URL || "https://coachtime.app").replace(/\/+$/, "");
      const completeUrl = `${base}/hw/${token}`;
      const event = { userId: athlete.user_id, type: "homework.assigned", title: "New homework",
        body: `${title}\nMark it done: ${completeUrl}`, data: { homeworkId: row.id, href: completeUrl },
        dedupeKey: `homework.assigned:${row.id}`, email: athlete.parent_email || undefined };
      if (athlete.user_id) await safeNotify(event);
      else if (typeof athlete.parent_email === "string" && athlete.parent_email.trim()) {
        const safeTitle = escapeHtml(title), safeUrl = escapeHtml(completeUrl);
        await safeEmail({ to: athlete.parent_email, subject: "New homework",
          html: brandedEmailShell(`<tr><td style="padding:32px 40px 0"><h1>${safeTitle}</h1><p>Mark it done: <a href="${safeUrl}">${safeUrl}</a></p></td></tr>`),
          text: buildPlainText([title, `Mark it done: ${completeUrl}`]) });
      }
      return send(res, 201, { homework: homeworkDto(row), complete_url: completeUrl });
    } catch (err) { return unexpected(res, "postHomework", err); }
  }

  async function getHomework(req, res) {
    try {
      const query = req.query || {};
      if (!exactKeys(query, ["athlete_id", "status"])) return error(res, 400, "invalid_query");
      if (Object.hasOwn(query, "athlete_id") && !validUuid(query.athlete_id)) return error(res, 400, "invalid_query");
      if (Object.hasOwn(query, "status") && !["assigned", "done"].includes(query.status)) return error(res, 400, "invalid_query");
      const who = await identity(req, res, false); if (!who) return;
      if (who.role !== "coach") return error(res, 403, "forbidden");
      const s = sb(); if (!s) return error(res, 503, "not_configured");
      if (query.athlete_id) {
        const athlete = one(await sbGet(s, `athletes?id=eq.${encodeURIComponent(query.athlete_id)}&coach_id=eq.${encodeURIComponent(who.coachId)}&select=id&limit=1`));
        if (!athlete) return error(res, 404, "not_found");
      }
      let path = `homework?coach_id=eq.${encodeURIComponent(who.coachId)}`;
      if (query.athlete_id) path += `&athlete_id=eq.${encodeURIComponent(query.athlete_id)}`;
      if (query.status) path += `&status=eq.${query.status}`;
      const rows = await sbGet(s, `${path}&select=${ROW_SELECT}&order=created_at.desc`);
      return send(res, 200, { homework: (Array.isArray(rows) ? rows : []).map(homeworkDto) });
    } catch (err) { return unexpected(res, "getHomework", err); }
  }

  async function postHomeworkDone(req, res) {
    try {
      if (!validUuid(req.params && req.params.id)) return error(res, 400, "invalid_id");
      if (!exactKeys(req.body, []) || Object.keys(req.body).length) return error(res, 400, "invalid_body");
      const who = await identity(req, res, true); if (!who) return;
      const s = sb(); if (!s) return error(res, 503, "not_configured");
      let row = await ownedHomework(s, req.params.id, who);
      if (!row) return error(res, 404, "not_found");
      if (row.status === "done") return send(res, 200, { homework: homeworkDto(row) });
      if (row.status !== "assigned") throw new DbError("STATE", 500, "invalid homework state");
      const completedAt = now().toISOString();
      let path = `homework?id=eq.${encodeURIComponent(row.id)}&coach_id=eq.${encodeURIComponent(who.coachId)}`;
      if (who.role === "athlete") path += `&athlete_id=eq.${encodeURIComponent(who.athleteId)}`;
      path += "&status=eq.assigned";
      let patched;
      try { patched = one(await sbPatch(s, path, { status: "done", completed_at: completedAt, completed_via: who.role === "coach" ? "coach" : "athlete_app" })); }
      catch (err) { throw err; }
      if (!patched) {
        const result = await rereadCompletion(s, row.id, who);
        if (result.kind === "missing") return error(res, 404, "not_found");
        if (result.kind !== "done") throw new DbError("STATE", 500, "completion race invalid state");
        row = result.row;
      } else {
        row = await ownedHomework(s, row.id, who);
        if (!row) return error(res, 404, "not_found");
        if (who.role === "athlete") await safeNotify(completedEvent(row));
      }
      return send(res, 200, { homework: homeworkDto(row) });
    } catch (err) { return unexpected(res, "postHomeworkDone", err); }
  }

  async function publicLookup(s, raw) {
    const token = validUuid(raw) ? raw.toLowerCase() : ZERO_UUID;
    const row = one(await sbGet(s, `homework?complete_token=eq.${encodeURIComponent(token)}&select=${PUBLIC_SELECT}&limit=1`));
    return { token, row };
  }
  function publicLive(row, instant) {
    return row && Number.isFinite(Date.parse(row.complete_token_expires_at)) && Date.parse(row.complete_token_expires_at) > instant.getTime();
  }
  async function publicCompletedEvent(s, row) {
    try {
      const full = one(await sbGet(s, `homework?id=eq.${encodeURIComponent(row.id)}&coach_id=eq.${encodeURIComponent(row.coach_id)}&select=${COMPLETION_EVENT_SELECT}&limit=1`));
      if (full) await safeNotify(completedEvent(full));
    } catch (err) {
      console.error("[accountability] public completion delivery failed (non-fatal):", err);
    }
  }
  async function getPublicHomework(req, res) {
    noStore(res);
    try {
      const s = sb(); if (!s) return error(res, 503, "not_configured");
      const { row } = await publicLookup(s, req.params && req.params.completeToken);
      if (!publicLive(row, now())) return error(res, 404, "not_found");
      if (row.status === "done") return send(res, 200, { state: "completed" });
      if (row.status !== "assigned") return error(res, 404, "not_found");
      return send(res, 200, { state: "assigned", homework: { title: String(row.title || "").trim(), detail: row.detail == null || !String(row.detail).trim() ? null : String(row.detail).trim() } });
    } catch (err) { return unexpected(res, "getPublicHomework", err); }
  }
  async function postPublicDone(req, res) {
    noStore(res);
    try {
      if (!hasJsonContentType(req)) return error(res, 400, "invalid_body");
      if (!exactKeys(req.body, []) || Object.keys(req.body).length) return error(res, 400, "invalid_body");
      const s = sb(); if (!s) return error(res, 503, "not_configured");
      const instant = now();
      const { token, row } = await publicLookup(s, req.params && req.params.completeToken);
      if (!publicLive(row, instant)) return error(res, 404, "not_found");
      if (row.status === "done") return send(res, 200, { state: "completed" });
      if (row.status !== "assigned") return error(res, 404, "not_found");
      const path = `homework?id=eq.${encodeURIComponent(row.id)}&coach_id=eq.${encodeURIComponent(row.coach_id)}&complete_token=eq.${encodeURIComponent(token)}&status=eq.assigned&complete_token_expires_at=gt.${encodeURIComponent(instant.toISOString())}`;
      const patched = one(await sbPatch(s, path, { status: "done", completed_at: instant.toISOString(), completed_via: "tap" }));
      if (patched) await publicCompletedEvent(s, row);
      else {
        const fresh = (await publicLookup(s, token)).row;
        if (!fresh || !publicLive(fresh, instant)) return error(res, 404, "not_found");
        if (fresh.status !== "done") throw new DbError("STATE", 500, "completion race invalid state");
      }
      return send(res, 200, { state: "completed" });
    } catch (err) { return unexpected(res, "postPublicDone", err); }
  }
  function getPublicPage(_req, res) { return sendAccountabilityPage(res); }
  function unexpected(res, operation, err) {
    console.error(`[accountability] ${operation} failed:`, err);
    return error(res, 500, "internal_error");
  }
  return { postHomework, getHomework, postHomeworkDone, getPublicPage, getPublicHomework, postPublicDone };
}

module.exports = { buildAccountabilityHandlers, completionTokenExpiry, validDate };
