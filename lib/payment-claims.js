// lib/payment-claims.js
//
// Universal payments, claim + confirm rail (spec:
// wiki/pages/tech/coachtime-universal-payments-spec-2026-07-22.md, migration
// 0033). The out-of-band lane: a parent pays the coach's Venmo/Zelle/Cash App
// directly, then taps "I paid" (createClaim -> a pending payment_claims row).
// The coach reviews the queue (listClaims) and taps Confirm (confirmClaim),
// which mints EXACTLY ONE canonical payments row via the SHARED recordPayment
// (entry_source='athlete_claim', matched_by='athlete_claim',
// collected_via=claimed_rail) and flips the claim to confirmed. dismissClaim
// throws the claim away and NEVER mints.
//
// NOT lib/claims.js — that is the unrelated athlete-invite (magic-link) flow.
// Everything here is payment_claims / payment-claims by name to avoid collision.
//
// House style, copied from lib/payments.js + lib/reminder-settings.js:
//   - local sb() reads Supabase creds at CALL time (not module load).
//   - raw PostgREST over fetch, SERVICE KEY (bypasses RLS).
//   - EVERY query manually filters coach_id; coachId is derived from a verified
//     JWT (coach side) or a resolved invite identity (athlete side) by the
//     caller, NEVER from a request body. Minors' money rides on this.
//   - a "compute-once" pure-ish core ({ coachId, ... } -> { data } | { error })
//     so the HTTP handlers AND any future MCP tool wrap the SAME functions.
//
// The single revenue rule is unchanged: the confirm mint lands ONE payments row
// and revenueByRail stays the ONE revenue owner. The mint is a DIRECT service-key
// insert here, following the recordPayment IDIOM (the same way mirrorStripePayment
// writes the ledger directly for the Stripe rail) rather than delegating to
// lib/payments.js recordPayment. The spec REQUIRES matched_by='athlete_claim'
// and the claim's external_ref on the minted row; minting here keeps full
// control of that field mapping while touching nothing in payments.js.
// (recordPayment has since grown matched_by/external_ref passthrough for other
// rails, but the direct mint stays: the confirm's CAS-then-mint-then-rollback
// dance owns its own write, and delegating would split that invariant.)

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Rails a claim can arrive on (mirrors payment_claims_claimed_rail_check in 0033).
// A claim is ALWAYS an out-of-band P2P rail; card/stripe money never claims,
// it mirrors through the webhook.
const CLAIM_RAILS = new Set(["venmo", "zelle", "cashapp", "other"]);
const CLAIM_STATUS = new Set(["pending", "confirmed", "dismissed"]);

const CLAIM_SELECT =
  "id,coach_id,athlete_id,amount_cents,claimed_rail,external_ref,note,status,posted_at,created_at";

// Read Supabase creds at CALL time (not module load), same as lib/payments.js.
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

// ---- Supabase REST helpers (service role) — same shape as lib/payments.js ----

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

// Optional text field: absent/null -> null; a non-string is a hard reject; a
// string is trimmed, capped, and an empty result collapses to null. Returns
// { value } or { error }.
function optionalText(v, max, label) {
  if (v == null) return { value: null };
  if (typeof v !== "string") return { error: `${label} must be text` };
  const t = v.trim();
  if (!t) return { value: null };
  if (t.length > max) return { error: `${label} is too long` };
  return { value: t };
}

// Ownership guard: does this athlete uuid belong to the coach? Absent id is fine
// (an unassigned claim). A bad shape is false. Throws only on a network error.
async function ownsAthlete(s, coachId, athleteId) {
  if (athleteId == null) return true;
  if (!UUID_RE.test(String(athleteId))) return false;
  const rows = await sbGet(
    s,
    `athletes?id=eq.${athleteId}&coach_id=eq.${coachId}&select=id&limit=1`,
  );
  return Array.isArray(rows) && rows.length === 1;
}

