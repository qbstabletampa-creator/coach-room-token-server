// lib/dashboard.js
//
// Round-2 coach dashboard rollup (dashboard spec, charter #7). The compute-once
// core + the GET /coach/dashboard handler. Behind DASHBOARD_ENABLED in index.js
// (default off), read-rate limited. The app home card set and the future MCP
// tools (get_dashboard, ...) both read THESE functions, so the math lives once.
//
// Contract: coach-room-app/.pmloop/round2-contracts-2026-07-14.md §A + §F.
//
// House style (copied from lib/payments.js / lib/api-rest.js):
//   - local sb() reads Supabase creds at CALL time (not module load).
//   - raw PostgREST over fetch, SERVICE KEY (bypasses RLS).
//   - EVERY query MUST manually filter coach_id; coachId is derived from the
//     verified JWT, NEVER from the query. Minors' PII rides on this.
//   - a "compute-once" pure core ({ coachId, ... } -> data).
//
// Revenue is NOT computed here. It is revenueByRail from lib/payments.js — THE
// single revenue owner (wave-2 decree #1) — called by getDashboard with the
// {from,to} window (current + previous). by_service breakdown is DEFERRED.

const { revenueByRail } = require("./payments");

// Read Supabase creds at CALL time, same as payments.js / scheduling.js.
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

// Service-role GET, same shape as payments.js sbGet. Throws on a real error so a
// genuine outage surfaces as a 500 (the app client softens that to a retry). A
// brand-new coach's reads return [] with 200 — never an error — so the empty
// state is zeros, not a throw.
async function sbGet(s, pathWithQuery) {
  const resp = await fetch(`${s.url}/rest/v1/${pathWithQuery}`, { headers: s.headers });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`supabase GET ${resp.status}: ${detail}`);
  }
  return resp.json().catch(() => []);
}

// Preset Needs-attention windows (days). Used when the coach has no
// coach_dashboard_settings row (0017). The builder reads that table (service key,
// manual coach_id filter) and overrides these when a row exists.
const DEFAULT_WINDOWS = { no_booking_days: 21, expiring_days: 14, stale_credit_days: 30 };

const DAY_MS = 86400000;
const UPCOMING_LIMIT = 12; // rows shown in upcoming / next_open
const ATTENTION_LIMIT = 12; // rows shown in needs_attention

/* ---- range -> explicit {from,to} window (pure, UTC) ------------------------ */
// The contract pins UTC window boundaries (matches revenueByRail / rangeToSince).
// Returns Date objects; getDashboard derives the prior equal-length window from
// these. Unknown/absent range defaults to this_month (the contract default).
function resolveWindow(range, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const r = String(range || "this_month");
  switch (r) {
    case "all":
    case "all_time":
      return { from: new Date(0), to: now };
    case "today":
      return { from: new Date(Date.UTC(y, m, d)), to: now };
    case "last_7_days":
    case "week":
    case "this_week":
      return { from: new Date(now.getTime() - 7 * DAY_MS), to: now };
    case "last_30_days":
      return { from: new Date(now.getTime() - 30 * DAY_MS), to: now };
    case "this_year":
      return { from: new Date(Date.UTC(y, 0, 1)), to: new Date(Date.UTC(y + 1, 0, 1)) };
    case "this_month":
    default:
      return { from: new Date(Date.UTC(y, m, 1)), to: new Date(Date.UTC(y, m + 1, 1)) };
  }
}

// PostgREST in.(a,b,c) list for a set of uuids. Empty set -> null (skip the read).
function inList(ids) {
  const arr = [...new Set(ids.filter(Boolean))];
  if (arr.length === 0) return null;
  return `(${arr.join(",")})`;
}

