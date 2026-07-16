// lib/scheduling.js
//
// D12 native scheduling for CoachTime, server-mediated over the token server.
// Everything here is behind the SCHEDULING_ENABLED flag in index.js and is
// purely additive. Ports the qb-stable-app booking model (steal inventory D12):
// availability windows expand into concrete bookable_slots, athletes book onto
// them, a credit is consumed AT BOOKING via the FIFO ledger and refunded on
// cancel. See build-contracts-2026-07-10.md for the wire contract.
//
// North star (CJ): "no filing taxes just to get coached online." The three
// athlete-facing routes are keyed by a booking_invites token, NOT a JWT — the
// invite token IS the athlete's identity, no signup wall. Only /coach/slots/
// generate is coach-authed (a real Supabase JWT).
//
// Atomicity without a SQL transaction: PostgREST applies a filtered PATCH row by
// row (the exact pattern /claim already relies on), so a conditional update is
// the concurrency gate. Booking claims the slot with `status=eq.open` in the
// filter, so two racing bookers cannot both win; the credit decrement uses
// optimistic concurrency on the observed credits_remaining so the same purchase
// is never double-spent.
//
// SCAR (steal inventory): never fake-local time. Every instant is computed as
// real UTC from a wall-clock time + IANA zone via the Intl API (see
// zonedWallClockToUtc), and stored as a timestamptz.

const { buildIcs, buildGoogleCalendarUrl } = require("./ics");
const { sendTransactionalEmail, buildPlainText } = require("./email-shell");
const { mintOrReuseClaim, claimUrl } = require("./claims");

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Where a zero-credit athlete is pointed (PM default: no dead ends). Not a hard
// stop — the app turns this into a "buy a package" screen that calls checkout.
const CHECKOUT_HINT = {
  path: "/checkout/create-session",
  message: "You're out of session credits. Grab a package to book this slot.",
};

// Read Supabase creds at CALL time (not module load), same as notify.js, so a
// test that sets env before requiring index.js still sees them.
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

// ---- timezone math (the anti-fake-local core) ------------------------------

// The offset, in ms, between UTC and wall-clock time in `timeZone` at `date`.
// Positive when the zone is ahead of UTC. Built purely from the Intl API, so it
// is correct across DST transitions and needs no tz database of our own.
function zoneOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour === "24" ? "0" : map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asUTC - date.getTime();
}

// Convert a wall-clock time in `timeZone` to the real UTC instant. Two-pass so a
// DST boundary is resolved: pass 1 estimates the offset, pass 2 re-reads it at
// the estimated instant and corrects. Returns a Date (real UTC).
function zonedWallClockToUtc(y, mo, d, h, mi, timeZone) {
  const naiveUTC = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  const off1 = zoneOffsetMs(new Date(naiveUTC), timeZone);
  let ts = naiveUTC - off1;
  const off2 = zoneOffsetMs(new Date(ts), timeZone);
  if (off2 !== off1) ts = naiveUTC - off2;
  return new Date(ts);
}

// The calendar Y/M/D that `date` falls on in `timeZone` (not the UTC date).
function datePartsInZone(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const map = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  return { y: Number(map.year), mo: Number(map.month), d: Number(map.day) };
}

// Parse a Postgres time value ("17:00:00" / "17:00") into minutes-since-midnight.
function timeToMinutes(t) {
  const [h, m] = String(t).split(":");
  return Number(h) * 60 + Number(m || 0);
}

// ---- slot generation (pure, unit-testable) ---------------------------------

// Expand active availability windows into concrete bookable_slots rows for the
// next `weeks` weeks. Pure: no I/O. `existing` is the set of already-present
// (window_id, starts_at) rows, matched by epoch ms so a re-run inserts nothing
// (idempotent). Future-only: a slot whose start is <= now is skipped.
//
// Returns { rows, skipped } where rows are ready-to-insert objects.
function expandWindows({ windows, existing = [], weeks = 4, now = new Date(), coachId }) {
  const existingKeys = new Set(
    (existing || [])
      .filter((r) => r && r.window_id && r.starts_at)
      .map((r) => `${r.window_id}|${new Date(r.starts_at).getTime()}`),
  );
  const rows = [];
  let skipped = 0;
  const nowMs = now.getTime();
  const horizonDays = weeks * 7;

  for (const w of windows || []) {
    const tz = w.timezone;
    const slotMin = Number(w.slot_minutes) || 60;
    const startMin = timeToMinutes(w.start_time);
    const endMin = timeToMinutes(w.end_time);
    if (!(endMin > startMin) || slotMin <= 0) continue;

    // Anchor on "today" in the window's zone, then walk calendar days forward.
    const today = datePartsInZone(now, tz);
    const base = Date.UTC(today.y, today.mo - 1, today.d);

    for (let i = 0; i < horizonDays; i++) {
      const cursor = new Date(base + i * 86400000);
      if (cursor.getUTCDay() !== Number(w.day_of_week)) continue;
      const y = cursor.getUTCFullYear();
      const mo = cursor.getUTCMonth() + 1;
      const d = cursor.getUTCDate();

      for (let s = startMin; s + slotMin <= endMin; s += slotMin) {
        const startsAt = zonedWallClockToUtc(y, mo, d, Math.floor(s / 60), s % 60, tz);
        if (startsAt.getTime() <= nowMs) continue; // future only
        const e = s + slotMin;
        const endsAt = zonedWallClockToUtc(y, mo, d, Math.floor(e / 60), e % 60, tz);

        const key = `${w.id}|${startsAt.getTime()}`;
        if (existingKeys.has(key)) {
          skipped++;
          continue;
        }
        existingKeys.add(key); // dedupe within this run too
        rows.push({
          coach_id: coachId || w.coach_id,
          starts_at: startsAt.toISOString(),
          ends_at: endsAt.toISOString(),
          timezone: tz,
          status: "open",
          source: "availability",
          window_id: w.id,
        });
      }
    }
  }
  return { rows, skipped };
}