// ---- compute-once core ({ ... } -> { data } | { error }) --------------------

// createClaim (athlete side): record a pending "I paid you out of band" claim.
// coachId is the tenant owner; athlete_id (optional) must be the coach's own
// athlete. Never mints a payment — a claim is a REQUEST, the coach confirms.
async function createClaim({
  coachId,
  athlete_id = null,
  amount_cents,
  claimed_rail,
  external_ref = null,
  note = null,
  posted_at = null,
} = {}) {
  const s = sb();
  if (!s) return { error: "not_configured" };

  if (!UUID_RE.test(String(coachId || ""))) return { error: "invalid coachId" };
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    return { error: "amount_cents must be a positive integer" };
  }
  if (!claimed_rail || !CLAIM_RAILS.has(String(claimed_rail))) {
    return { error: "claimed_rail is not a valid claim rail" };
  }

  const ref = optionalText(external_ref, 200, "external_ref");
  if (ref.error) return { error: ref.error };
  const nt = optionalText(note, 500, "note");
  if (nt.error) return { error: nt.error };

  // Tenant lock: an assigned athlete must be the coach's own row.
  if (athlete_id != null && !UUID_RE.test(String(athlete_id))) {
    return { error: "invalid athlete_id" };
  }
  if (!(await ownsAthlete(s, coachId, athlete_id))) {
    return { error: "athlete is not in your account" };
  }

  const row = {
    coach_id: coachId,
    athlete_id: athlete_id || null,
    amount_cents,
    claimed_rail: String(claimed_rail),
    external_ref: ref.value,
    note: nt.value,
    status: "pending",
  };
  if (posted_at) row.posted_at = posted_at;

  const inserted = await sbPost(s, "payment_claims", row);
  const claim = Array.isArray(inserted) && inserted[0] ? inserted[0] : null;
  if (!claim) return { error: "insert failed" };
  return { claim };
}

// listClaims (coach side): the coach's claims, PENDING FIRST then newest first.
// Read-only, tenant-scoped. An optional status filter narrows the queue.
async function listClaims({ coachId, status = null, limit = 100, offset = 0 } = {}) {
  const s = sb();
  if (!s) return [];
  const statusFilter =
    status && CLAIM_STATUS.has(String(status)) ? `&status=eq.${status}` : "";
  const rows = await sbGet(
    s,
    `payment_claims?coach_id=eq.${coachId}${statusFilter}` +
      `&select=${CLAIM_SELECT}&order=created_at.desc&limit=${limit}&offset=${offset}`,
  );
  const list = Array.isArray(rows) ? rows : [];
  // Stable "pending first": PostgREST cannot order by a computed predicate, so
  // the created_at.desc order arrives from the DB and pending floats to the top
  // here without disturbing within-group ordering.
  const rank = (r) => (r.status === "pending" ? 0 : 1);
  return list
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map((x) => x.r);
}