// Map booked_by (an athlete id, per bookable_slots FK) -> athlete name for a set
// of slot rows. One tenant-scoped read; a missing name reads as null.
async function attachAthleteNames(s, coachId, rows) {
  const list = inList(rows.map((r) => r.booked_by));
  const names = {};
  if (list) {
    const athletes = await sbGet(
      s,
      `athletes?coach_id=eq.${coachId}&id=in.${list}&select=id,name`,
    );
    for (const a of Array.isArray(athletes) ? athletes : []) {
      if (a && a.id) names[a.id] = a.name || null;
    }
  }
  return rows.map((r) => ({
    id: r.id,
    starts_at: r.starts_at || null,
    ends_at: r.ends_at || null,
    timezone: r.timezone || null,
    status: r.status || null,
    booked_by: r.booked_by || null,
    title: r.title || null,
    athlete_name: r.booked_by ? names[r.booked_by] || null : null,
  }));
}

/* ---- compute-once core (pure { coachId, ... } -> data) --------------------- */

/**
 * Upcoming + counts for the bookings card. CoachBooking-shaped rows, soonest first.
 * @param {{ coachId: string, from?: Date, to?: Date, now?: Date }} args
 * @returns {Promise<{ this_week_count: number, completed_this_month: number,
 *   upcoming: Array<object> }>}
 */
async function computeBookings({ coachId, from, to, now = new Date() } = {}) {
  const s = sb();
  if (!s) return { this_week_count: 0, completed_this_month: 0, upcoming: [] };

  const nowIso = now.toISOString();
  const weekEndIso = new Date(now.getTime() + 7 * DAY_MS).toISOString();

  // Upcoming booked slots, soonest first.
  const upcomingRows = await sbGet(
    s,
    `bookable_slots?coach_id=eq.${coachId}&status=eq.booked` +
      `&starts_at=gte.${encodeURIComponent(nowIso)}` +
      `&select=id,starts_at,ends_at,timezone,status,booked_by,title` +
      `&order=starts_at.asc&limit=${UPCOMING_LIMIT}`,
  );
  const upcoming = await attachAthleteNames(
    s,
    coachId,
    (Array.isArray(upcomingRows) ? upcomingRows : []).slice(0, UPCOMING_LIMIT),
  );

  // Booked sessions occurring in the next 7 days (this week).
  const weekRows = await sbGet(
    s,
    `bookable_slots?coach_id=eq.${coachId}&status=eq.booked` +
      `&starts_at=gte.${encodeURIComponent(nowIso)}` +
      `&starts_at=lt.${encodeURIComponent(weekEndIso)}&select=id`,
  );

  // Sessions already delivered within the range window (booked or completed,
  // starts_at in [from, min(to, now))). Represents "completed this month".
  let completed = [];
  if (from) {
    const upper = to && to.getTime() < now.getTime() ? to : now;
    completed = await sbGet(
      s,
      `bookable_slots?coach_id=eq.${coachId}&status=in.(booked,completed)` +
        `&starts_at=gte.${encodeURIComponent(from.toISOString())}` +
        `&starts_at=lt.${encodeURIComponent(upper.toISOString())}&select=id`,
    );
  }

  return {
    this_week_count: Array.isArray(weekRows) ? weekRows.length : 0,
    completed_this_month: Array.isArray(completed) ? completed.length : 0,
    upcoming,
  };
}

/**
 * Open bookable slots for the open-slots card. Same CoachBooking-shaped rows.
 * @param {{ coachId: string, now?: Date }} args
 * @returns {Promise<{ this_week_count: number, next_open: Array<object> }>}
 */
async function computeOpenSlots({ coachId, now = new Date() } = {}) {
  const s = sb();
  if (!s) return { this_week_count: 0, next_open: [] };

  const nowIso = now.toISOString();
  const weekEndIso = new Date(now.getTime() + 7 * DAY_MS).toISOString();

  const openRows = await sbGet(
    s,
    `bookable_slots?coach_id=eq.${coachId}&status=eq.open` +
      `&starts_at=gte.${encodeURIComponent(nowIso)}` +
      `&select=id,starts_at,ends_at,timezone,status,booked_by,title` +
      `&order=starts_at.asc&limit=${UPCOMING_LIMIT}`,
  );
  const rows = (Array.isArray(openRows) ? openRows : []).slice(0, UPCOMING_LIMIT);
  const next_open = rows.map((r) => ({
    id: r.id,
    starts_at: r.starts_at || null,
    ends_at: r.ends_at || null,
    timezone: r.timezone || null,
    status: r.status || "open",
    booked_by: r.booked_by || null,
    title: r.title || null,
    athlete_name: null, // an open slot has no athlete yet
  }));

  const weekRows = await sbGet(
    s,
    `bookable_slots?coach_id=eq.${coachId}&status=eq.open` +
      `&starts_at=gte.${encodeURIComponent(nowIso)}` +
      `&starts_at=lt.${encodeURIComponent(weekEndIso)}&select=id`,
  );

  return {
    this_week_count: Array.isArray(weekRows) ? weekRows.length : 0,
    next_open,
  };
}