// ---- Supabase REST helpers (service role) ----------------------------------

async function sbGet(s, pathWithQuery) {
  const resp = await fetch(`${s.url}/rest/v1/${pathWithQuery}`, { headers: s.headers });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`supabase GET ${resp.status}: ${detail}`);
  }
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

// Load an invite by token, with coach + athlete display names joined.
async function lookupInvite(s, token) {
  const rows = await sbGet(
    s,
    `booking_invites?token=eq.${token}` +
      `&select=token,coach_id,athlete_id,slot_id,email,status,expires_at,` +
      `coaches:coach_id(full_name),athletes:athlete_id(name,parent_email,user_id)&limit=1`,
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// An invite is usable when it exists, is not expired, and (unless we allow an
// already-accepted invite for the cancel path) has not been consumed yet.
function inviteUsable(invite, { allowAccepted = false } = {}) {
  if (!invite) return false;
  if (new Date(invite.expires_at).getTime() <= Date.now()) return false;
  if (invite.status === "pending") return true;
  if (allowAccepted && invite.status === "accepted") return true;
  return false;
}

// Storefront (0013): validate a requested session_type_id against the coach's
// OWN active types. A missing row is different from a failed read: callers reject
// the former as an unknown type and apply their feature-specific outage posture
// to the latter.
async function resolveSessionType(s, { coachId, sessionTypeId }) {
  if (!sessionTypeId || !UUID_RE.test(String(sessionTypeId))) return null;
  const rows = await sbGet(
    s,
    `session_types?id=eq.${sessionTypeId}&coach_id=eq.${coachId}` +
      `&active=is.true&select=id&limit=1`,
  );
  return Array.isArray(rows) && rows[0] && String(rows[0].id) === String(sessionTypeId)
    ? rows[0].id
    : null;
}

// Resolve only when protection or payments needs policy/pricing information.
// Every supplied type is validated even when the slot is pre-typed; slot truth
// still wins after that validation. The public guest lane requires a choice when
// an untyped slot belongs to a coach who has an active menu.
async function resolveBookingSessionType(
  s,
  {
    coachId,
    slotId,
    requestedTypeId,
    requestedTypeValidated = false,
    requireTypeWhenUntyped = false,
  },
) {
  let validatedRequestedTypeId = null;
  if (requestedTypeId) {
    validatedRequestedTypeId = requestedTypeValidated
      ? requestedTypeId
      : await resolveSessionType(s, {
        coachId,
        sessionTypeId: requestedTypeId,
      });
    if (!validatedRequestedTypeId) {
      return { sessionTypeId: null, error: "unknown session type" };
    }
  }
  const rows = await sbGet(
    s,
    `bookable_slots?id=eq.${slotId}&coach_id=eq.${coachId}` +
      `&select=id,session_type_id&limit=1`,
  );
  const slot = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (slot?.session_type_id) return { sessionTypeId: slot.session_type_id, error: null };
  if (validatedRequestedTypeId) {
    return { sessionTypeId: validatedRequestedTypeId, error: null };
  }
  if (requireTypeWhenUntyped) {
    const active = await sbGet(
      s,
      `session_types?coach_id=eq.${coachId}&active=is.true&select=id&limit=1`,
    );
    if (Array.isArray(active) && active[0]) {
      return { sessionTypeId: null, error: "session type required" };
    }
  }
  return { sessionTypeId: null, error: null };
}

async function runFailSoft(tag, fn) {
  try {
    return await Promise.resolve().then(fn);
  } catch (err) {
    console.error(`[scheduling:hook:${tag}] failed (non-fatal):`, err);
    return null;
  }
}

// Sum a purchaser's live credit balance (active purchases only).
async function creditBalance(s, athleteId) {
  const rows = await sbGet(
    s,
    `package_purchases?athlete_id=eq.${athleteId}&status=eq.active&select=credits_remaining`,
  );
  return (Array.isArray(rows) ? rows : []).reduce(
    (sum, r) => sum + (Number(r.credits_remaining) || 0),
    0,
  );
}

// FIFO-deduct exactly one credit from the oldest active purchase that has any.
// Optimistic concurrency: the decrement PATCH filters on the observed
// credits_remaining, so a racing booking that already decremented this purchase
// loses and we advance to the next. Appends the immutable ledger row on success.
// Returns { purchaseId } or null when no credit could be taken.
async function fifoDeductOne(s, { athleteId, coachId, slotId }) {
  const purchases = await sbGet(
    s,
    `package_purchases?athlete_id=eq.${athleteId}&status=eq.active` +
      `&credits_remaining=gt.0&order=purchased_at.asc` +
      `&select=id,credits_remaining,coach_id`,
  );
  for (const p of Array.isArray(purchases) ? purchases : []) {
    const observed = Number(p.credits_remaining);
    if (!(observed > 0)) continue;
    const next = observed - 1;
    const updated = await sbPatch(
      s,
      `package_purchases?id=eq.${p.id}&credits_remaining=eq.${observed}&status=eq.active`,
      {
        credits_remaining: next,
        status: next === 0 ? "exhausted" : "active",
      },
    );
    if (Array.isArray(updated) && updated.length === 1) {
      // Won the row. Append the ledger deduct (append-only, immutable).
      await sbPost(
        s,
        "credit_deductions",
        {
          coach_id: coachId || p.coach_id,
          purchase_id: p.id,
          slot_id: slotId || null,
          action: "deduct",
          amount: 1,
          reason: "booking",
        },
        { representation: false },
      );
      return { purchaseId: p.id };
    }
    // Lost the optimistic race on this purchase; try the next one.
  }
  return null;
}

// Refund the credit for a cancelled slot back to its ORIGINATING purchase, the
// invite-cancel semantics extracted so the coach-cancel path reuses them
// verbatim. Finds the deduct ledger row for the slot, bumps the source
// purchase's credits_remaining (capped at credits_total), reactivates a pack
// that this booking had exhausted, and appends an immutable action='refund'
// ledger row. Returns { refunded, purchaseId }: refunded=false (nothing
// appended) when there was no deduct to reverse (e.g. a zero-credit legacy
// booking, or a missing purchase). `fallbackCoachId` names the coach on the
// refund ledger row when the deduct row didn't carry one.
async function refundBookingCredit(s, { slotId, fallbackCoachId }) {
  const ded = await sbGet(
    s,
    `credit_deductions?slot_id=eq.${slotId}&action=eq.deduct` +
      `&order=created_at.desc&limit=1&select=purchase_id,coach_id`,
  );
  const deductRow = Array.isArray(ded) && ded[0] ? ded[0] : null;
  if (!deductRow || !deductRow.purchase_id) return { refunded: false, purchaseId: null };

  const purchases = await sbGet(
    s,
    `package_purchases?id=eq.${deductRow.purchase_id}` +
      `&select=id,credits_remaining,credits_total,status&limit=1`,
  );
  const purchase = Array.isArray(purchases) && purchases[0] ? purchases[0] : null;
  if (!purchase) return { refunded: false, purchaseId: null };

  const bumped = Math.min(
    Number(purchase.credits_remaining) + 1,
    Number(purchase.credits_total),
  );
  await sbPatch(
    s,
    `package_purchases?id=eq.${purchase.id}`,
    {
      credits_remaining: bumped,
      // Reactivate a pack that had been exhausted by this booking.
      status: purchase.status === "exhausted" ? "active" : purchase.status,
    },
    { representation: false },
  );
  await sbPost(
    s,
    "credit_deductions",
    {
      coach_id: deductRow.coach_id || fallbackCoachId,
      purchase_id: purchase.id,
      slot_id: slotId,
      action: "refund",
      amount: 1,
      reason: "cancellation",
    },
    { representation: false },
  );
  return { refunded: true, purchaseId: purchase.id };
}

// ---- handler factory -------------------------------------------------------

/**
 * Build the scheduling route handlers. `deps` injects the shared primitives so
 * the routes stay testable (tests mock global.fetch + pass a stub notify).
 *
 * @param {object} deps
 * @param {(req)=>Promise<{user?:object,error?:string,status?:number}>} deps.requireSupabaseUser
 * @param {(args:object)=>Promise<void>} deps.notify  the notify() chokepoint.
 * @param {()=>string} [deps.getBookBaseUrl]  base for the booking/join link.
 */
function buildSchedulingHandlers(deps) {
  const {
    requireSupabaseUser,
    notify,
    bookingGate = null,
    cancellationFee = null,
    calendarMirror = null,
    formsPendingWaiver = null,
    waitlistFill = null,
    getBookBaseUrl = () =>
      process.env.SCHEDULING_PUBLIC_URL || "https://coachtime.app",
  } = deps || {};

  async function notifyCoachLowCredit({ coachId, athleteId, remaining, purchaseId }) {
    if (!notify) return;
    const rows = await sbGet(
      sb(),
      `coaches?id=eq.${coachId}` +
        `&select=low_balance_notify,low_balance_threshold&limit=1`,
    );
    const settings = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!settings || settings.low_balance_notify !== true) return;
    const threshold = Number(settings.low_balance_threshold);
    if (!Number.isFinite(threshold) || threshold < 0 || remaining > threshold) return;
    await notify({
      userId: coachId,
      type: "credits.low_balance",
      title: "An athlete is running low on credits",
      body: `${remaining} session credit${remaining === 1 ? "" : "s"} remaining.`,
      data: { athleteId, remaining, purchaseId },
      dedupeKey: `low-balance:${athleteId}:${purchaseId}:${remaining}`,
    });
  }

  // GET /schedule/:inviteToken — coach name + open future slots + credit balance.
  async function getSchedule(req, res) {
    try {
      const s = sb();
      if (!s) return res.status(503).json({ error: "scheduling not configured" });
      const token = req.params.inviteToken || "";
      if (!UUID_RE.test(token)) return res.status(400).json({ error: "bad invite token" });

      const invite = await lookupInvite(s, token);
      if (!inviteUsable(invite)) {
        return res.status(404).json({ error: "invite not found or expired" });
      }

      const nowIso = new Date().toISOString();
      const slots = await sbGet(
        s,
        `bookable_slots?coach_id=eq.${invite.coach_id}&status=eq.open` +
          `&starts_at=gt.${encodeURIComponent(nowIso)}` +
          `&select=id,starts_at,ends_at,timezone,title&order=starts_at.asc`,
      );

      // Storefront (0013): the coach's active session types feed the invite-lane
      // type picker (book.html). Empty array => book.html skips the type step and
      // the flow is identical to before storefront. Sorted by the coach's order.
      const sessionTypes = await sbGet(
        s,
        `session_types?coach_id=eq.${invite.coach_id}&active=is.true` +
          `&select=id,name,duration_min,price_cents,description&order=sort.asc,created_at.asc`,
      );

      const packages = await sbGet(
        s,
        `packages?coach_id=eq.${invite.coach_id}&active=is.true` +
          `&select=id,name,description,price_cents,credits,billing_type,billing_interval,installment_count` +
          `&order=created_at.asc`,
      );

      let credits = 0;
      if (invite.athlete_id) credits = await creditBalance(s, invite.athlete_id);

      // Package-balance (0015, contract §C): the coach's balance-visibility flags
      // drive book.html's low-balance banner + rebuy line. Additive + fail-soft:
      // if 0015 is unapplied (columns absent, PostgREST 400) or the read errors,
      // default to athlete_sees_balance=true / low_balance_threshold=2 so the
      // picker NEVER breaks (an old cached book.html that ignores the fields also
      // keeps working). Scoped to the invite's OWN coach — already tenant-safe.
      let athleteSeesBalance = true;
      let lowBalanceThreshold = 2;
      try {
        const coachRows = await sbGet(
          s,
          `coaches?id=eq.${invite.coach_id}` +
            `&select=athlete_sees_balance,low_balance_threshold&limit=1`,
        );
        const coachRow = Array.isArray(coachRows) && coachRows[0] ? coachRows[0] : null;
        if (coachRow) {
          if (typeof coachRow.athlete_sees_balance === "boolean") {
            athleteSeesBalance = coachRow.athlete_sees_balance;
          }
          const t = Number(coachRow.low_balance_threshold);
          if (Number.isFinite(t) && t >= 0) lowBalanceThreshold = t;
        }
      } catch (err) {
        console.error(
          "[scheduling] balance flags read (non-fatal, defaults applied):",
          err,
        );
      }

      res.json({
        coachName: invite.coaches?.full_name || "Your coach",
        athleteId: invite.athlete_id || null,
        credits,
        athlete_sees_balance: athleteSeesBalance,
        low_balance_threshold: lowBalanceThreshold,
        slots: Array.isArray(slots) ? slots : [],
        session_types: Array.isArray(sessionTypes) ? sessionTypes : [],
        packages: Array.isArray(packages) ? packages : [],
      });
    } catch (err) {
      console.error("[scheduling] getSchedule failed:", err);
      res.status(500).json({ error: "could not load schedule" });
    }
  }

  // POST /schedule/:inviteToken/book { slotId }
  async function bookSlot(req, res) {
    try {
      const s = sb();
      if (!s) return res.status(503).json({ error: "scheduling not configured" });
      const token = req.params.inviteToken || "";
      if (!UUID_RE.test(token)) return res.status(400).json({ error: "bad invite token" });
      const slotId = req.body && req.body.slotId;
      if (!slotId || !UUID_RE.test(String(slotId))) {
        return res.status(400).json({ error: "slotId is required" });
      }
      // Storefront (0013): optional session type the athlete picked. Stored on the
      // slot; validated against the coach's own types below so a stray/cross-tenant
      // id is never written. Absent => null, flow identical to before storefront.
      const body = req.body || {};
      const requestedTypeSupplied =
        Object.prototype.hasOwnProperty.call(body, "session_type_id") &&
        body.session_type_id !== undefined &&
        body.session_type_id !== null;
      const requestedTypeId = requestedTypeSupplied ? String(body.session_type_id) : null;
      const legacyRequestedTypeId = body.session_type_id ? String(body.session_type_id) : null;

      const invite = await lookupInvite(s, token);
      if (!inviteUsable(invite)) {
        return res.status(404).json({ error: "invite not found or expired" });
      }
      const athleteId = invite.athlete_id;
      if (!athleteId) {
        // Booking pins booked_by + a film session (athlete_id NOT NULL), so the
        // invite must name an athlete. A generic invite can't be booked yet.
        return res.status(400).json({ error: "invite is not assigned to an athlete" });
      }

      // A supplied type retains master's validation/persistence behavior when
      // protection is off. When protection is on, supplied garbage is never
      // treated as absent and an ownership-read outage fails closed.
      let sessionTypeId = null;
      if (bookingGate) {
        if (requestedTypeSupplied && !UUID_RE.test(requestedTypeId)) {
          return res.status(400).json({ error: "unknown_session_type" });
        }
        if (requestedTypeSupplied) {
          try {
            sessionTypeId = await resolveSessionType(s, {
              coachId: invite.coach_id,
              sessionTypeId: requestedTypeId,
            });
          } catch (err) {
            console.error("[scheduling:booking-gate] type ownership read failed (blocking):", err);
            return res.status(503).json({ error: "session_type_unavailable" });
          }
          if (!sessionTypeId) {
            return res.status(400).json({ error: "unknown_session_type" });
          }
        }
      } else if (legacyRequestedTypeId) {
        sessionTypeId = await resolveSessionType(s, {
          coachId: invite.coach_id,
          sessionTypeId: legacyRequestedTypeId,
        });
        if (!sessionTypeId) {
          return res.status(400).json({ error: "unknown session type" });
        }
      }

      // ---- Credit precheck: no credit -> route to checkout, touch nothing ----
      const balance = await creditBalance(s, athleteId);
      if (balance <= 0) {
        return res
          .status(402)
          .json({ error: "no_credits", checkoutHint: CHECKOUT_HINT });
      }

      // Protection is the only invite-lane hook that needs type/policy data.
      // With it off, preserve the legacy path: no type lookup and no new error.
      if (bookingGate) {
        try {
          const resolvedType = await resolveBookingSessionType(s, {
            coachId: invite.coach_id,
            slotId,
            requestedTypeId: sessionTypeId,
            requestedTypeValidated: true,
          });
          if (resolvedType.error) {
            return res.status(400).json({ error: resolvedType.error });
          }
          sessionTypeId = resolvedType.sessionTypeId;
        } catch (err) {
          console.error("[scheduling:booking-gate] type/policy read failed (non-fatal):", err);
        }
      }

      // ---- PRE-CLAIM, BLOCKING: protection card/approval gate ---------------
      if (bookingGate) {
        let gate = null;
        try {
          gate = await bookingGate({
            coachId: invite.coach_id,
            athleteId,
            slotId,
            sessionTypeId,
            setupContext: {
              email: invite.athletes?.parent_email || invite.email || null,
              returnPath: `/book/${token}`,
            },
          });
        } catch (err) {
          console.error("[scheduling:booking-gate] policy read failed (non-fatal):", err);
        }
        if (gate?.status === "card_setup_unavailable") {
          return res.status(503).json({ error: "card_setup_unavailable" });
        }
        if (gate && gate.allowed === false) {
          return res.status(402).json({ error: "needs_card", setup_url: gate.setup_url });
        }
        if (gate && Object.prototype.hasOwnProperty.call(gate, "sessionTypeId")) {
          sessionTypeId = gate.sessionTypeId;
        }
      }

      // ---- Gate: atomically claim the slot (open -> booked) ------------------
      // The `status=eq.open` filter is the concurrency gate: exactly one racing
      // booker flips it; the rest match 0 rows and get 409.
      const claimed = await sbPatch(
        s,
        `bookable_slots?id=eq.${slotId}&coach_id=eq.${invite.coach_id}&status=eq.open`,
        {
          status: "booked",
          booked_by: athleteId,
          booked_at: new Date().toISOString(),
          session_type_id: sessionTypeId,
        },
      );
      if (!Array.isArray(claimed) || claimed.length === 0) {
        return res.status(409).json({ error: "slot_unavailable" });
      }
      const slot = claimed[0];

      // ---- Deduct one credit (FIFO). Roll the slot back if it fails ----------
      const deduct = await fifoDeductOne(s, {
        athleteId,
        coachId: invite.coach_id,
        slotId,
      });
      if (!deduct) {
        // Extremely rare (balance vanished between precheck and here). Undo the
        // claim so we never leave a booked slot with no credit taken.
        await sbPatch(
          s,
          `bookable_slots?id=eq.${slotId}`,
          { status: "open", booked_by: null, booked_at: null },
          { representation: false },
        ).catch(() => {});
        return res
          .status(402)
          .json({ error: "no_credits", checkoutHint: CHECKOUT_HINT });
      }

      const remaining = await creditBalance(s, athleteId).catch(() => balance - 1);

      // ---- POST-CLAIM hooks: ordered and independently fail-soft ------------
      await runFailSoft("low-credit", () => notifyCoachLowCredit({
        coachId: invite.coach_id,
        athleteId,
        remaining,
        purchaseId: deduct.purchaseId,
      }));

      // HOOK:CALENDAR_MIRROR (calendar-sync factory, 0018 — wired here)
      if (calendarMirror) {
        await runFailSoft("calendar-mirror", () =>
          calendarMirror({ coachId: invite.coach_id, athleteId, slot }));
      }

      // HOOK:FORMS_PENDING_WAIVER (forms factory, 0030 — wired here)
      if (formsPendingWaiver) {
        await runFailSoft("forms-pending-waiver", () =>
          formsPendingWaiver({ coachId: invite.coach_id, athleteId, slot }));
      }

      // ---- Create the linked film session, wire it onto the slot ------------
      let sessionId = null;
      try {
        const created = await sbPost(s, "sessions", {
          coach_id: invite.coach_id,
          athlete_id: athleteId,
          title: slot.title || "Live coaching session",
          status: "planned",
        });
        sessionId = Array.isArray(created) && created[0] ? created[0].id : null;
        if (sessionId) {
          await sbPatch(
            s,
            `bookable_slots?id=eq.${slotId}`,
            { session_id: sessionId },
            { representation: false },
          );
        }
      } catch (err) {
        // A missing session row shouldn't unwind a paid booking; log + proceed.
        console.error("[scheduling] session create (non-fatal):", err);
      }

      // ---- Mark the invite accepted (single-use) ----------------------------
      await sbPatch(
        s,
        `booking_invites?token=eq.${token}&status=eq.pending`,
        {
          status: "accepted",
          accepted_at: new Date().toISOString(),
        },
        { representation: false },
      ).catch((err) => console.error("[scheduling] invite accept (non-fatal):", err));

      // ---- D19 progressive account: offer a claim when the athlete is unclaimed
      // The account IS the existing /claim flow. When athletes.user_id is null the
      // booked athlete has no account yet; reuse an unexpired unclaimed claim or
      // mint one, and surface the link in the confirmation email + the JSON
      // response so book.html can show a low-key "get your portal" button. A
      // CLAIMED athlete (user_id set) gets no claim URL anywhere — nothing changes.
      // Fail-soft: a claim hiccup never unwinds the paid booking (claim_url stays
      // null and the booking still succeeds).
      let claimUrlOut = null;
      if (invite.athletes && invite.athletes.user_id == null) {
        const claimToken = await mintOrReuseClaim(s, {
          coachId: invite.coach_id,
          athleteId,
        }).catch(() => null);
        if (claimToken) claimUrlOut = claimUrl(getBookBaseUrl(), claimToken);
      }

      // ---- Notify the coach + email the athlete a .ics + Google link --------
      await runFailSoft("booking-notify", () => fireBookingNotifications({
        notify,
        getBookBaseUrl,
        invite,
        slot,
        claimUrl: claimUrlOut,
      }));

      res.json({
        slot,
        session_id: sessionId,
        credits_remaining: remaining,
        claim_url: claimUrlOut,
      });
    } catch (err) {
      console.error("[scheduling] bookSlot failed:", err);
      res.status(500).json({ error: "booking failed" });
    }
  }

  // POST /schedule/:inviteToken/cancel { slotId }
  async function cancelBooking(req, res) {
    try {
      const s = sb();
      if (!s) return res.status(503).json({ error: "scheduling not configured" });
      const token = req.params.inviteToken || "";
      if (!UUID_RE.test(token)) return res.status(400).json({ error: "bad invite token" });
      const slotId = req.body && req.body.slotId;
      if (!slotId || !UUID_RE.test(String(slotId))) {
        return res.status(400).json({ error: "slotId is required" });
      }

      const invite = await lookupInvite(s, token);
      // Cancel tolerates an already-accepted invite (the athlete booked with it).
      if (!inviteUsable(invite, { allowAccepted: true })) {
        return res.status(404).json({ error: "invite not found or expired" });
      }
      const athleteId = invite.athlete_id;
      if (!athleteId) return res.status(400).json({ error: "invite is not assigned to an athlete" });

      // ---- Gate: reopen the slot only if THIS athlete booked it -------------
      // Explicit status='open' — the orphan-cancel trigger respects a deliberate
      // reopen and does not override it (migration 0010 note).
      const reopened = await sbPatch(
        s,
        `bookable_slots?id=eq.${slotId}&booked_by=eq.${athleteId}&status=eq.booked`,
        { status: "open", booked_by: null, booked_at: null },
      );
      if (!Array.isArray(reopened) || reopened.length === 0) {
        return res.status(409).json({ error: "not_booked_by_you" });
      }
      const slot = reopened[0];

      // ---- Refund the credit to the originating purchase --------------------
      // Shared refund-to-source primitive (also used by coachCancelBooking).
      try {
        await refundBookingCredit(s, { slotId, fallbackCoachId: invite.coach_id });
      } catch (err) {
        console.error("[scheduling] refund (non-fatal):", err);
      }

      // Fee assessment must complete (or fail soft) before a future fill hook.
      if (cancellationFee) {
        await runFailSoft("late-cancel-fee", () => cancellationFee({
          coachId: invite.coach_id,
          athleteId,
          slotId,
          kind: "late_cancel_fee",
          coachInitiated: false,
        }));
      }
      // HOOK:WAITLIST_FILL (waitlist factory, 0026 — fee must be assessed before fill)
      if (waitlistFill) {
        await runFailSoft("waitlist-fill", () => waitlistFill({ coachId: invite.coach_id, slot }));
      }

      // ---- Notify the coach --------------------------------------------------
      try {
        if (notify) {
          await notify({
            userId: invite.coach_id,
            type: "session.cancelled",
            title: "A session was cancelled",
            body: `${invite.athletes?.name || "An athlete"} cancelled their booking.`,
            data: { slotId, athleteId },
            dedupeKey: `cancel-${slotId}`,
          });
        }
      } catch (err) {
        console.error("[scheduling] cancel notify (non-fatal):", err);
      }

      const remaining = await creditBalance(s, athleteId).catch(() => null);
      res.json({ slot, credits_remaining: remaining });
    } catch (err) {
      console.error("[scheduling] cancelBooking failed:", err);
      res.status(500).json({ error: "cancel failed" });
    }
  }

  // POST /coach/slots/generate { weeks? } — coach JWT. Expand availability
  // windows into concrete open slots for the next N weeks, skipping duplicates.
  async function generateSlots(req, res) {
    try {
      const s = sb();
      if (!s) return res.status(503).json({ error: "scheduling not configured" });

      const authd = await requireSupabaseUser(req);
      if (authd.error) return res.status(authd.status || 401).json({ error: authd.error });
      const coachId = authd.user.id;

      let weeks = Number(req.body && req.body.weeks);
      if (!Number.isInteger(weeks) || weeks < 1 || weeks > 12) weeks = 4;

      const windows = await sbGet(
        s,
        `availability_windows?coach_id=eq.${coachId}&active=is.true` +
          `&select=id,coach_id,day_of_week,start_time,end_time,timezone,slot_minutes`,
      );
      if (!Array.isArray(windows) || windows.length === 0) {
        return res.json({ created: 0, skipped: 0 });
      }

      // Existing generated slots for these windows, so a re-run is idempotent.
      const existing = await sbGet(
        s,
        `bookable_slots?coach_id=eq.${coachId}&window_id=not.is.null` +
          `&select=window_id,starts_at`,
      );

      const { rows, skipped } = expandWindows({
        windows,
        existing,
        weeks,
        now: new Date(),
        coachId,
      });

      if (rows.length === 0) return res.json({ created: 0, skipped });

      // Insert in batches to stay well under any payload cap.
      const BATCH = 200;
      let created = 0;
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const inserted = await sbPost(s, "bookable_slots", chunk);
        created += Array.isArray(inserted) ? inserted.length : chunk.length;
      }
      res.json({ created, skipped });
    } catch (err) {
      console.error("[scheduling] generateSlots failed:", err);
      res.status(500).json({ error: "slot generation failed" });
    }
  }

  // POST /send-invite { athlete_id?, slot_id?, email?, channel? } — coach JWT.
  // Mint a single-use, 14-day booking invite the coach shares with an athlete.
  // v1 is mint-and-return: the app hands the link to the native share sheet (no
  // SMS lane yet). Returns the token plus the athlete booking-page URL built by
  // the SAME base as fireBookingNotifications, so the link lands on book.html.
  async function sendInvite(req, res) {
    try {
      const s = sb();
      if (!s) return res.status(503).json({ error: "scheduling not configured" });

      // Coach-authed: verify the Supabase JWT (same as generateSlots) then derive
      // the caller's role the way /token does (user_metadata/app_metadata). Only a
      // coach mints invites; an athlete-role caller is rejected.
      const authd = await requireSupabaseUser(req);
      if (authd.error) return res.status(authd.status || 401).json({ error: authd.error });
      const user = authd.user;
      const role =
        user.user_metadata?.role === "coach" || user.app_metadata?.role === "coach"
          ? "coach"
          : "athlete";
      if (role !== "coach") return res.status(403).json({ error: "coach access required" });
      const coachId = user.id;

      const body = req.body || {};
      const athleteId = body.athlete_id ? String(body.athlete_id) : null;
      const slotId = body.slot_id ? String(body.slot_id) : null;
      const email = typeof body.email === "string" ? body.email.trim() : null;
      if (athleteId && !UUID_RE.test(athleteId)) {
        return res.status(400).json({ error: "athlete_id must be a uuid" });
      }
      if (slotId && !UUID_RE.test(slotId)) {
        return res.status(400).json({ error: "slot_id must be a uuid" });
      }

      // Tenant lock: a coach may only pre-assign an invite to THEIR own athlete.
      if (athleteId) {
        const owned = await sbGet(
          s,
          `athletes?id=eq.${athleteId}&coach_id=eq.${coachId}&select=id&limit=1`,
        );
        if (!Array.isArray(owned) || owned.length === 0) {
          return res.status(403).json({ error: "athlete is not in your roster" });
        }
      }

      // Tenant lock: a coach may only pre-assign an invite to THEIR own slot.
      if (slotId) {
        const ownedSlot = await sbGet(
          s,
          `bookable_slots?id=eq.${slotId}&coach_id=eq.${coachId}&select=id&limit=1`,
        );
        if (!Array.isArray(ownedSlot) || ownedSlot.length === 0) {
          return res.status(403).json({ error: "cross_tenant" });
        }
      }

      // Single-use, 14-day expiry (mirrors athlete_claims). The DB generates the
      // token (gen_random_uuid); we read it back from the representation.
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
      if (!row || !row.token) {
        console.error("[scheduling] sendInvite: insert returned no token");
        return res.status(500).json({ error: "could not create invite" });
      }
      const token = row.token;
      const url = `${getBookBaseUrl()}/book/${encodeURIComponent(token)}`;

      // Optional email channel: send the link when the coach asks for it. Never
      // throws (same posture as the booking emails). channel==='sms' is a no-op in
      // v1 (dark lane); the app shares the link via the native share sheet.
      if (body.channel === "email" && email) {
        await sendInviteEmail({ email, url }).catch((err) =>
          console.error("[scheduling] invite email (non-fatal):", err),
        );
      }

      res.status(201).json({ token, url, expires_at: row.expires_at || expiresAt });
    } catch (err) {
      console.error("[scheduling] sendInvite failed:", err);
      res.status(500).json({ error: "could not create invite" });
    }
  }

  // POST /coach/bookings/cancel { slot_id } — coach JWT. The coach cancels a
  // booked slot on their OWN calendar. Auth + tenant checks mirror sendInvite
  // (coach role required, the slot must belong to the caller). Reuses the shared
  // refundBookingCredit primitive so the refund follows the SAME invite-cancel
  // semantics: refund-to-source purchase, action='refund' ledger append,
  // exhausted pack reactivated. Chose the shared-helper extraction over a
  // parallel copy because the refund block is self-contained (depends only on
  // s, slotId, fallbackCoachId) and the existing invite-cancel tests pin its
  // exact Supabase calls, so a single implementation keeps both paths honest.
  async function coachCancelBooking(req, res) {
    try {
      const s = sb();
      if (!s) return res.status(503).json({ error: "scheduling not configured" });

      // Coach-authed: verify the JWT then derive role exactly like sendInvite.
      const authd = await requireSupabaseUser(req);
      if (authd.error) return res.status(authd.status || 401).json({ error: authd.error });
      const user = authd.user;
      const role =
        user.user_metadata?.role === "coach" || user.app_metadata?.role === "coach"
          ? "coach"
          : "athlete";
      if (role !== "coach") return res.status(403).json({ error: "coach access required" });
      const coachId = user.id;

      const slotId = req.body && req.body.slot_id;
      if (!slotId || !UUID_RE.test(String(slotId))) {
        return res.status(400).json({ error: "slot_id must be a uuid" });
      }

      // Tenant + state read, scoped to the caller's own slots. An unknown or
      // cross-tenant slot resolves empty -> 403 cross_tenant (same posture as
      // sendInvite's slot ownership check, reveals nothing about other tenants).
      const owned = await sbGet(
        s,
        `bookable_slots?id=eq.${slotId}&coach_id=eq.${coachId}` +
          `&select=id,coach_id,status,booked_by&limit=1`,
      );
      const slotRow = Array.isArray(owned) && owned[0] ? owned[0] : null;
      if (!slotRow) return res.status(403).json({ error: "cross_tenant" });
      if (slotRow.status !== "booked") return res.status(409).json({ error: "not_booked" });
      const athleteId = slotRow.booked_by || null;

      // ---- Gate: flip the booked slot to cancelled (concurrency guard) -------
      // status=eq.booked is the race gate; a concurrent cancel/move matches 0
      // rows and gets 409. Clears booked_by/booked_at like the invite path.
      const cancelled = await sbPatch(
        s,
        `bookable_slots?id=eq.${slotId}&coach_id=eq.${coachId}&status=eq.booked`,
        { status: "cancelled", booked_by: null, booked_at: null },
      );
      if (!Array.isArray(cancelled) || cancelled.length === 0) {
        return res.status(409).json({ error: "not_booked" });
      }
      const slot = cancelled[0];

      // ---- Refund the credit to the originating purchase --------------------
      // refunded=false + credits_remaining=null when there was no deduct to
      // reverse (zero-credit legacy booking). On a real refund, re-sum the
      // athlete's live balance so the client can update in place.
      let refunded = false;
      let creditsRemaining = null;
      try {
        const r = await refundBookingCredit(s, { slotId, fallbackCoachId: coachId });
        refunded = r.refunded;
      } catch (err) {
        console.error("[scheduling] coach cancel refund (non-fatal):", err);
      }
      if (refunded && athleteId) {
        creditsRemaining = await creditBalance(s, athleteId).catch(() => null);
      }

      if (cancellationFee) {
        await runFailSoft("coach-cancel-fee", () => cancellationFee({
          coachId,
          athleteId,
          slotId,
          kind: "late_cancel_fee",
          coachInitiated: true,
        }));
      }
      // HOOK:WAITLIST_FILL (waitlist factory, 0026 — fee must be assessed before fill)
      if (waitlistFill) {
        await runFailSoft("waitlist-fill", () => waitlistFill({ coachId, slot }));
      }

      // ---- Notify the athlete their session was cancelled -------------------
      try {
        if (notify && athleteId) {
          await notify({
            userId: athleteId,
            type: "session.cancelled",
            title: "Your session was cancelled",
            body: "Your coach cancelled this session.",
            data: { slotId, coachId },
            dedupeKey: `coach-cancel-${slotId}`,
          });
        }
      } catch (err) {
        console.error("[scheduling] coach cancel notify (non-fatal):", err);
      }

      res.json({ slot, refunded, credits_remaining: creditsRemaining });
    } catch (err) {
      console.error("[scheduling] coachCancelBooking failed:", err);
      res.status(500).json({ error: "cancel failed" });
    }
  }

  return {
    getSchedule,
    bookSlot,
    cancelBooking,
    generateSlots,
    sendInvite,
    coachCancelBooking,
  };
}