// confirmClaim (coach side): the ONE mint. Idempotent by a status CAS —
// pending -> confirmed is flipped BEFORE the mint, so a concurrent OR a
// sequential double-confirm matches zero rows on the second attempt and NEVER
// mints twice. On the CAS win, mint EXACTLY ONE canonical payments row via a
// direct service-key insert (the recordPayment idiom; see the module header for
// why this rail does not delegate to lib/payments.js recordPayment): the row
// carries entry_source='athlete_claim', matched_by='athlete_claim',
// collected_via = the claim's rail (an 'other' claim stays 'other'), external_ref
// carried over, amount from the claim. If the mint fails after the CAS, the claim
// is rolled back to pending so it can be retried (invariant: confirmed <=> one
// minted payment). posted_at, if given, overrides the claim's own posted_at as
// the ledger occurred_at. Returns { claim, payment } | { error }.
async function confirmClaim({ coachId, claimId, posted_at = null } = {}) {
  const s = sb();
  if (!s) return { error: "not_configured" };
  if (!UUID_RE.test(String(coachId || ""))) return { error: "invalid coachId" };
  if (!claimId || !UUID_RE.test(String(claimId))) return { error: "not_found" };

  // Load the coach's OWN claim (tenant lock: a cross-tenant id resolves empty ->
  // not_found, revealing nothing about another coach's queue).
  const rows = await sbGet(
    s,
    `payment_claims?id=eq.${claimId}&coach_id=eq.${coachId}` +
      `&select=${CLAIM_SELECT}&limit=1`,
  );
  const claim = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!claim) return { error: "not_found" };
  // Fast paths (the CAS below is the real guard, these just avoid a wasted write).
  if (claim.status === "confirmed") return { error: "already_confirmed" };
  if (claim.status === "dismissed") return { error: "dismissed" };

  // Defense in depth (minors' money): an assigned athlete must still be the
  // coach's own row. athlete_id was validated at create; a cascade could only
  // null it, never repoint it — re-checking costs one scoped read and regresses
  // nothing if the athlete was unlinked (null passes).
  if (claim.athlete_id != null && !(await ownsAthlete(s, coachId, claim.athlete_id))) {
    return { error: "athlete is not in your account" };
  }

  // CAS: flip pending -> confirmed. A concurrent confirm or a re-delivery matches
  // 0 rows here and bails BEFORE any mint. This is the anti-double-mint guard.
  const flipped = await sbPatch(
    s,
    `payment_claims?id=eq.${claimId}&coach_id=eq.${coachId}&status=eq.pending`,
    { status: "confirmed" },
  );
  if (!Array.isArray(flipped) || flipped.length === 0) {
    return { error: "already_confirmed" };
  }

  // We won the CAS. Mint EXACTLY ONE canonical payments row (recordPayment idiom:
  // direct service-key insert, status 'recorded', coach_id from the verified
  // caller). collected_via = the claim rail as-is ('other' stays 'other').
  const row = {
    coach_id: coachId,
    athlete_id: claim.athlete_id || null,
    amount_cents: claim.amount_cents,
    collected_via: String(claim.claimed_rail),
    external_ref: claim.external_ref || null,
    note: claim.note || null,
    entry_source: "athlete_claim",
    matched_by: "athlete_claim",
    status: "recorded",
    created_by: coachId,
  };
  const occurred = posted_at || claim.posted_at || null;
  if (occurred) row.occurred_at = occurred;

  let payment = null;
  try {
    const inserted = await sbPost(s, "payments", row);
    payment = Array.isArray(inserted) && inserted[0] ? inserted[0] : null;
  } catch (err) {
    console.error("[payment_claims] confirm mint failed:", err);
  }

  if (!payment) {
    // Mint failed after the CAS. Roll the claim back to pending so a retry can
    // mint it, preserving the confirmed<=>minted invariant. Best-effort; a
    // rollback miss is logged, never thrown (the caller already sees the error).
    await sbPatch(
      s,
      `payment_claims?id=eq.${claimId}&coach_id=eq.${coachId}&status=eq.confirmed`,
      { status: "pending" },
      { representation: false },
    ).catch((err) =>
      console.error("[payment_claims] confirm rollback (non-fatal):", err),
    );
    return { error: "mint_failed" };
  }

  return { claim: { ...claim, status: "confirmed" }, payment };
}

