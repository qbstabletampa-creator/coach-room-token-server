// lib/payments.js
//
// Phase 1 of "Payments: get paid your way" (charter #18, migration 0022). The
// mark-paid rails + owed + the single payments ledger, server-mediated over the
// token server. Everything here is behind the PAYMENTS_ENABLED flag in index.js
// and is purely additive.
//
// The one revenue rule (wave-2 decree #1): the `payments` table is THE single
// collected-money source of truth. Every rail (Stripe/Apple Pay via the webhook
// mirror, plus mark-paid Venmo/CashApp/Zelle/cash/check/other here) lands ONE
// row. revenueByRail (a.k.a. computeRevenue) is the ONE revenue owner: it sums
// payments.amount_cents where status='recorded', grouped by collected_via. It
// never reads package_purchases.amount_cents (that would double count).
//
// House style, copied from scheduling.js / storefront.js:
//   - local sb() reads Supabase creds at CALL time (not module load).
//   - raw PostgREST over fetch, SERVICE KEY (bypasses RLS).
//   - EVERY query manually filters coach_id; coachId is derived from the
//     verified JWT, NEVER from the request body. Minors' money rides on this.
//   - A "compute-once" pure core ({ coachId, ... } -> data) so the future MCP
//     tools (record_payment, list_payments, ...) wrap the SAME functions the
//     HTTP handlers call — tenant logic + money math live in one place.

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Allowed rails a collected payment can arrive on (mirrors the migration CHECK).
const COLLECTED_VIA = new Set([
  "stripe",
  "apple_pay",
  "tap_to_pay",
  "venmo",
  "cashapp",
  "zelle",
  "cash",
  "check",
  "other",
]);

// Allowed values for a coach's preferred rail (mirrors coaches_preferred_rail_check).
const PREFERRED_RAIL = new Set([
  "stripe",
  "apple_pay",
  "venmo",
  "cashapp",
  "zelle",
  "cash",
  "other",
]);

// Read Supabase creds at CALL time (not module load), same as scheduling.js /
// storefront.js / notify.js, so a test that sets env before requiring index.js
// still sees them.
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

// ---- Supabase REST helpers (service role) — same shape as scheduling.js -----

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

// ---- range -> since ISO (pure) ---------------------------------------------

// Map a coarse range keyword to a lower bound (ISO) on occurred_at. `null` means
// "no lower bound" (all-time). Unknown/absent defaults to this_month, matching
// the spec's default (?range=this_month). Kept deliberately simple: month/week
// boundaries are UTC (the dashboard owns any tz nuance later).
function rangeToSince(range) {
  const now = new Date();
  const r = String(range || "this_month");
  switch (r) {
    case "all":
    case "all_time":
      return null;
    case "today": {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return d.toISOString();
    }
    case "last_7_days":
    case "week":
    case "this_week": {
      const d = new Date(now.getTime() - 7 * 86400000);
      return d.toISOString();
    }
    case "last_30_days": {
      const d = new Date(now.getTime() - 30 * 86400000);
      return d.toISOString();
    }
    case "this_year": {
      return new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString();
    }
    case "this_month":
    default:
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  }
}

// Normalize a window bound to an ISO string. Accepts a Date, an ISO string, or a
// ms epoch number; returns null for null/undefined/invalid so an absent bound is
// simply not applied. Used by revenueByRail's explicit {from,to} window mode.
function asIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---- compute-once core (pure { coachId, ... } -> data) ----------------------
// Each acquires its own sb() so a future MCP tool can call it directly with just
// a coachId. The HTTP handlers below call these SAME functions.