// Fan out the booking confirmation: an in-app/push/email to the coach via the
// notify() chokepoint, plus a dedicated athlete email carrying the .ics invite
// (Resend attachment) and a Google add-to-calendar link. Never throws.
async function fireBookingNotifications({ notify, getBookBaseUrl, invite, slot, claimUrl = null, bookUrl: bookUrlOverride = null }) {
  const start = new Date(slot.starts_at);
  const end = new Date(slot.ends_at);
  const coachName = invite.coaches?.full_name || "your coach";
  const athleteName = invite.athletes?.name || "Athlete";
  const title = slot.title || `Coaching session with ${coachName}`;
  // The invite lane re-enters at /book/<token>; the guest lane has no invite
  // token, so it passes an explicit bookUrl (its public coach page) to link to.
  const bookUrl =
    bookUrlOverride || `${getBookBaseUrl()}/book/${encodeURIComponent(invite.token)}`;

  // Coach side: durable in-app row + push + email via the chokepoint.
  if (notify) {
    await notify({
      userId: invite.coach_id,
      type: "session.booked",
      title: "New session booked",
      body: `${athleteName} booked ${title}.`,
      data: { slotId: slot.id, athleteId: invite.athlete_id },
      dedupeKey: `book-${slot.id}`,
    });
  }

  // Athlete side: a confirmation email with the calendar invite attached.
  const toEmail = invite.email || invite.athletes?.parent_email || null;
  if (toEmail) {
    const ics = buildIcs({
      title,
      description: `Your session with ${coachName}. Join: ${bookUrl}`,
      start,
      end,
      url: bookUrl,
      organizer: process.env.EMAIL_REPLY_TO || "hello@coachtime.app",
    });
    const gcal = buildGoogleCalendarUrl({
      title,
      start,
      end,
      description: `Your session with ${coachName}. Join: ${bookUrl}`,
    });
    const html = bookingEmailHtml({ athleteName, coachName, start, gcal, bookUrl, claimUrl });
    const text = buildPlainText([
      `${athleteName}, your session is booked.`,
      "",
      `Coach: ${coachName}`,
      `When: ${start.toUTCString()}`,
      "",
      `Add to Google Calendar: ${gcal}`,
      `Session link: ${bookUrl}`,
      // D19: the secondary account offer rides the confirmation, unclaimed only.
      ...(claimUrl ? ["", `Get your own portal: ${claimUrl}`] : []),
    ]);
    await sendTransactionalEmail({
      to: toEmail,
      subject: "Your session is booked",
      html,
      text,
      attachments: [
        {
          filename: "session.ics",
          content: Buffer.from(ics, "utf8").toString("base64"),
          contentType: "text/calendar",
        },
      ],
    });
  }
}