/**
 * Athletes about to slip: no upcoming booking, expiring credits, or stale packs.
 * One row per athlete, first matching reason in contract order (no_upcoming ->
 * expiring_credits -> stale_credits). Thresholds from `windows` (coach settings
 * or presets).
 * @param {{ coachId: string, windows?: object, now?: Date }} args
 * @returns {Promise<Array<{ athlete_id, name, reason, detail }>>}
 */
async function computeNeedsAttention({ coachId, windows = DEFAULT_WINDOWS, now = new Date() } = {}) {
  const s = sb();
  if (!s) return [];
  const w = { ...DEFAULT_WINDOWS, ...(windows || {}) };

  const athletes = await sbGet(
    s,
    `athletes?coach_id=eq.${coachId}&select=id,name,created_at&order=created_at.asc`,
  );
  const list = Array.isArray(athletes) ? athletes : [];
  if (list.length === 0) return [];

  // Booked slots (any time) for last-booking + upcoming-per-athlete signals.
  const booked = await sbGet(
    s,
    `bookable_slots?coach_id=eq.${coachId}&status=eq.booked` +
      `&select=booked_by,starts_at`,
  );
  // Active packs with credits left, for expiring + stale-credit signals.
  const purchases = await sbGet(
    s,
    `package_purchases?coach_id=eq.${coachId}&status=eq.active&credits_remaining=gt.0` +
      `&select=id,athlete_id,credits_remaining,expires_at`,
  );
  // Deduct ledger, for the last-used-credit (stale) signal.
  const deducts = await sbGet(
    s,
    `credit_deductions?coach_id=eq.${coachId}&action=eq.deduct` +
      `&select=purchase_id,created_at`,
  );

  const nowMs = now.getTime();

  // Per-athlete: latest upcoming booking + latest past booking.
  const hasUpcoming = new Set();
  const lastBookingMs = {};
  for (const b of Array.isArray(booked) ? booked : []) {
    if (!b || !b.booked_by || !b.starts_at) continue;
    const t = new Date(b.starts_at).getTime();
    if (Number.isNaN(t)) continue;
    if (t >= nowMs) hasUpcoming.add(b.booked_by);
    if (!(b.booked_by in lastBookingMs) || t > lastBookingMs[b.booked_by]) {
      lastBookingMs[b.booked_by] = t;
    }
  }

  // Per-purchase last deduct time (for staleness).
  const lastDeductMs = {};
  for (const d of Array.isArray(deducts) ? deducts : []) {
    if (!d || !d.purchase_id || !d.created_at) continue;
    const t = new Date(d.created_at).getTime();
    if (Number.isNaN(t)) continue;
    if (!(d.purchase_id in lastDeductMs) || t > lastDeductMs[d.purchase_id]) {
      lastDeductMs[d.purchase_id] = t;
    }
  }

  // Per-athlete pack rollup: soonest expiry (with remaining), total remaining,
  // most-recent deduct across their packs.
  const packByAthlete = {};
  for (const p of Array.isArray(purchases) ? purchases : []) {
    if (!p || !p.athlete_id) continue;
    const remaining = Number(p.credits_remaining) || 0;
    if (remaining <= 0) continue;
    const agg = packByAthlete[p.athlete_id] || {
      remaining: 0,
      soonestExpiry: null,
      lastDeduct: null,
    };
    agg.remaining += remaining;
    if (p.expires_at) {
      const e = new Date(p.expires_at).getTime();
      if (!Number.isNaN(e) && (agg.soonestExpiry === null || e < agg.soonestExpiry)) {
        agg.soonestExpiry = e;
      }
    }
    const ld = lastDeductMs[p.id];
    if (ld != null && (agg.lastDeduct === null || ld > agg.lastDeduct)) {
      agg.lastDeduct = ld;
    }
    packByAthlete[p.athlete_id] = agg;
  }

  const out = [];
  for (const a of list) {
    const id = a.id;
    const name = a.name || "Athlete";
    const pack = packByAthlete[id];

    // 1. no_upcoming: no future booked slot AND last activity older than window
    //    (last booking, or created_at when never booked).
    if (!hasUpcoming.has(id)) {
      const lastMs = id in lastBookingMs
        ? lastBookingMs[id]
        : a.created_at
          ? new Date(a.created_at).getTime()
          : null;
      const daysSince =
        lastMs != null && !Number.isNaN(lastMs)
          ? Math.floor((nowMs - lastMs) / DAY_MS)
          : null;
      if (daysSince === null || daysSince >= w.no_booking_days) {
        out.push({
          athlete_id: id,
          name,
          reason: "no_upcoming",
          detail:
            daysSince === null
              ? "No sessions booked yet"
              : id in lastBookingMs
                ? `No session in ${daysSince} days`
                : `Added ${daysSince} days ago, no booking yet`,
        });
        continue;
      }
    }

    // 2. expiring_credits: credits remaining with soonest expiry inside the window.
    if (pack && pack.remaining > 0 && pack.soonestExpiry != null) {
      const daysLeft = Math.ceil((pack.soonestExpiry - nowMs) / DAY_MS);
      if (daysLeft >= 0 && daysLeft <= w.expiring_days) {
        out.push({
          athlete_id: id,
          name,
          reason: "expiring_credits",
          detail:
            daysLeft === 0
              ? `${pack.remaining} credit${pack.remaining === 1 ? "" : "s"} expire today`
              : `${pack.remaining} credit${pack.remaining === 1 ? "" : "s"} expire in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
        });
        continue;
      }
    }

    // 3. stale_credits: credits sitting unused past the stale window.
    if (pack && pack.remaining > 0) {
      const refMs = pack.lastDeduct != null ? pack.lastDeduct : lastBookingMs[id];
      const staleMs = refMs != null ? refMs : a.created_at ? new Date(a.created_at).getTime() : null;
      const idleDays =
        staleMs != null && !Number.isNaN(staleMs)
          ? Math.floor((nowMs - staleMs) / DAY_MS)
          : null;
      if (idleDays !== null && idleDays >= w.stale_credit_days) {
        out.push({
          athlete_id: id,
          name,
          reason: "stale_credits",
          detail: `${pack.remaining} credit${pack.remaining === 1 ? "" : "s"} unused for ${idleDays} days`,
        });
        continue;
      }
    }
  }

  return out.slice(0, ATTENTION_LIMIT);
}

/**
 * Athlete counts grouped by acquisition source (athletes.source, 0016).
 * @param {{ coachId: string }} args
 * @returns {Promise<Array<{ source: string, athlete_count: number }>>}
 */
async function computeSourceAttribution({ coachId } = {}) {
  const s = sb();
  if (!s) return [];
  const rows = await sbGet(
    s,
    `athletes?coach_id=eq.${coachId}&select=source`,
  );
  const counts = {};
  for (const a of Array.isArray(rows) ? rows : []) {
    const src = a && a.source ? String(a.source) : "manual";
    counts[src] = (counts[src] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([source, athlete_count]) => ({ source, athlete_count }))
    .sort((a, b) => b.athlete_count - a.athlete_count || a.source.localeCompare(b.source));
}

// Read the coach's threshold overrides (0017). Absent row / table -> presets.
// Service key + manual coach_id filter (defense in depth, RLS bypassed).
async function readWindows(coachId) {
  const s = sb();
  if (!s) return { ...DEFAULT_WINDOWS };
  try {
    const rows = await sbGet(
      s,
      `coach_dashboard_settings?coach_id=eq.${coachId}` +
        `&select=no_booking_days,expiring_days,stale_credit_days&limit=1`,
    );
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!row) return { ...DEFAULT_WINDOWS };
    return {
      no_booking_days: Number(row.no_booking_days) || DEFAULT_WINDOWS.no_booking_days,
      expiring_days: Number(row.expiring_days) || DEFAULT_WINDOWS.expiring_days,
      stale_credit_days: Number(row.stale_credit_days) || DEFAULT_WINDOWS.stale_credit_days,
    };
  } catch {
    // 0017 unapplied or a read hiccup: presets keep the dashboard working.
    return { ...DEFAULT_WINDOWS };
  }
}

// Signed percent change, one decimal. 0 when previous is 0 (no divide-by-zero) —
// per the contract (§A: "0 when previous is 0"). delta_pct is typed `number`.
function deltaPct(current, previous) {
  if (!previous || previous === 0) return 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/* ---- handler factory ------------------------------------------------------- */

/**
 * Build the dashboard route handler. `deps` injects the shared auth primitive so
 * the route stays testable.
 * @param {object} deps
 * @param {(req)=>Promise<{user?:object,error?:string,status?:number}>} deps.requireSupabaseUser
 */
function buildDashboardHandlers(deps) {
  const { requireSupabaseUser } = deps || {};

  // Derive the coach id from the verified JWT. Returns { coachId } or writes the
  // auth error to res and returns null.
  async function authCoach(req, res) {
    const authd = await requireSupabaseUser(req);
    if (authd.error) {
      res.status(authd.status || 401).json({ error: authd.error });
      return null;
    }
    return { coachId: authd.user.id };
  }

  // GET /coach/dashboard?range=this_month — the whole card set in one payload.
  async function getDashboard(req, res) {
    try {
      if (!sb()) return res.status(503).json({ error: "dashboard not configured" });
      const auth = await authCoach(req, res);
      if (!auth) return;
      const { coachId } = auth;

      const now = new Date();
      const label = String((req.query && req.query.range) || "this_month");
      const { from, to } = resolveWindow(label, now);
      // Prior equal-length window (contract §A: "prior equal-length window").
      const spanMs = to.getTime() - from.getTime();
      const prevFrom = new Date(from.getTime() - spanMs);
      const prevTo = from;

      const windows = await readWindows(coachId);

      const [curRev, prevRev, bookings, openSlots, needs, sources] = await Promise.all([
        revenueByRail({ coachId, from, to }),
        revenueByRail({ coachId, from: prevFrom, to: prevTo }),
        computeBookings({ coachId, from, to, now }),
        computeOpenSlots({ coachId, now }),
        computeNeedsAttention({ coachId, windows, now }),
        computeSourceAttribution({ coachId }),
      ]);

      const current_cents = Number(curRev.total_cents) || 0;
      const previous_cents = Number(prevRev.total_cents) || 0;

      res.json({
        range: { from: from.toISOString(), to: to.toISOString(), label },
        revenue: {
          current_cents,
          previous_cents,
          delta_pct: deltaPct(current_cents, previous_cents),
          by_rail: curRev.by_rail || {},
        },
        bookings,
        open_slots: openSlots,
        needs_attention: needs,
        source_attribution: sources,
      });
    } catch (err) {
      console.error("[dashboard] getDashboard failed:", err);
      res.status(500).json({ error: "could not load dashboard" });
    }
  }

  return { getDashboard };
}

module.exports = {
  buildDashboardHandlers,
  // Compute-once core, exported so the builder + future MCP tools wrap the SAME
  // functions. Signatures frozen by the contract; bodies filled here.
  computeBookings,
  computeOpenSlots,
  computeNeedsAttention,
  computeSourceAttribution,
  resolveWindow,
  deltaPct,
  DEFAULT_WINDOWS,
};