// dismissClaim (coach side): throw a pending claim away. NEVER mints. A CAS on
// pending keeps it safe against a race with confirm (whoever flips first wins;
// the loser matches 0 rows). Idempotent on an already-dismissed claim; refuses
// to dismiss a confirmed claim (its money is already recorded). Returns
// { claim } | { error }.
async function dismissClaim({ coachId, claimId } = {}) {
  const s = sb();
  if (!s) return { error: "not_configured" };
  if (!claimId || !UUID_RE.test(String(claimId))) return { error: "not_found" };

  const rows = await sbGet(
    s,
    `payment_claims?id=eq.${claimId}&coach_id=eq.${coachId}&select=id,status&limit=1`,
  );
  const claim = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!claim) return { error: "not_found" };
  if (claim.status === "dismissed") return { claim }; // idempotent
  if (claim.status === "confirmed") return { error: "already_confirmed" };

  const flipped = await sbPatch(
    s,
    `payment_claims?id=eq.${claimId}&coach_id=eq.${coachId}&status=eq.pending`,
    { status: "dismissed" },
  );
  if (!Array.isArray(flipped) || flipped.length === 0) {
    // Lost a race with confirm (or no longer pending). Never mints either way.
    return { error: "not_found" };
  }
  return { claim: flipped[0] };
}

// ---- handler factory --------------------------------------------------------

/**
 * Build the payment-claims route handlers. deps injects the shared primitives so
 * the routes stay testable and this module never edits or requires lib/payments.js.
 *
 * @param {object} deps
 * @param {(req)=>Promise<{user?:object,error?:string,status?:number}>} deps.requireSupabaseUser
 *   verifies a coach JWT (role 'coach') for the coach-side list/confirm/dismiss.
 * @param {(req)=>Promise<{coachId:string,athleteId?:string}|null>} [deps.resolveClaimant]
 *   resolves the ATHLETE-side identity for createClaim to { coachId, athleteId }.
 *   index.js owns how an athlete authenticates (the booking-invite token lane,
 *   "the invite token IS the athlete's identity"); without it, POST /claims 503s.
 * @param {(args:object)=>Promise<void>} [deps.notify] optional receipt chokepoint.
 *
 * NOTE: the confirm mint is a direct service-key insert inside confirmClaim (see
 * the module header). No recordPayment injection is needed or accepted.
 */
