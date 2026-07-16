// lib/api-rest.js
//
// The key-authed REST surface for CoachTime's open API, mounted under /api/v1
// behind the API_ENABLED flag. Every coach with an API key can drive their own
// coaching business (athletes, sessions, slots, bookings, packages, invites)
// from their own AI/agents.
//
// #1 SECURITY REQUIREMENT (build brief): EVERY read AND write is tenant-locked
// to req.apiKey.coachId. Minors' PII rides on this. There are NO cross-tenant
// reads, ever:
//   * list/read queries append &coach_id=eq.<coachId> to the PostgREST filter.
//   * a single-row read of a foreign id resolves EMPTY -> 404 (reveals nothing).
//   * a write to a foreign id fails the ownership pre-check -> 403 cross_tenant
//     or 404, and the write never fires.
// The coachId is server-derived from the authenticated key (never the body).
//
// SHAPE: buildApiCore(deps) returns pure-ish async functions that each return
// { status, data } and are reused verbatim by the MCP tools (lib/mcp.js).
// buildApiHandlers(deps) wraps them into Express handlers. Supabase access uses
// the SERVICE KEY (bypasses RLS); isolation is the manual coach_id lock above.
// Supabase unconfigured -> 503 (house style, never 500).

const {
  expandWindows,
  creditBalance,
  refundBookingCredit,
} = require("./scheduling");

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const PAGE_MAX = 100;
const PAGE_DEFAULT = 50;

// ---- Supabase REST helpers (service role, same posture as scheduling.js) ----
function sb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return {
    url,
    key,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
  };
}

async function sbGet(s, pathWithQuery) {
  const resp = await fetch(`${s.url}/rest/v1/${pathWithQuery}`, { headers: s.headers });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`supabase GET ${resp.status}: ${detail}`);
  }
  return resp.json().catch(() => []);
}