// computeOwed: everything a coach is owed. Two buckets:
//   charges       — open coach_charges rows (ad-hoc bills, the coach's own).
//   free_bookings — booked slots that consumed NO credit AND have NO payment
//                   (i.e. free guest bookings from the storefront lane). A
//                   credit booking is already paid at purchase, so it is not
//                   owed; we exclude any slot that has a credit deduction or a
//                   recorded payment against it.
// total_cents is the sum of the OPEN CHARGE amounts (free bookings have no
// intrinsic price, so they are listed but contribute 0 to the owed total).
async function computeOwed({ coachId }) {
  const s = sb();
  if (!s) return { charges: [], free_bookings: [], total_cents: 0 };

  const charges = await sbGet(
    s,
    `coach_charges?coach_id=eq.${coachId}&status=eq.open` +
      `&select=id,label,amount_cents,athlete_id,slot_id,created_at&order=created_at.desc`,
  );

  // Booked slots for this coach.
  const bookedSlots = await sbGet(
    s,
    `bookable_slots?coach_id=eq.${coachId}&status=eq.booked` +
      `&select=id,starts_at,ends_at,title,booked_by,session_type_id&order=starts_at.asc`,
  );

  // Slots that DID consume a credit (a paid credit booking) — exclude them.
  const deducts = await sbGet(
    s,
    `credit_deductions?coach_id=eq.${coachId}&action=eq.deduct&slot_id=not.is.null&select=slot_id`,
  ).catch(() => []);
  // Slots that already have a recorded payment against them — exclude them.
  const paidSlots = await sbGet(
    s,
    `payments?coach_id=eq.${coachId}&status=eq.recorded&slot_id=not.is.null&select=slot_id`,
  ).catch(() => []);

  const excluded = new Set();
  for (const d of Array.isArray(deducts) ? deducts : []) {
    if (d && d.slot_id) excluded.add(d.slot_id);
  }
  for (const p of Array.isArray(paidSlots) ? paidSlots : []) {
    if (p && p.slot_id) excluded.add(p.slot_id);
  }

  const free = (Array.isArray(bookedSlots) ? bookedSlots : []).filter(
    (slot) => slot && !excluded.has(slot.id),
  );

  const chargeRows = Array.isArray(charges) ? charges : [];
  const totalCents = chargeRows.reduce((sum, c) => sum + (Number(c.amount_cents) || 0), 0);

  return { charges: chargeRows, free_bookings: free, total_cents: totalCents };
}

// listPayments: the coach's collected payments, newest first, optionally within
// a range. Read-only.
async function listPayments({ coachId, range, limit = 50, offset = 0 }) {
  const s = sb();
  if (!s) return [];
  const since = rangeToSince(range);
  const sinceFilter = since ? `&occurred_at=gte.${encodeURIComponent(since)}` : "";
  const rows = await sbGet(
    s,
    `payments?coach_id=eq.${coachId}&status=eq.recorded${sinceFilter}` +
      `&select=id,amount_cents,currency,collected_via,athlete_id,slot_id,purchase_id,` +
      `charge_id,entry_source,note,occurred_at,created_at` +
      `&order=occurred_at.desc&limit=${limit}&offset=${offset}`,
  );
  return Array.isArray(rows) ? rows : [];
}

// revenueByRail (a.k.a. computeRevenue) — THE single revenue owner (decree #1).
// Sums recorded payments grouped by collected_via, within an optional range.
// Returns { by_rail: { <rail>: { count, total_cents } }, total_cents, count }.
//
// Two mutually-exclusive time modes:
//   1. Coarse range (default, back-compat): pass { range }. Lower bound only, from
//      rangeToSince(range); no upper bound. This path is BYTE-IDENTICAL to the
//      original — the dashboard's {from,to} extension is purely additive, no
//      existing call site (getOverview, MCP) changes behavior.
//   2. Explicit window (dashboard): pass { from, to } (Date | ISO | ms epoch).
//      Half-open [from, to) with UTC boundaries — `from` is inclusive (gte),
//      `to` is EXCLUSIVE (lt) so adjacent month windows never double-count a
//      payment on the boundary. Either bound may be omitted. When from OR to is
//      present, `range` is ignored (window mode wins).
async function revenueByRail({ coachId, range, from, to }) {
  const s = sb();
  if (!s) return { by_rail: {}, total_cents: 0, count: 0 };

  let occurredFilter;
  const fromIso = asIso(from);
  const toIso = asIso(to);
  if (fromIso !== null || toIso !== null) {
    // Explicit window mode (additive). Half-open [from, to), UTC.
    let f = "";
    if (fromIso !== null) f += `&occurred_at=gte.${encodeURIComponent(fromIso)}`;
    if (toIso !== null) f += `&occurred_at=lt.${encodeURIComponent(toIso)}`;
    occurredFilter = f;
  } else {
    // Coarse range mode (default) — unchanged from the original.
    const since = rangeToSince(range);
    occurredFilter = since ? `&occurred_at=gte.${encodeURIComponent(since)}` : "";
  }

  const rows = await sbGet(
    s,
    `payments?coach_id=eq.${coachId}&status=eq.recorded${occurredFilter}` +
      `&select=amount_cents,collected_via`,
  );
  const byRail = {};
  let total = 0;
  let count = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const rail = r.collected_via || "other";
    const cents = Number(r.amount_cents) || 0;
    if (!byRail[rail]) byRail[rail] = { count: 0, total_cents: 0 };
    byRail[rail].count += 1;
    byRail[rail].total_cents += cents;
    total += cents;
    count += 1;
  }
  return { by_rail: byRail, total_cents: total, count };
}