function buildPaymentClaimsHandlers(deps) {
  const { requireSupabaseUser, resolveClaimant, notify } = deps || {};

  async function authCoach(req, res) {
    if (typeof requireSupabaseUser !== "function") {
      res.status(503).json({ error: "not_configured" });
      return null;
    }
    let authd;
    try {
      authd = await requireSupabaseUser(req);
    } catch (_) {
      res.status(401).json({ error: "unauthorized" });
      return null;
    }
    if (!authd || authd.error || !authd.user) {
      res.status(authd?.status || 401).json({ error: authd?.error || "unauthorized" });
      return null;
    }
    if (authd.user.app_metadata?.role && authd.user.app_metadata.role !== "coach") {
      res.status(403).json({ error: "forbidden" });
      return null;
    }
    return { coachId: authd.user.id };
  }

  // POST /claims (athlete side): the "I paid" tap. Identity comes from the
  // injected resolveClaimant, NEVER from the body.
  async function postClaim(req, res) {
    try {
      if (!sb()) return res.status(503).json({ error: "payments not configured" });
      if (typeof resolveClaimant !== "function") {
        return res.status(503).json({ error: "not_configured" });
      }
      let who;
      try {
        who = await resolveClaimant(req);
      } catch (_) {
        who = null;
      }
      if (!who || !who.coachId) return res.status(401).json({ error: "unauthorized" });

      const b = req.body || {};
      const result = await createClaim({
        coachId: who.coachId,
        athlete_id: who.athleteId || (b.athlete_id ? String(b.athlete_id) : null),
        amount_cents: b.amount_cents,
        claimed_rail: b.claimed_rail,
        external_ref: b.external_ref != null ? String(b.external_ref) : null,
        note: b.note != null ? String(b.note) : null,
        posted_at: b.posted_at ? String(b.posted_at) : null,
      });
      if (result.error) return res.status(400).json({ error: result.error });

      // Fail-soft heads-up to the coach that a claim is waiting.
      try {
        if (notify) {
          const dollars = (Number(result.claim.amount_cents) / 100).toFixed(2);
          await notify({
            userId: who.coachId,
            type: "payment.claim_pending",
            title: "Payment claim to confirm",
            body: `An athlete says they paid $${dollars} via ${result.claim.claimed_rail}.`,
            data: { claimId: result.claim.id, claimed_rail: result.claim.claimed_rail },
            dedupeKey: `claim-${result.claim.id}`,
          });
        }
      } catch (err) {
        console.error("[payment_claims] claim notify (non-fatal):", err);
      }

      res.status(201).json({ claim: result.claim });
    } catch (err) {
      console.error("[payment_claims] postClaim failed:", err);
      res.status(500).json({ error: "could not create claim" });
    }
  }

  // GET /claims?status=pending (coach side): the review queue, pending first.
  async function getClaims(req, res) {
    try {
      if (!sb()) return res.status(503).json({ error: "payments not configured" });
      const auth = await authCoach(req, res);
      if (!auth) return;
      const status = req.query && req.query.status;
      const claims = await listClaims({ coachId: auth.coachId, status });
      res.json({ claims });
    } catch (err) {
      console.error("[payment_claims] getClaims failed:", err);
      res.status(500).json({ error: "could not load claims" });
    }
  }

  // POST /claims/:id/confirm (coach side): mint one payment + flip to confirmed.
  async function postConfirm(req, res) {
    try {
      if (!sb()) return res.status(503).json({ error: "payments not configured" });
      const auth = await authCoach(req, res);
      if (!auth) return;
      const claimId = req.params.id || "";
      const b = req.body || {};
      const result = await confirmClaim({
        coachId: auth.coachId,
        claimId,
        posted_at: b.posted_at ? String(b.posted_at) : null,
      });
      if (result.error === "not_found") return res.status(404).json({ error: "claim not found" });
      if (result.error === "already_confirmed") {
        return res.status(409).json({ error: "already_confirmed" });
      }
      if (result.error === "dismissed") {
        return res.status(409).json({ error: "dismissed" });
      }
      if (result.error) return res.status(400).json({ error: result.error });

      try {
        if (notify) {
          const dollars = (Number(result.payment.amount_cents) / 100).toFixed(2);
          await notify({
            userId: auth.coachId,
            type: "payment.recorded",
            title: "Payment recorded",
            body: `You confirmed $${dollars} via ${result.payment.collected_via}.`,
            data: { paymentId: result.payment.id, claimId },
            dedupeKey: `pay-${result.payment.id}`,
          });
        }
      } catch (err) {
        console.error("[payment_claims] confirm receipt notify (non-fatal):", err);
      }

      res.json({ claim: result.claim, payment: result.payment });
    } catch (err) {
      console.error("[payment_claims] postConfirm failed:", err);
      res.status(500).json({ error: "could not confirm claim" });
    }
  }

  // POST /claims/:id/dismiss (coach side): discard a pending claim. Never mints.
  async function postDismiss(req, res) {
    try {
      if (!sb()) return res.status(503).json({ error: "payments not configured" });
      const auth = await authCoach(req, res);
      if (!auth) return;
      const claimId = req.params.id || "";
      const result = await dismissClaim({ coachId: auth.coachId, claimId });
      if (result.error === "not_found") return res.status(404).json({ error: "claim not found" });
      if (result.error === "already_confirmed") {
        return res.status(409).json({ error: "already_confirmed" });
      }
      if (result.error) return res.status(400).json({ error: result.error });
      res.json({ claim: result.claim });
    } catch (err) {
      console.error("[payment_claims] postDismiss failed:", err);
      res.status(500).json({ error: "could not dismiss claim" });
    }
  }

  return { postClaim, getClaims, postConfirm, postDismiss };
}

module.exports = {
  buildPaymentClaimsHandlers,
  // Compute-once core, exported so tests + any future MCP tool wrap the SAME fns.
  createClaim,
  listClaims,
  confirmClaim,
  dismissClaim,
  CLAIM_RAILS,
  CLAIM_STATUS,
};