async function sbPost(s, table, body, { representation = true } = {}) {
  const resp = await fetch(`${s.url}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      ...s.headers,
      prefer: representation ? "return=representation" : "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`supabase POST ${resp.status}: ${detail}`);
  }
  if (!representation) return null;
  return resp.json().catch(() => []);
}

async function sbPatch(s, pathWithQuery, body, { representation = true } = {}) {
  const resp = await fetch(`${s.url}/rest/v1/${pathWithQuery}`, {
    method: "PATCH",
    headers: {
      ...s.headers,
      prefer: representation ? "return=representation" : "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`supabase PATCH ${resp.status}: ${detail}`);
  }
  if (!representation) return null;
  return resp.json().catch(() => []);
}

async function sbDelete(s, pathWithQuery) {
  const resp = await fetch(`${s.url}/rest/v1/${pathWithQuery}`, {
    method: "DELETE",
    headers: { ...s.headers, prefer: "return=representation" },
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`supabase DELETE ${resp.status}: ${detail}`);
  }
  return resp.json().catch(() => []);
}

// ---- small utilities --------------------------------------------------------

// Clamp/parse limit + offset. limit in [1, PAGE_MAX], offset >= 0.
function parsePaging({ limit, offset } = {}) {
  let l = Number(limit);
  if (!Number.isFinite(l) || l < 1) l = PAGE_DEFAULT;
  if (l > PAGE_MAX) l = PAGE_MAX;
  let o = Number(offset);
  if (!Number.isFinite(o) || o < 0) o = 0;
  return { limit: Math.floor(l), offset: Math.floor(o) };
}

// Keep only allowed keys that are actually present (undefined dropped). Used to
// build a whitelist body for writes so a client can never set coach_id, id, etc.
function pick(input, allowed) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const k of allowed) {
    if (input[k] !== undefined) out[k] = input[k];
  }
  return out;
}

// Range header for PostgREST pagination (offset..offset+limit-1).
function rangeQuery(limit, offset) {
  return `&limit=${limit}&offset=${offset}`;
}

const ATHLETE_FIELDS = [
  "name",
  "position",
  "age",
  "school",
  "goals",
  "parent_name",
  "parent_phone",
  "parent_email",
];
const ATHLETE_SELECT =
  "id,coach_id,name,position,age,school,goals,parent_name,parent_phone,parent_email,created_at";

const SESSION_FIELDS = ["athlete_id", "title", "session_date", "film_url", "film_provider", "status"];
const SESSION_SELECT =
  "id,coach_id,athlete_id,title,session_date,film_url,film_provider,status,created_at";

const SLOT_SELECT =
  "id,coach_id,starts_at,ends_at,timezone,status,booked_by,session_id,session_type_id,window_id,title,note,source,created_at";

const INVITE_SELECT =
  "token,coach_id,athlete_id,slot_id,email,status,expires_at,accepted_at,created_at";

const PACKAGE_SELECT =
  "id,name,description,price_cents,credits,expires_days,active,created_at";

const PURCHASE_SELECT =
  "id,coach_id,package_id,athlete_id,credits_total,credits_remaining,status,purchased_at";

// ---- core ------------------------------------------------------------------

/**
 * Build the tenant-locked API core. Each function takes { coachId, ... } and
 * returns { status, data }. The MCP tools and the Express handlers both call
 * these, so the tenant lock lives in exactly one place.
 */
function buildApiCore(deps) {
  const { notify } = deps || {};

  // Ownership pre-check: does this athlete belong to this coach? Returns true/
  // false. Used before any write that references an athlete_id.
  async function coachOwnsAthlete(s, coachId, athleteId) {
    const rows = await sbGet(
      s,
      `athletes?id=eq.${athleteId}&coach_id=eq.${coachId}&select=id&limit=1`,
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  // ===== athletes ===========================================================

  async function listAthletes({ coachId, limit, offset }) {
    const s = sb();
    if (!s) return { status: 503, data: { error: "api not configured" } };
    const p = parsePaging({ limit, offset });
    const rows = await sbGet(
      s,
      `athletes?coach_id=eq.${coachId}&select=${ATHLETE_SELECT}` +
        `&order=created_at.desc${rangeQuery(p.limit, p.offset)}`,
    );
    return { status: 200, data: { athletes: rows, limit: p.limit, offset: p.offset } };
  }

  async function getAthlete({ coachId, id }) {
    const s = sb();
    if (!s) return { status: 503, data: { error: "api not configured" } };
    if (!UUID_RE.test(String(id))) return { status: 400, data: { error: "bad id" } };
    const rows = await sbGet(
      s,
      `athletes?id=eq.${id}&coach_id=eq.${coachId}&select=${ATHLETE_SELECT}&limit=1`,
    );
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    // A foreign/unknown id resolves empty -> 404 (never leaks another tenant).
    if (!row) return { status: 404, data: { error: "not found" } };
    return { status: 200, data: { athlete: row } };
  }

  async function createAthlete({ coachId, input }) {
    const s = sb();
    if (!s) return { status: 503, data: { error: "api not configured" } };
    const body = pick(input, ATHLETE_FIELDS);
    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      return { status: 400, data: { error: "name is required" } };
    }
    body.coach_id = coachId; // tenant lock: never trust a body coach_id
    const rows = await sbPost(s, `athletes?select=${ATHLETE_SELECT}`, body);
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!row) return { status: 502, data: { error: "create failed" } };
    return { status: 201, data: { athlete: row } };
  }

  async function updateAthlete({ coachId, id, input }) {
    const s = sb();
    if (!s) return { status: 503, data: { error: "api not configured" } };
    if (!UUID_RE.test(String(id))) return { status: 400, data: { error: "bad id" } };
    // Ownership pre-check: a foreign id -> 404, and no write fires.
    if (!(await coachOwnsAthlete(s, coachId, id))) {
      return { status: 404, data: { error: "not found" } };
    }
    const body = pick(input, ATHLETE_FIELDS);
    if (Object.keys(body).length === 0) {
      return { status: 400, data: { error: "no updatable fields" } };
    }
    // The coach_id filter is a second lock even after the ownership check.
    const rows = await sbPatch(
      s,
      `athletes?id=eq.${id}&coach_id=eq.${coachId}&select=${ATHLETE_SELECT}`,
      body,
    );
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!row) return { status: 404, data: { error: "not found" } };
    return { status: 200, data: { athlete: row } };
  }

  async function deleteAthlete({ coachId, id }) {
    const s = sb();
    if (!s) return { status: 503, data: { error: "api not configured" } };
    if (!UUID_RE.test(String(id))) return { status: 400, data: { error: "bad id" } };
    if (!(await coachOwnsAthlete(s, coachId, id))) {
      return { status: 404, data: { error: "not found" } };
    }
    const rows = await sbDelete(s, `athletes?id=eq.${id}&coach_id=eq.${coachId}`);
    const deleted = Array.isArray(rows) && rows.length > 0;
    return { status: 200, data: { deleted, id } };
  }

  // ===== sessions ===========================================================

  async function listSessions({ coachId, athleteId, limit, offset }) {
    const s = sb();
    if (!s) return { status: 503, data: { error: "api not configured" } };
    const p = parsePaging({ limit, offset });
    let filter = `sessions?coach_id=eq.${coachId}`;
    if (athleteId) {
      if (!UUID_RE.test(String(athleteId))) {
        return { status: 400, data: { error: "bad athlete_id" } };
      }
      // coach_id lock already guarantees tenant isolation; this just narrows.
      filter += `&athlete_id=eq.${athleteId}`;
    }
    const rows = await sbGet(
      s,
      `${filter}&select=${SESSION_SELECT}&order=created_at.desc${rangeQuery(p.limit, p.offset)}`,
    );
    return { status: 200, data: { sessions: rows, limit: p.limit, offset: p.offset } };
  }

  async function getSession({ coachId, id }) {
    const s = sb();
    if (!s) return { status: 503, data: { error: "api not configured" } };
    if (!UUID_RE.test(String(id))) return { status: 400, data: { error: "bad id" } };
    const rows = await sbGet(
      s,
      `sessions?id=eq.${id}&coach_id=eq.${coachId}&select=${SESSION_SELECT}&limit=1`,
    );
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!row) return { status: 404, data: { error: "not found" } };
    return { status: 200, data: { session: row } };
  }

  async function createSession({ coachId, input }) {
    const s = sb();
    if (!s) return { status: 503, data: { error: "api not configured" } };
    const body = pick(input, SESSION_FIELDS);
    if (!body.athlete_id || !UUID_RE.test(String(body.athlete_id))) {
      return { status: 400, data: { error: "athlete_id is required" } };
    }
    if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
      return { status: 400, data: { error: "title is required" } };
    }
    // Tenant lock on the referenced athlete: a foreign athlete_id -> 403.
    if (!(await coachOwnsAthlete(s, coachId, body.athlete_id))) {
      return { status: 403, data: { error: "cross_tenant" } };
    }
    body.coach_id = coachId;
    const rows = await sbPost(s, `sessions?select=${SESSION_SELECT}`, body);
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!row) return { status: 502, data: { error: "create failed" } };
    return { status: 201, data: { session: row } };
  }

  async function updateSession({ coachId, id, input }) {
    const s = sb();
    if (!s) return { status: 503, data: { error: "api not configured" } };
    if (!UUID_RE.test(String(id))) return { status: 400, data: { error: "bad id" } };
    // Ownership pre-check on the session.
    const owned = await sbGet(
      s,
      `sessions?id=eq.${id}&coach_id=eq.${coachId}&select=id&limit=1`,
    );
    if (!Array.isArray(owned) || owned.length === 0) {
      return { status: 404, data: { error: "not found" } };
    }
    const body = pick(input, SESSION_FIELDS);
    // If the caller tries to move the session to another athlete, that athlete
    // must also belong to this coach (never let a session point cross-tenant).
    if (body.athlete_id !== undefined) {
      if (!UUID_RE.test(String(body.athlete_id)) ||
          !(await coachOwnsAthlete(s, coachId, body.athlete_id))) {
        return { status: 403, data: { error: "cross_tenant" } };
      }
    }
    if (Object.keys(body).length === 0) {
      return { status: 400, data: { error: "no updatable fields" } };
    }
    const rows = await sbPatch(
      s,
      `sessions?id=eq.${id}&coach_id=eq.${coachId}&select=${SESSION_SELECT}`,
      body,
    );
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!row) return { status: 404, data: { error: "not found" } };
    return { status: 200, data: { session: row } };
  }

  // ===== slots ==============================================================

  async function listSlots({ coachId, status, limit, offset }) {
    const s = sb();
    if (!s) return { status: 503, data: { error: "api not configured" } };
    const p = parsePaging({ limit, offset });
    let filter = `bookable_slots?coach_id=eq.${coachId}`;
    if (status) {
      const allowed = ["open", "booked", "cancelled", "completed"];
      if (!allowed.includes(String(status))) {
        return { status: 400, data: { error: "bad status filter" } };
      }
      filter += `&status=eq.${status}`;
    }
    const rows = await sbGet(
      s,
      `${filter}&select=${SLOT_SELECT}&order=starts_at.asc${rangeQuery(p.limit, p.offset)}`,
    );
    return { status: 200, data: { slots: rows, limit: p.limit, offset: p.offset } };
  }

  // POST generate — expand the coach's active availability windows into concrete
  // open slots. Tenant-locked reads + inserts scoped to coachId. Reuses the
  // exact pure expandWindows() the scheduling route uses.
  async function generateSlots({ coachId, weeks }) {
    const s = sb();
    if (!s) return { status: 503, data: { error: "api not configured" } };
    let w = Number(weeks);
    if (!Number.isInteger(w) || w < 1 || w > 12) w = 4;

    const windows = await sbGet(
      s,
      `availability_windows?coach_id=eq.${coachId}&active=is.true` +
        `&select=id,coach_id,day_of_week,start_time,end_time,timezone,slot_minutes`,
    );
    if (!Array.isArray(windows) || windows.length === 0) {
      return { status: 200, data: { created: 0, skipped: 0 } };
    }
    const existing = await sbGet(
      s,
      `bookable_slots?coach_id=eq.${coachId}&window_id=not.is.null&select=window_id,starts_at`,
    );
    const { rows, skipped } = expandWindows({
      windows,
      existing,
      weeks: w,
      now: new Date(),
      coachId,
    });
    if (rows.length === 0) return { status: 200, data: { created: 0, skipped } };

    const BATCH = 200;
    let created = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const inserted = await sbPost(s, "bookable_slots", chunk);
      created += Array.isArray(inserted) ? inserted.length : chunk.length;
    }
    return { status: 200, data: { created, skipped } };
  }

  // ===== bookings ===========================================================

  async function listBookings({ coachId, limit, offset }) {
    const s = sb();
    if (!s) return { status: 503, data: { error: "api not configured" } };
    const p = parsePaging({ limit, offset });
    const rows = await sbGet(
      s,
      `bookable_slots?coach_id=eq.${coachId}&status=eq.booked&select=${SLOT_SELECT}` +
        `&order=starts_at.asc${rangeQuery(p.limit, p.offset)}`,
    );
    return { status: 200, data: { bookings: rows, limit: p.limit, offset: p.offset } };
  }

  // POST cancel — the coach cancels a booked slot on their OWN calendar. Mirrors
  // the coachCancelBooking route: tenant read (foreign slot -> 403 cross_tenant),
  // 409 if not booked, flip booked->cancelled, refund-to-source, notify athlete.
  async function cancelBooking({ coachId, slotId }) {
    const s = sb();
    if (!s) return { status: 503, data: { error: "api not configured" } };
    if (!slotId || !UUID_RE.test(String(slotId))) {
      return { status: 400, data: { error: "slot_id must be a uuid" } };
    }
    const owned = await sbGet(
      s,
      `bookable_slots?id=eq.${slotId}&coach_id=eq.${coachId}` +
        `&select=id,coach_id,status,booked_by&limit=1`,
    );
    const slotRow = Array.isArray(owned) && owned[0] ? owned[0] : null;
    if (!slotRow) return { status: 403, data: { error: "cross_tenant" } };
    if (slotRow.status !== "booked") return { status: 409, data: { error: "not_booked" } };
    const athleteId = slotRow.booked_by || null;

    const cancelled = await sbPatch(
      s,
      `bookable_slots?id=eq.${slotId}&coach_id=eq.${coachId}&status=eq.booked`,
      { status: "cancelled", booked_by: null, booked_at: null },
    );
    if (!Array.isArray(cancelled) || cancelled.length === 0) {
      return { status: 409, data: { error: "not_booked" } };
    }
    const slot = cancelled[0];

    let refunded = false;
    let creditsRemaining = null;
    try {
      const r = await refundBookingCredit(s, { slotId, fallbackCoachId: coachId });
      refunded = r.refunded;
    } catch (err) {
      console.error("[api] cancel refund (non-fatal):", err);
    }
    if (refunded && athleteId) {
      creditsRemaining = await creditBalance(s, athleteId).catch(() => null);
    }

    try {
      if (notify && athleteId) {
        await notify({
          userId: athleteId,
          type: "session.cancelled",
          title: "Your session was cancelled",
          body: "Your coach cancelled this session.",
          data: { slotId, coachId },
          dedupeKey: `api-coach-cancel-${slotId}`,
        });
      }
    } catch (err) {
      console.error("[api] cancel notify (non-fatal):", err);
    }

    return { status: 200, data: { slot, refunded, credits_remaining: creditsRemaining } };
  }

  // ===== packages + credits =================================================

  async function listPackages({ coachId }) {
    const s = sb();
    if (!s) return { status: 503, data: { error: "api not configured" } };
    const rows = await sbGet(
      s,
      `packages?coach_id=eq.${coachId}&select=${PACKAGE_SELECT}&order=created_at.desc`,
    );
    return { status: 200, data: { packages: rows } };
  }

  async function listPurchases({ coachId, athleteId, limit, offset }) {
    const s = sb();
    if (!s) return { status: 503, data: { error: "api not configured" } };
    const p = parsePaging({ limit, offset });
    let filter = `package_purchases?coach_id=eq.${coachId}`;
    if (athleteId) {
      if (!UUID_RE.test(String(athleteId))) {
        return { status: 400, data: { error: "bad athlete_id" } };
      }
      filter += `&athlete_id=eq.${athleteId}`;
    }
    const rows = await sbGet(
      s,
      `${filter}&select=${PURCHASE_SELECT}&order=purchased_at.desc${rangeQuery(p.limit, p.offset)}`,
    );
    return { status: 200, data: { purchases: rows, limit: p.limit, offset: p.offset } };
  }

  // Aggregate live credit balances per athlete (active purchases only), tenant-
  // locked. Optional athleteId narrows to one athlete.
  async function getCreditBalances({ coachId, athleteId }) {
    const s = sb();
    if (!s) return { status: 503, data: { error: "api not configured" } };
    let filter = `package_purchases?coach_id=eq.${coachId}&status=eq.active`;
    if (athleteId) {
      if (!UUID_RE.test(String(athleteId))) {
        return { status: 400, data: { error: "bad athlete_id" } };
      }
      filter += `&athlete_id=eq.${athleteId}`;
    }
    const rows = await sbGet(s, `${filter}&select=athlete_id,credits_remaining`);
    const byAthlete = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      const key = r.athlete_id || "unassigned";
      byAthlete.set(key, (byAthlete.get(key) || 0) + (Number(r.credits_remaining) || 0));
    }
    const balances = Array.from(byAthlete.entries()).map(([athlete_id, credits]) => ({
      athlete_id: athlete_id === "unassigned" ? null : athlete_id,
      credits,
    }));
    return { status: 200, data: { balances } };
  }

  // ===== invites ============================================================

  // POST invite — mint a single-use, 14-day booking invite. Mirrors sendInvite's
  // tenant locks: a pre-assigned athlete_id/slot_id must belong to this coach.
  async function createInvite({ coachId, input }) {
    const s = sb();
    if (!s) return { status: 503, data: { error: "api not configured" } };
    const body = input || {};
    const athleteId = body.athlete_id ? String(body.athlete_id) : null;
    const slotId = body.slot_id ? String(body.slot_id) : null;
    const email = typeof body.email === "string" ? body.email.trim() : null;
    if (athleteId && !UUID_RE.test(athleteId)) {
      return { status: 400, data: { error: "athlete_id must be a uuid" } };
    }
    if (slotId && !UUID_RE.test(slotId)) {
      return { status: 400, data: { error: "slot_id must be a uuid" } };
    }
    if (athleteId && !(await coachOwnsAthlete(s, coachId, athleteId))) {
      return { status: 403, data: { error: "cross_tenant" } };
    }
    if (slotId) {
      const ownedSlot = await sbGet(
        s,
        `bookable_slots?id=eq.${slotId}&coach_id=eq.${coachId}&select=id&limit=1`,
      );
      if (!Array.isArray(ownedSlot) || ownedSlot.length === 0) {
        return { status: 403, data: { error: "cross_tenant" } };
      }
    }
    const expiresAt = new Date(Date.now() + 14 * 86400000).toISOString();
    const inserted = await sbPost(s, "booking_invites", {
      coach_id: coachId,
      athlete_id: athleteId,
      slot_id: slotId,
      email,
      status: "pending",
      expires_at: expiresAt,
    });
    const row = Array.isArray(inserted) && inserted[0] ? inserted[0] : null;
    if (!row || !row.token) return { status: 502, data: { error: "could not create invite" } };
    const base = process.env.SCHEDULING_PUBLIC_URL || "https://coachtime.app";
    const url = `${base}/book/${encodeURIComponent(row.token)}`;
    return {
      status: 201,
      data: { token: row.token, url, expires_at: row.expires_at || expiresAt },
    };
  }

  async function listInvites({ coachId, limit, offset }) {
    const s = sb();
    if (!s) return { status: 503, data: { error: "api not configured" } };
    const p = parsePaging({ limit, offset });
    const rows = await sbGet(
      s,
      `booking_invites?coach_id=eq.${coachId}&select=${INVITE_SELECT}` +
        `&order=created_at.desc${rangeQuery(p.limit, p.offset)}`,
    );
    return { status: 200, data: { invites: rows, limit: p.limit, offset: p.offset } };
  }

  return {
    listAthletes,
    getAthlete,
    createAthlete,
    updateAthlete,
    deleteAthlete,
    listSessions,
    getSession,
    createSession,
    updateSession,
    listSlots,
    generateSlots,
    listBookings,
    cancelBooking,
    listPackages,
    listPurchases,
    getCreditBalances,
    createInvite,
    listInvites,
  };
}

// ---- Express layer ---------------------------------------------------------

// Wrap a core call so a thrown Supabase error becomes a clean 502 (never a
// stack-leaking 500). Sends { status, data }.
function send(res, result) {
  res.status(result.status).json(result.data);
}

async function run(res, fn) {
  try {
    const result = await fn();
    return send(res, result);
  } catch (err) {
    console.error("[api] handler error:", err);
    return res.status(502).json({ error: "upstream error" });
  }
}

/**
 * Build the Express handlers for the /api/v1 cluster. Each handler pulls the
 * tenant coachId from req.apiKey (set by the key-auth middleware) — NEVER from
 * the body or query — and delegates to the tenant-locked core.
 */
function buildApiHandlers(deps) {
  const core = buildApiCore(deps);
  const cid = (req) => req.apiKey.coachId;

  return {
    core, // exposed so lib/mcp.js wraps the same tenant-locked functions

    // athletes
    listAthletes: (req, res) =>
      run(res, () => core.listAthletes({ coachId: cid(req), limit: req.query.limit, offset: req.query.offset })),
    getAthlete: (req, res) =>
      run(res, () => core.getAthlete({ coachId: cid(req), id: req.params.id })),
    createAthlete: (req, res) =>
      run(res, () => core.createAthlete({ coachId: cid(req), input: req.body })),
    updateAthlete: (req, res) =>
      run(res, () => core.updateAthlete({ coachId: cid(req), id: req.params.id, input: req.body })),
    deleteAthlete: (req, res) =>
      run(res, () => core.deleteAthlete({ coachId: cid(req), id: req.params.id })),

    // sessions
    listSessions: (req, res) =>
      run(res, () => core.listSessions({ coachId: cid(req), athleteId: req.query.athlete_id, limit: req.query.limit, offset: req.query.offset })),
    getSession: (req, res) =>
      run(res, () => core.getSession({ coachId: cid(req), id: req.params.id })),
    createSession: (req, res) =>
      run(res, () => core.createSession({ coachId: cid(req), input: req.body })),
    updateSession: (req, res) =>
      run(res, () => core.updateSession({ coachId: cid(req), id: req.params.id, input: req.body })),

    // slots
    listSlots: (req, res) =>
      run(res, () => core.listSlots({ coachId: cid(req), status: req.query.status, limit: req.query.limit, offset: req.query.offset })),
    generateSlots: (req, res) =>
      run(res, () => core.generateSlots({ coachId: cid(req), weeks: req.body && req.body.weeks })),

    // bookings
    listBookings: (req, res) =>
      run(res, () => core.listBookings({ coachId: cid(req), limit: req.query.limit, offset: req.query.offset })),
    cancelBooking: (req, res) =>
      run(res, () => core.cancelBooking({ coachId: cid(req), slotId: req.body && req.body.slot_id })),

    // packages + credits
    listPackages: (req, res) =>
      run(res, () => core.listPackages({ coachId: cid(req) })),
    listPurchases: (req, res) =>
      run(res, () => core.listPurchases({ coachId: cid(req), athleteId: req.query.athlete_id, limit: req.query.limit, offset: req.query.offset })),
    getCreditBalances: (req, res) =>
      run(res, () => core.getCreditBalances({ coachId: cid(req), athleteId: req.query.athlete_id })),

    // invites
    createInvite: (req, res) =>
      run(res, () => core.createInvite({ coachId: cid(req), input: req.body })),
    listInvites: (req, res) =>
      run(res, () => core.listInvites({ coachId: cid(req), limit: req.query.limit, offset: req.query.offset })),
  };
}

module.exports = { buildApiCore, buildApiHandlers, parsePaging, pick };