// Ownership guard: does this uuid belong to the coach in the named table? Used
// for confirm-to-match writes (the target athlete/slot/purchase/charge must be
// the coach's own before a payment references it). Returns true/false. A bad id
// shape is false. Throws only on a network error (the caller decides).
async function ownsRow(s, { table, id, coachId, extra = "" }) {
  if (!id) return true; // absent link is fine (ad-hoc payment)
  if (!UUID_RE.test(String(id))) return false;
  const rows = await sbGet(
    s,
    `${table}?id=eq.${id}&coach_id=eq.${coachId}${extra}&select=id&limit=1`,
  );
  return Array.isArray(rows) && rows.length === 1;
}

// Mirror one Stripe-collected payment into the canonical payments ledger.
// This compute-once helper is intentionally notification-free: callers own any
// receipt/alert only after this required ledger write succeeds.
async function mirrorStripePayment({
  coachId,
  athlete_id = null,
  amount_cents,
  currency = "usd",
  collected_via = "stripe",
  slot_id = null,
  purchase_id = null,
  note = null,
  occurred_at = null,
  stripe_session_id = null,
  stripe_invoice_id = null,
  stripe_payment_intent_id = null,
} = {}) {
  const s = sb();
  if (!s) throw new Error("payments mirror is not configured");
  if (!UUID_RE.test(String(coachId || ""))) throw new Error("invalid coachId");
  if (!Number.isInteger(amount_cents) || amount_cents < 0) {
    throw new Error("amount_cents must be a non-negative integer");
  }
  if (!COLLECTED_VIA.has(String(collected_via))) {
    throw new Error("collected_via is not a valid rail");
  }
  if (!currency || typeof currency !== "string") throw new Error("currency is required");

  const stripeKeys = [
    ["stripe_session_id", stripe_session_id],
    ["stripe_invoice_id", stripe_invoice_id],
    ["stripe_payment_intent_id", stripe_payment_intent_id],
  ];
  const presentStripeKeys = stripeKeys.filter(
    ([, value]) => typeof value === "string" && value.trim().length > 0,
  );
  if (presentStripeKeys.length !== 1) {
    throw new Error("exactly one Stripe key is required");
  }
  if (stripeKeys.some(([, value]) => value != null && !presentStripeKeys.some(([, v]) => v === value))) {
    throw new Error("Stripe keys must be non-empty strings");
  }

  if (!(await ownsRow(s, { table: "athletes", id: athlete_id, coachId }))) {
    throw new Error("athlete is not in the coach tenant");
  }
  if (!(await ownsRow(s, { table: "bookable_slots", id: slot_id, coachId }))) {
    throw new Error("slot is not in the coach tenant");
  }
  if (!(await ownsRow(s, { table: "package_purchases", id: purchase_id, coachId }))) {
    throw new Error("purchase is not in the coach tenant");
  }

  const [stripeKey, stripeValue] = presentStripeKeys[0];
  const existingPath =
    `payments?coach_id=eq.${encodeURIComponent(coachId)}` +
    `&${stripeKey}=eq.${encodeURIComponent(stripeValue)}` +
    `&select=*&limit=1`;

  // Preserve the existing Checkout fast path while the unique index remains the
  // concurrency guard. Every read is explicitly tenant-scoped.
  const existing = await sbGet(s, existingPath);
  if (Array.isArray(existing) && existing[0]) {
    return { payment: existing[0], inserted: false };
  }

  const row = {
    coach_id: coachId,
    athlete_id: athlete_id || null,
    amount_cents,
    currency: String(currency).toLowerCase(),
    collected_via: String(collected_via),
    slot_id: slot_id || null,
    purchase_id: purchase_id || null,
    note: note == null ? null : String(note),
    entry_source: "stripe_webhook",
    status: "recorded",
    created_by: null,
    [stripeKey]: stripeValue,
  };
  if (occurred_at) row.occurred_at = occurred_at;

  const resp = await fetch(`${s.url}/rest/v1/payments`, {
    method: "POST",
    headers: { ...s.headers, prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (resp.ok) {
    const inserted = await resp.json().catch(() => []);
    const payment = Array.isArray(inserted) && inserted[0] ? inserted[0] : null;
    if (!payment) throw new Error("payments mirror insert returned no row");
    return { payment, inserted: true };
  }

  const detail = await resp.text().catch(() => "");
  const isUniqueConflict = resp.status === 409 && /23505|duplicate key|unique/i.test(detail);
  if (isUniqueConflict) {
    const conflicted = await sbGet(s, existingPath);
    if (Array.isArray(conflicted) && conflicted[0]) {
      return { payment: conflicted[0], inserted: false };
    }
  }
  throw new Error(`supabase POST ${resp.status}: ${detail}`);
}

// recordPayment (core): insert one recorded payment row and flip any linked
// coach_charge to 'paid'. Tenant-locked: coach_id is the caller's, and every
// link (athlete/slot/purchase/charge) is verified to belong to the coach BEFORE
// the insert. Returns { payment } on success or { error } (a plain object the
// handler maps to a status). Does NOT notify — the handler owns the fail-soft
// receipt so the ledger write and the notification are cleanly separated.
async function recordPayment(args) {
  const {
    coachId,
    amount_cents,
    collected_via,
    athlete_id = null,
    slot_id = null,
    purchase_id = null,
    charge_id = null,
    note = null,
    occurred_at = null,
    entry_source = "manual",
    created_by = coachId,
  } = args || {};

  const s = sb();
  if (!s) return { error: "not_configured" };

  // amount_cents: a positive integer. This is a LOG of money already received
  // (the coach names the amount), so the checkout price-authority rule does not
  // apply — but it must still be a sane positive integer.
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    return { error: "amount_cents must be a positive integer" };
  }
  if (!collected_via || !COLLECTED_VIA.has(String(collected_via))) {
    return { error: "collected_via is not a valid rail" };
  }

  // Tenant lock: every link must be the coach's own row. A cross-tenant or stray
  // id is rejected (never silently written onto a payment) — minors' money.
  if (!(await ownsRow(s, { table: "athletes", id: athlete_id, coachId }))) {
    return { error: "athlete is not in your account" };
  }
  if (!(await ownsRow(s, { table: "bookable_slots", id: slot_id, coachId }))) {
    return { error: "slot is not in your account" };
  }
  if (!(await ownsRow(s, { table: "package_purchases", id: purchase_id, coachId }))) {
    return { error: "purchase is not in your account" };
  }
  if (!(await ownsRow(s, { table: "coach_charges", id: charge_id, coachId }))) {
    return { error: "charge is not in your account" };
  }

  const row = {
    coach_id: coachId,
    amount_cents,
    collected_via: String(collected_via),
    athlete_id: athlete_id || null,
    slot_id: slot_id || null,
    purchase_id: purchase_id || null,
    charge_id: charge_id || null,
    entry_source,
    note: note ? String(note) : null,
    status: "recorded",
    created_by: created_by || coachId,
  };
  if (occurred_at) row.occurred_at = occurred_at;

  const inserted = await sbPost(s, "payments", row);
  const payment = Array.isArray(inserted) && inserted[0] ? inserted[0] : null;
  if (!payment) return { error: "insert failed" };

  // Flip a linked open charge to paid (scoped to the coach's own charge).
  if (charge_id) {
    await sbPatch(
      s,
      `coach_charges?id=eq.${charge_id}&coach_id=eq.${coachId}&status=eq.open`,
      { status: "paid" },
      { representation: false },
    ).catch((err) => console.error("[payments] charge->paid (non-fatal):", err));
  }

  return { payment };
}

// createCharge (core): insert an ad-hoc owed item. Tenant-locked links.
async function createCharge(args) {
  const { coachId, label, amount_cents, athlete_id = null, slot_id = null } = args || {};
  const s = sb();
  if (!s) return { error: "not_configured" };

  if (!label || typeof label !== "string" || !label.trim()) {
    return { error: "label is required" };
  }
  if (!Number.isInteger(amount_cents) || amount_cents < 0) {
    return { error: "amount_cents must be a non-negative integer" };
  }
  if (!(await ownsRow(s, { table: "athletes", id: athlete_id, coachId }))) {
    return { error: "athlete is not in your account" };
  }
  if (!(await ownsRow(s, { table: "bookable_slots", id: slot_id, coachId }))) {
    return { error: "slot is not in your account" };
  }

  const inserted = await sbPost(s, "coach_charges", {
    coach_id: coachId,
    label: label.trim(),
    amount_cents,
    athlete_id: athlete_id || null,
    slot_id: slot_id || null,
    status: "open",
  });
  const charge = Array.isArray(inserted) && inserted[0] ? inserted[0] : null;
  if (!charge) return { error: "insert failed" };
  return { charge };
}

// voidPayment (core): flip a payment to 'void' (never delete), scoped to the
// coach's own row. If the voided payment was the ONLY recorded payment against
// its linked charge, reopen that charge (open) so it shows as owed again.
// Returns { payment } on success, { error:'not_found' } when the id is not the
// coach's recorded payment.
async function voidPayment({ coachId, paymentId }) {
  const s = sb();
  if (!s) return { error: "not_configured" };
  if (!paymentId || !UUID_RE.test(String(paymentId))) return { error: "not_found" };

  // Load the coach's OWN payment first (tenant lock: a cross-tenant id resolves
  // empty -> not_found, revealing nothing about another coach's ledger).
  const rows = await sbGet(
    s,
    `payments?id=eq.${paymentId}&coach_id=eq.${coachId}` +
      `&select=id,status,charge_id&limit=1`,
  );
  const existing = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!existing) return { error: "not_found" };
  if (existing.status === "void") {
    // Idempotent: already void, nothing to reopen twice.
    return { payment: existing };
  }

  // Flip recorded -> void with a conditional gate (a concurrent void matches 0).
  const voided = await sbPatch(
    s,
    `payments?id=eq.${paymentId}&coach_id=eq.${coachId}&status=eq.recorded`,
    { status: "void" },
  );
  if (!Array.isArray(voided) || voided.length === 0) {
    return { error: "not_found" };
  }

  // Reopen the linked charge only if this was its last recorded payment.
  if (existing.charge_id) {
    const others = await sbGet(
      s,
      `payments?coach_id=eq.${coachId}&charge_id=eq.${existing.charge_id}` +
        `&status=eq.recorded&select=id&limit=1`,
    ).catch(() => []);
    if (!Array.isArray(others) || others.length === 0) {
      await sbPatch(
        s,
        `coach_charges?id=eq.${existing.charge_id}&coach_id=eq.${coachId}&status=eq.paid`,
        { status: "open" },
        { representation: false },
      ).catch((err) => console.error("[payments] charge reopen (non-fatal):", err));
    }
  }

  return { payment: voided[0] };
}

// getRails (core): the coach's rail handles + preferred rail + page toggle.
async function getRails({ coachId }) {
  const s = sb();
  if (!s) return null;
  const rows = await sbGet(
    s,
    `coaches?id=eq.${coachId}` +
      `&select=venmo_handle,cashapp_handle,zelle_handle,preferred_rail,show_rails_on_page&limit=1`,
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// ---- handler factory -------------------------------------------------------

/**
 * Build the payments route handlers. `deps` injects the shared primitives so the
 * routes stay testable (tests mock global.fetch + pass a stub notify).
 *
 * @param {object} deps
 * @param {(req)=>Promise<{user?:object,error?:string,status?:number}>} deps.requireSupabaseUser
 * @param {(args:object)=>Promise<void>} deps.notify  the notify() chokepoint.
 */
function buildPaymentsHandlers(deps) {
  const { requireSupabaseUser, notify } = deps || {};

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

  // GET /payments/overview?range=this_month — owed + paid in one payload. Read-only.
  async function getOverview(req, res) {
    try {
      if (!sb()) return res.status(503).json({ error: "payments not configured" });
      const auth = await authCoach(req, res);
      if (!auth) return;
      const { coachId } = auth;
      const range = req.query && req.query.range;

      const [owed, revenue, recent] = await Promise.all([
        computeOwed({ coachId }),
        revenueByRail({ coachId, range }),
        listPayments({ coachId, range, limit: 100 }),
      ]);

      res.json({
        range: String(range || "this_month"),
        owed,
        paid: {
          by_rail: revenue.by_rail,
          total_cents: revenue.total_cents,
          count: revenue.count,
          recent,
        },
      });
    } catch (err) {
      console.error("[payments] getOverview failed:", err);
      res.status(500).json({ error: "could not load payments" });
    }
  }

  // POST /payments — record a payment received on any rail.
  async function postPayment(req, res) {
    try {
      if (!sb()) return res.status(503).json({ error: "payments not configured" });
      const auth = await authCoach(req, res);
      if (!auth) return;
      const { coachId } = auth;
      const b = req.body || {};

      const result = await recordPayment({
        coachId,
        amount_cents: b.amount_cents,
        collected_via: b.collected_via,
        athlete_id: b.athlete_id ? String(b.athlete_id) : null,
        slot_id: b.slot_id ? String(b.slot_id) : null,
        purchase_id: b.purchase_id ? String(b.purchase_id) : null,
        charge_id: b.charge_id ? String(b.charge_id) : null,
        note: b.note != null ? String(b.note) : null,
        occurred_at: b.occurred_at ? String(b.occurred_at) : null,
        entry_source: "manual",
        created_by: coachId,
      });
      if (result.error) {
        // Ownership / validation failures are client errors (400).
        return res.status(400).json({ error: result.error });
      }
      const payment = result.payment;

      // Fail-soft in-app receipt to the coach (dedupeKey pay-<id>). A notify
      // hiccup must never unwind the recorded payment.
      try {
        if (notify) {
          const dollars = (Number(payment.amount_cents) / 100).toFixed(2);
          await notify({
            userId: coachId,
            type: "payment.recorded",
            title: "Payment recorded",
            body: `You logged $${dollars} via ${payment.collected_via}.`,
            data: { paymentId: payment.id, collected_via: payment.collected_via },
            dedupeKey: `pay-${payment.id}`,
          });
        }
      } catch (err) {
        console.error("[payments] receipt notify (non-fatal):", err);
      }

      res.status(201).json({ payment });
    } catch (err) {
      console.error("[payments] postPayment failed:", err);
      res.status(500).json({ error: "could not record payment" });
    }
  }

  // POST /payments/:id/void — void a payment (status flip, never delete).
  async function postVoid(req, res) {
    try {
      if (!sb()) return res.status(503).json({ error: "payments not configured" });
      const auth = await authCoach(req, res);
      if (!auth) return;
      const { coachId } = auth;
      const paymentId = req.params.id || "";

      const result = await voidPayment({ coachId, paymentId });
      if (result.error === "not_found") {
        return res.status(404).json({ error: "payment not found" });
      }
      if (result.error) {
        return res.status(400).json({ error: result.error });
      }
      res.json({ payment: result.payment });
    } catch (err) {
      console.error("[payments] postVoid failed:", err);
      res.status(500).json({ error: "could not void payment" });
    }
  }

  // POST /charges — create an ad-hoc owed item.
  async function postCharge(req, res) {
    try {
      if (!sb()) return res.status(503).json({ error: "payments not configured" });
      const auth = await authCoach(req, res);
      if (!auth) return;
      const { coachId } = auth;
      const b = req.body || {};

      const result = await createCharge({
        coachId,
        label: b.label,
        amount_cents: b.amount_cents,
        athlete_id: b.athlete_id ? String(b.athlete_id) : null,
        slot_id: b.slot_id ? String(b.slot_id) : null,
      });
      if (result.error) return res.status(400).json({ error: result.error });
      res.status(201).json({ charge: result.charge });
    } catch (err) {
      console.error("[payments] postCharge failed:", err);
      res.status(500).json({ error: "could not create charge" });
    }
  }

  // GET /payments/methods — the coach's rail handles + preferred rail + toggle.
  async function getMethods(req, res) {
    try {
      if (!sb()) return res.status(503).json({ error: "payments not configured" });
      const auth = await authCoach(req, res);
      if (!auth) return;
      const rails = await getRails({ coachId: auth.coachId });
      res.json({
        venmo_handle: rails?.venmo_handle || null,
        cashapp_handle: rails?.cashapp_handle || null,
        zelle_handle: rails?.zelle_handle || null,
        preferred_rail: rails?.preferred_rail || null,
        show_rails_on_page: rails?.show_rails_on_page || false,
      });
    } catch (err) {
      console.error("[payments] getMethods failed:", err);
      res.status(500).json({ error: "could not load methods" });
    }
  }

  // PATCH /payments/rails — update the coach's rail handles / preferred rail /
  // page visibility. Only the named columns; each optional. Tenant-scoped write.
  async function patchRails(req, res) {
    try {
      const s = sb();
      if (!s) return res.status(503).json({ error: "payments not configured" });
      const auth = await authCoach(req, res);
      if (!auth) return;
      const { coachId } = auth;
      const b = req.body || {};

      const patch = {};
      // Handles: a string sets it; an explicit null/"" clears it.
      for (const key of ["venmo_handle", "cashapp_handle", "zelle_handle"]) {
        if (Object.prototype.hasOwnProperty.call(b, key)) {
          const v = b[key];
          patch[key] = v == null || v === "" ? null : String(v).trim();
        }
      }
      if (Object.prototype.hasOwnProperty.call(b, "preferred_rail")) {
        const v = b.preferred_rail;
        if (v == null || v === "") {
          patch.preferred_rail = null;
        } else if (PREFERRED_RAIL.has(String(v))) {
          patch.preferred_rail = String(v);
        } else {
          return res.status(400).json({ error: "preferred_rail is not a valid rail" });
        }
      }
      if (Object.prototype.hasOwnProperty.call(b, "show_rails_on_page")) {
        patch.show_rails_on_page = Boolean(b.show_rails_on_page);
      }

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: "no rail fields to update" });
      }

      const updated = await sbPatch(
        s,
        `coaches?id=eq.${coachId}`,
        patch,
        { representation: true },
      );
      const row = Array.isArray(updated) && updated[0] ? updated[0] : null;
      res.json({
        venmo_handle: row?.venmo_handle ?? null,
        cashapp_handle: row?.cashapp_handle ?? null,
        zelle_handle: row?.zelle_handle ?? null,
        preferred_rail: row?.preferred_rail ?? null,
        show_rails_on_page: row?.show_rails_on_page ?? false,
      });
    } catch (err) {
      console.error("[payments] patchRails failed:", err);
      res.status(500).json({ error: "could not update rails" });
    }
  }

  return {
    getOverview,
    postPayment,
    postVoid,
    postCharge,
    getMethods,
    patchRails,
  };
}

module.exports = {
  buildPaymentsHandlers,
  // Compute-once core, exported so the future MCP tools wrap the SAME functions.
  computeOwed,
  listPayments,
  revenueByRail,
  computeRevenue: revenueByRail, // decree #1 alias: THE revenue owner.
  recordPayment,
  mirrorStripePayment,
  createCharge,
  voidPayment,
  getRails,
  rangeToSince,
  COLLECTED_VIA,
  PREFERRED_RAIL,
};