// Minimal branded confirmation body (reuses the email-shell look via a plain
// block; keeps the .ics + Google link front and center).
function bookingEmailHtml({ athleteName, coachName, start, gcal, bookUrl, claimUrl = null }) {
  const { brandedEmailShell, escapeHtml } = require("./email-shell");
  const when = start.toUTCString();
  // D19: a low-key secondary "Get your portal" link UNDER the calendar button,
  // present only for an unclaimed athlete (claimUrl null => nothing rendered).
  const claimRow = claimUrl
    ? `<tr>
            <td style="padding:14px 40px 0 40px;">
              <a href="${escapeHtml(claimUrl)}" style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#8A7A2E;text-decoration:underline;font-weight:600;">Get your own portal — your film, punch lists, and sessions in one place →</a>
            </td>
          </tr>`
    : "";
  return brandedEmailShell(`<tr>
            <td style="padding:32px 40px 0 40px;">
              <h1 style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:23px;line-height:1.3;color:#1A1A1D;font-weight:800;">${escapeHtml(
                athleteName,
              )}, you're booked.</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 40px 0 40px;">
              <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#333333;">
                Your session with <strong>${escapeHtml(coachName)}</strong> is confirmed.<br/>
                ${escapeHtml(when)}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 40px 0 40px;">
              <a href="${escapeHtml(gcal)}" style="display:inline-block;color:#0E0E0F;background:#D4C36A;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:8px;">Add to Google Calendar</a>
            </td>
          </tr>
          ${claimRow}
          <tr>
            <td style="padding:14px 40px 0 40px;">
              <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#6B6B70;">
                The calendar invite is attached. Session link: <a href="${escapeHtml(
                  bookUrl,
                )}" style="color:#000;">${escapeHtml(bookUrl)}</a>
              </p>
            </td>
          </tr>`);
}

// A short branded invite email: one line + a gold "Book your session" button to
// the athlete booking page. Reuses the shared email shell. Never throws (the
// sender no-ops without a Resend key). Returns the send boolean.
async function sendInviteEmail({ email, url }) {
  const { brandedEmailShell, escapeHtml } = require("./email-shell");
  const html = brandedEmailShell(`<tr>
            <td style="padding:32px 40px 0 40px;">
              <h1 style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:23px;line-height:1.3;color:#1A1A1D;font-weight:800;">You're invited to book a session.</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 40px 0 40px;">
              <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#333333;">
                Pick a time that works for you and you're set.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 40px 0 40px;">
              <a href="${escapeHtml(url)}" style="display:inline-block;color:#0E0E0F;background:#D4C36A;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:8px;">Book your session</a>
            </td>
          </tr>`);
  const text = buildPlainText([
    "You're invited to book a session.",
    "",
    `Book your session: ${url}`,
  ]);
  return sendTransactionalEmail({
    to: email,
    subject: "You're invited to book a session",
    html,
    text,
  });
}

module.exports = {
  buildSchedulingHandlers,
  // Pure helpers exported for unit tests + reuse.
  expandWindows,
  zonedWallClockToUtc,
  zoneOffsetMs,
  datePartsInZone,
  timeToMinutes,
  fireBookingNotifications,
  bookingEmailHtml,
  resolveSessionType,
  resolveBookingSessionType,
};
