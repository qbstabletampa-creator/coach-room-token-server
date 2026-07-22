// Card-on-file no-show protection. Routes are registered behind
// PROTECTION_ENABLED; Stripe stays optional and is loaded only in real mode.

const { notify: defaultNotify } = require("./notify");
const { mirrorStripePayment: defaultMirrorStripePayment } = require("./payments");

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let runtime = {
  notify: defaultNotify,
  mirrorStripePayment: defaultMirrorStripePayment,
  getStripeSecretKey: () => process.env.STRIPE_SECRET_KEY,
  createStripe: (key) => {
    const Stripe = require("stripe");
    return new Stripe(key);
  },
};

function sb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return {
    url,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
  };
}

class DbError extends Error {
  constructor(message, status, detail = "") {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function sbGet(s, path) {
  const resp = await fetch(`${s.url}/rest/v1/${path}`, { headers: s.headers });
  if (!resp.ok) throw new DbError("supabase GET failed", resp.status, await resp.text().catch(() => ""));
  return resp.json().catch(() => []);
}

async function sbPatch(s, path, body) {
  const resp = await fetch(`${s.url}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...s.headers, prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new DbError("supabase PATCH failed", resp.status, await resp.text().catch(() => ""));
  return resp.json().catch(() => []);
}

async function sbPost(s, path, body, { upsert = false } = {}) {
  const resp = await fetch(`${s.url}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      ...s.headers,
      prefer: `${upsert ? "resolution=merge-duplicates," : ""}return=representation`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new DbError("supabase POST failed", resp.status, await resp.text().catch(() => ""));
  return resp.json().catch(() => []);
}

function one(rows) {
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function simulated() {
  const key = runtime.getStripeSecretKey();
  return !key || !String(key).startsWith("sk_");
}

function stripeClient() {
  return runtime.createStripe(runtime.getStripeSecretKey());
}

function offPolicy(hasCard = null) {
  return {
    enabled: false,
    require_card: false,
    has_card: hasCard,
    free_cancel_hours: 24,
    late_cancel_fee: { type: "none", value: 0 },
    no_show_fee: { type: "none", value: 0 },
    booking_approval: false,
    copy: "",
  };
}

function feeWords(fee) {
  if (fee.type === "none" || fee.value === 0) return "nothing";
  if (fee.type === "percent") return `${fee.value}% of the session price`;
  return `$${(fee.value / 100).toFixed(2)}`;
}

function policyCopy(dto) {
  if (!dto.enabled) return "";
  if (
    dto.require_card && dto.free_cancel_hours === 24 &&
    dto.late_cancel_fee.type === "percent" && dto.late_cancel_fee.value === 50 &&
    dto.no_show_fee.type === "percent" && dto.no_show_fee.value === 50 &&
    dto.booking_approval === false
  ) {
    return "This coach protects their time. Free to cancel up to 24 hours before. Cancel later or miss the session and you'll be charged 50% of the session price. A card is saved securely to book.";
  }
  const parts = [`This coach protects their time. Free to cancel up to ${dto.free_cancel_hours} hours before.`];
  if (dto.late_cancel_fee.type !== "none" && dto.late_cancel_fee.value > 0) {
    parts.push(`A late cancellation costs ${feeWords(dto.late_cancel_fee)}.`);
  }
  if (dto.no_show_fee.type !== "none" && dto.no_show_fee.value > 0) {
    parts.push(`A missed session costs ${feeWords(dto.no_show_fee)}.`);
  }
  if (dto.require_card) parts.push("A card is saved securely to book.");
  if (dto.booking_approval) parts.push("Bookings require coach approval.");
  return parts.join(" ");
}

function freeCancelHours(value) {
  const hours = Number(value);
  if (Number.isInteger(hours) && hours >= 0 && hours <= 168) return hours;
  console.warn(`[protection] invalid free_cancel_hours ${String(value)}; using default 24`);
  return 24;
}

function publicPolicy(row, hasCard = null) {
  if (!row || row.enabled === false) return offPolicy(hasCard);
  const dto = {
    enabled: true,
    require_card: Boolean(row.require_card),
    has_card: hasCard,
    free_cancel_hours: freeCancelHours(row.free_cancel_hours),
    late_cancel_fee: { type: row.late_cancel_fee_type, value: Number(row.late_cancel_fee_value) },
    no_show_fee: { type: row.no_show_fee_type, value: Number(row.no_show_fee_value) },
    booking_approval: Boolean(row.booking_approval),
    copy: "",
  };
  dto.copy = policyCopy(dto);
  return dto;
}

async function resolvePolicy(s, { coachId, sessionTypeId = null }) {
  let validTypeId = null;
  if (sessionTypeId) {
    const type = one(await sbGet(
      s,
      `session_types?id=eq.${encodeURIComponent(sessionTypeId)}` +
        `&coach_id=eq.${encodeURIComponent(coachId)}&select=id,price_cents&limit=1`,
    ));
    validTypeId = type ? type.id : null;
  }
  if (validTypeId) {
    const override = one(await sbGet(
      s,
      `protection_policies?coach_id=eq.${encodeURIComponent(coachId)}` +
        `&session_type_id=eq.${encodeURIComponent(validTypeId)}&select=*&limit=1`,
    ));
    if (override) return { policy: override, sessionTypeId: validTypeId };
  }
  const fallback = one(await sbGet(
    s,
    `protection_policies?coach_id=eq.${encodeURIComponent(coachId)}` +
      `&session_type_id=is.null&select=*&limit=1`,
  ));
  return { policy: fallback, sessionTypeId: validTypeId };
}

async function hasActiveCard(s, coachId, athleteId) {
  const card = one(await sbGet(
    s,
    `athlete_payment_methods?coach_id=eq.${encodeURIComponent(coachId)}` +
      `&athlete_id=eq.${encodeURIComponent(athleteId)}&status=eq.active&select=id&limit=1`,
  ));
  return Boolean(card);
}

/**
 * Tenant-locked booking enforcement core. This is deliberately not an Express
 * handler so scheduling can run it before its atomic slot claim.
 *
 * Slot truth wins over a caller-selected type. 0010's invite row has no type;
 * 0013 stores the booked type on bookable_slots, so the slot is the authority.
 * A storefront selection is considered only when the slot is untyped, and is
 * revalidated against the coach here even if the route already validated it.
 *
 * @param {{coachId:string, athleteId:string, slotId:string, sessionTypeId?:string|null, setupContext?:{email?:string|null,returnPath:string}}} args
 * @returns {Promise<{allowed:boolean,status:"allowed"|"requires_card"|"card_setup_unavailable",sessionTypeId:string|null,setup_url?:string}>}
 */
async function assessBookingGate({
  coachId,
  athleteId,
  slotId,
  sessionTypeId = null,
  setupContext = null,
} = {}) {
  const s = sb();
  if (!s || !coachId || !athleteId || !slotId) {
    return { allowed: true, status: "allowed", sessionTypeId: null };
  }
  let resolvedTypeId = null;
  try {
    const slot = one(await sbGet(
      s,
      `bookable_slots?id=eq.${encodeURIComponent(slotId)}` +
        `&coach_id=eq.${encodeURIComponent(coachId)}&select=id,session_type_id&limit=1`,
    ));
    if (!slot) {
      return { allowed: true, status: "allowed", sessionTypeId: null };
    }
    const candidateTypeId = slot?.session_type_id || sessionTypeId || null;
    const resolved = await resolvePolicy(s, { coachId, sessionTypeId: candidateTypeId });
    resolvedTypeId = resolved.sessionTypeId;
    const policy = publicPolicy(resolved.policy, null);
    if (!policy.enabled) {
      return { allowed: true, status: "allowed", sessionTypeId: resolvedTypeId };
    }
    if (policy.require_card && !(await hasActiveCard(s, coachId, athleteId))) {
      try {
        if (!setupContext?.returnPath) throw new Error("missing setup return path");
        const setup = await createSetupSession(s, {
          coachId,
          athleteId,
          email: setupContext.email || null,
          returnPath: setupContext.returnPath,
        });
        if (!setup?.url) throw new Error("setup session returned no URL");
        return {
          allowed: false,
          status: "requires_card",
          sessionTypeId: resolvedTypeId,
          setup_url: setup.url,
        };
      } catch (err) {
        console.error("[protection:booking-gate] setup session failed (blocking):", err);
        return {
          allowed: false,
          status: "card_setup_unavailable",
          sessionTypeId: resolvedTypeId,
        };
      }
    }
    if (policy.booking_approval) {
      // HOOK:APPROVAL_GATE (protection approval lifecycle — future factory)
    }
    return { allowed: true, status: "allowed", sessionTypeId: resolvedTypeId };
  } catch (err) {
    // Policy/card lookups are fail-open by decree; protection must never turn a
    // database rollout mismatch into a booking outage.
    console.error("[protection:booking-gate] read failed (non-fatal):", err);
    return { allowed: true, status: "allowed", sessionTypeId: resolvedTypeId };
  }
}

function feeAmount(policy, kind, sessionType) {
  const prefix = kind === "no_show_fee" ? "no_show" : "late_cancel";
  const type = policy?.[`${prefix}_fee_type`];
  const value = Number(policy?.[`${prefix}_fee_value`]);
  if (type === "flat") return value;
  if (type === "percent" && sessionType) {
    return Math.round(Number(sessionType.price_cents) * value / 100);
  }
  return 0;
}

/**
 * Tenant-locked late-cancel/no-show assessment core used by scheduling hooks.
 * Coach cancellations intentionally assess to a no-charge result.
 *
 * @param {{coachId:string, athleteId?:string|null, slotId:string, kind?:"late_cancel_fee"|"no_show_fee", coachInitiated?:boolean}} args
 * @returns {Promise<{assessed:boolean,reason?:string,charge?:object}>}
 */
async function assessCancellationFee({
  coachId,
  athleteId = null,
  slotId,
  kind = "late_cancel_fee",
  coachInitiated = false,
} = {}) {
  if (coachInitiated) return { assessed: false, reason: "coach_cancelled" };
  const s = sb();
  if (!s) return { assessed: false, reason: "not_configured" };
  const slot = one(await sbGet(
    s,
    `bookable_slots?id=eq.${encodeURIComponent(slotId)}` +
      `&coach_id=eq.${encodeURIComponent(coachId)}` +
      `&select=id,coach_id,booked_by,session_type_id,starts_at,ends_at&limit=1`,
  ));
  if (!slot) throw new Error("slot is not in the coach tenant");
  const resolved = await resolvePolicy(s, { coachId, sessionTypeId: slot.session_type_id });
  if (!resolved.policy || resolved.policy.enabled === false) {
    return { assessed: false, reason: "protection_off" };
  }
  if (kind === "late_cancel_fee") {
    const cutoff = new Date(slot.starts_at).getTime() - freeCancelHours(resolved.policy.free_cancel_hours) * 3600000;
    if (Date.now() <= cutoff) return { assessed: false, reason: "inside_free_cancel_window" };
  }
  const sessionType = slot.session_type_id ? one(await sbGet(
    s,
    `session_types?id=eq.${encodeURIComponent(slot.session_type_id)}` +
      `&coach_id=eq.${encodeURIComponent(coachId)}&select=id,price_cents&limit=1`,
  )) : null;
  const amount = feeAmount(resolved.policy, kind, sessionType);
  if (!Number.isInteger(amount) || amount <= 0) return { assessed: false, reason: "no_fee" };
  const payerId = athleteId || slot.booked_by;
  const saved = one(await sbGet(
    s,
    `athlete_payment_methods?coach_id=eq.${encodeURIComponent(coachId)}` +
      `&athlete_id=eq.${encodeURIComponent(payerId)}&status=eq.active&select=*&limit=1`,
  ));
  if (!saved) return { assessed: false, reason: "no_payment_method" };
  const prior = one(await sbGet(
    s,
    `booking_charges?slot_id=eq.${encodeURIComponent(slotId)}` +
      `&coach_id=eq.${encodeURIComponent(coachId)}&kind=eq.${kind}&select=*&limit=1`,
  ));
  if (prior && !["pending", "failed"].includes(prior.status)) {
    return { assessed: true, charge: chargeDto(prior) };
  }
  let charge = prior || one(await sbPost(s, "booking_charges", {
      coach_id: coachId,
      athlete_id: payerId,
      slot_id: slotId,
      session_type_id: slot.session_type_id || null,
      kind,
      amount_cents: amount,
      status: "pending",
      stripe_payment_intent_id: null,
      reason: kind === "no_show_fee" ? "No-show fee" : "Late cancellation fee",
    }));
  let pi;
  if (simulated()) {
    pi = {
      id: `pi_simulated_${charge.id}`,
      amount: Number(charge.amount_cents),
      amount_received: Number(charge.amount_cents),
      currency: "usd",
      created: Math.floor(Date.now() / 1000),
      status: "succeeded",
      metadata: { booking_charge_id: charge.id, coach_id: coachId, athlete_id: payerId, slot_id: slotId, kind },
    };
  } else {
    try {
      pi = await stripeClient().paymentIntents.create({
        amount: Number(charge.amount_cents),
        currency: "usd",
        customer: saved.stripe_customer_id,
        payment_method: saved.stripe_payment_method_id,
        off_session: true,
        confirm: true,
        metadata: { booking_charge_id: charge.id, coach_id: coachId, athlete_id: payerId, slot_id: slotId, kind },
      }, { idempotencyKey: `booking-charge:${charge.id}` });
    } catch (err) {
      const failedPi = err.payment_intent;
      if (failedPi?.id) {
        charge = await patchCharge(s, charge, {
          stripe_payment_intent_id: failedPi.id,
          status: failedPi.status === "requires_action" ? "requires_action" : "failed",
        });
        if (failedPi.status !== "requires_action") {
          await handleProtectionPaymentIntentFailed({ data: { object: failedPi } });
        }
        return { assessed: true, charge: chargeDto(charge) };
      }
      // A timeout may have reached Stripe. Mark the visible row failed, then a
      // retry reuses this row + idempotency key and cannot double-charge.
      await patchCharge(s, charge, { status: "failed" });
      throw err;
    }
  }
  charge = await patchCharge(s, charge, {
    stripe_payment_intent_id: pi.id,
    status: pi.status === "requires_action" ? "requires_action" : pi.status === "succeeded" ? "succeeded" : "failed",
  });
  if (pi.status === "succeeded") await handleProtectionPaymentIntentSucceeded({ data: { object: pi } });
  else if (pi.status !== "requires_action") await handleProtectionPaymentIntentFailed({ data: { object: pi } });
  return { assessed: true, charge: chargeDto(charge) };
}

async function lookupCoach(s, slug) {
  return one(await sbGet(
    s,
    `coaches?slug=eq.${encodeURIComponent(slug)}&select=id,slug&limit=1`,
  ));
}

async function lookupInvite(s, token, coachId = null) {
  return one(await sbGet(
    s,
    `booking_invites?token=eq.${encodeURIComponent(token)}` +
      `${coachId ? `&coach_id=eq.${encodeURIComponent(coachId)}` : ""}` +
      `&select=token,coach_id,athlete_id,email,status,expires_at&limit=1`,
  ));
}

function inviteUsable(invite) {
  return Boolean(invite && invite.athlete_id && new Date(invite.expires_at).getTime() > Date.now());
}

async function resolveGuestAthlete(s, { coachId, email, name }) {
  const existing = one(await sbGet(
    s,
    `athletes?coach_id=eq.${encodeURIComponent(coachId)}` +
      `&or=(parent_email.eq.${encodeURIComponent(email)},email.eq.${encodeURIComponent(email)})` +
      `&select=id,name,parent_email,user_id&limit=1`,
  ));
  if (existing) return existing;
  const created = await sbPost(s, "athletes", {
    coach_id: coachId,
    name,
    parent_email: email,
    source: "storefront",
  });
  return one(created);
}

async function getOrCreateStripeCustomer(s, { coachId, athleteId, email }) {
  const path =
    `stripe_customers?coach_id=eq.${encodeURIComponent(coachId)}` +
    `&athlete_id=eq.${encodeURIComponent(athleteId)}` +
    `&select=id,coach_id,athlete_id,stripe_customer_id,email&limit=1`;
  const existing = one(await sbGet(s, path));
  if (existing) return existing;

  let customerId;
  if (simulated()) {
    customerId = `cus_simulated_${String(athleteId).replace(/-/g, "")}`;
  } else {
    const customer = await stripeClient().customers.create({
      email: email || undefined,
      metadata: { coach_id: String(coachId), athlete_id: String(athleteId) },
    });
    customerId = customer.id;
  }
  try {
    return one(await sbPost(s, "stripe_customers", {
      coach_id: coachId,
      athlete_id: athleteId,
      stripe_customer_id: customerId,
      email: email || null,
      updated_at: new Date().toISOString(),
    }));
  } catch (err) {
    if (err instanceof DbError && (err.status === 409 || /23505|unique/i.test(err.detail))) {
      const winner = one(await sbGet(s, path));
      if (winner) return winner;
    }
    throw err;
  }
}

// Core hosted setup primitive shared by the public setup route and the blocking
// booking gate. Keeping the mint here guarantees both surfaces return the same
// Stripe Checkout setup-session shape and metadata.
async function createSetupSession(s, { coachId, athleteId, email = null, returnPath }) {
  const customer = await getOrCreateStripeCustomer(s, { coachId, athleteId, email });
  if (simulated()) {
    const id = `cs_simulated_setup_${athleteId}`;
    return { simulated: true, url: `https://checkout.stripe.com/simulated/${id}`, session_id: id };
  }
  const base = new URL(process.env.SCHEDULING_PUBLIC_URL || "https://coachtime.app").origin;
  const session = await stripeClient().checkout.sessions.create({
    mode: "setup",
    customer: customer.stripe_customer_id,
    payment_method_types: ["card"],
    success_url: `${base}${returnPath}?setup=success`,
    cancel_url: `${base}${returnPath}?setup=cancel`,
    metadata: { purpose: "protection_setup", coach_id: coachId, athlete_id: athleteId },
    setup_intent_data: {
      metadata: { purpose: "protection_setup", coach_id: coachId, athlete_id: athleteId },
    },
  });
  return { simulated: false, url: session.url, session_id: session.id };
}

function chargeDto(row) {
  return {
    id: row.id,
    athlete_id: row.athlete_id == null ? null : row.athlete_id,
    slot_id: row.slot_id == null ? null : row.slot_id,
    session_type_id: row.session_type_id == null ? null : row.session_type_id,
    kind: row.kind,
    amount_cents: Number(row.amount_cents),
    status: row.status,
    stripe_payment_intent_id: row.stripe_payment_intent_id || null,
    reason: row.reason == null ? null : row.reason,
    created_at: row.created_at,
  };
}

function coachRole(user) {
  return user?.user_metadata?.role === "coach" || user?.app_metadata?.role === "coach";
}

async function authenticateCoach(req, requireSupabaseUser) {
  const authd = await requireSupabaseUser(req);
  if (authd.error) return { error: "unauthorized", status: authd.status === 503 ? 503 : 401 };
  if (!coachRole(authd.user)) return { error: "coach_access_required", status: 403 };
  return { user: authd.user };
}

async function athleteForCharge(s, charge) {
  if (!charge.athlete_id) return null;
  return one(await sbGet(
    s,
    `athletes?id=eq.${encodeURIComponent(charge.athlete_id)}` +
      `&coach_id=eq.${encodeURIComponent(charge.coach_id)}` +
      `&select=id,name,user_id,parent_email,email&limit=1`,
  ));
}

async function notifyBoth(s, charge, { type, dedupeKey, title, body }) {
  const athlete = await athleteForCharge(s, charge);
  const data = { charge_id: charge.id, slot_id: charge.slot_id, amount_cents: Number(charge.amount_cents) };
  await runtime.notify({ userId: charge.coach_id, type, title, body, data, dedupeKey });
  if (charge.athlete_id) {
    await runtime.notify({
      userId: athlete?.user_id || charge.athlete_id,
      email: athlete?.parent_email || athlete?.email || undefined,
      type,
      title,
      body,
      data,
      dedupeKey,
    });
  }
}

async function findBookingChargeForPi(s, pi) {
  const mdId = pi?.metadata?.booking_charge_id;
  if (mdId && UUID_RE.test(String(mdId))) {
    const byId = one(await sbGet(s,
      `booking_charges?id=eq.${encodeURIComponent(mdId)}` +
        `&coach_id=eq.${encodeURIComponent(String(pi.metadata.coach_id || ""))}&select=*&limit=1`,
    ));
    if (byId) return byId;
  }
  if (!pi?.id) return null;
  const coachId = String(pi?.metadata?.coach_id || "");
  if (!UUID_RE.test(coachId)) return null;
  return one(await sbGet(s,
    `booking_charges?stripe_payment_intent_id=eq.${encodeURIComponent(pi.id)}` +
      `&coach_id=eq.${encodeURIComponent(coachId)}` +
      `&select=*&limit=1`,
  ));
}

async function patchCharge(s, charge, body) {
  return one(await sbPatch(
    s,
    `booking_charges?id=eq.${encodeURIComponent(charge.id)}` +
      `&coach_id=eq.${encodeURIComponent(charge.coach_id)}`,
    { ...body, updated_at: new Date().toISOString() },
  ));
}

async function voidPaymentMirror(s, coachId, paymentIntentId) {
  const rows = await sbPatch(s,
    `payments?coach_id=eq.${encodeURIComponent(coachId)}` +
      `&stripe_payment_intent_id=eq.${encodeURIComponent(paymentIntentId)}`,
    { status: "void" },
  );
  if (!one(rows)) throw new Error("protection payment mirror missing");
  return one(rows);
}

async function handleProtectionPaymentIntentSucceeded(event) {
  const s = sb();
  if (!s) throw new Error("protection not configured");
  const pi = event?.data?.object || {};
  const charge = await findBookingChargeForPi(s, pi);
  if (!charge) return;
  const bookingCharge = await patchCharge(s, charge, {
    status: "succeeded",
    stripe_payment_intent_id: pi.id,
  });
  await runtime.mirrorStripePayment({
    coachId: bookingCharge.coach_id,
    athlete_id: bookingCharge.athlete_id,
    amount_cents: Number(pi.amount_received || pi.amount),
    currency: String(pi.currency || "usd").toLowerCase(),
    collected_via: "stripe",
    slot_id: bookingCharge.slot_id,
    purchase_id: null,
    note: `booking_charge:${bookingCharge.id}:${bookingCharge.kind}`,
    occurred_at: new Date(Number(pi.created) * 1000).toISOString(),
    stripe_payment_intent_id: pi.id,
  });
  const dollars = `$${(Number(bookingCharge.amount_cents) / 100).toFixed(2)}`;
  await notifyBoth(s, bookingCharge, {
    type: `charge.${bookingCharge.kind}`,
    dedupeKey: `payment_intent.succeeded:${pi.id}`,
    title: "Protection fee charged",
    body: `${dollars} ${bookingCharge.kind.replaceAll("_", " ")} charged.`,
  });
}

async function handleProtectionPaymentIntentFailed(event) {
  const s = sb();
  if (!s) throw new Error("protection not configured");
  const pi = event?.data?.object || {};
  const charge = await findBookingChargeForPi(s, pi);
  if (!charge) return;
  const bookingCharge = await patchCharge(s, charge, {
    status: "failed",
    stripe_payment_intent_id: pi.id || charge.stripe_payment_intent_id,
  });
  await notifyBoth(s, bookingCharge, {
    type: "charge.payment_failed",
    dedupeKey: `payment_intent.payment_failed:${pi.id}`,
    title: "Protection payment failed",
    body: "The protection fee could not be collected.",
  });
}

async function savePaymentMethod(eventObject) {
  const s = sb();
  if (!s) throw new Error("protection not configured");
  let setupIntent = eventObject;
  if (eventObject?.object === "checkout.session" || eventObject?.mode === "setup") {
    setupIntent = eventObject.setup_intent;
  }
  if (typeof setupIntent === "string") setupIntent = await stripeClient().setupIntents.retrieve(setupIntent);
  if (!setupIntent || typeof setupIntent !== "object") throw new Error("setup intent missing");
  const md = setupIntent.metadata || eventObject?.metadata || {};
  const coachId = String(md.coach_id || "");
  const athleteId = String(md.athlete_id || "");
  if (!UUID_RE.test(coachId) || !UUID_RE.test(athleteId)) throw new Error("setup metadata missing");
  const athlete = one(await sbGet(s,
    `athletes?id=eq.${encodeURIComponent(athleteId)}&coach_id=eq.${encodeURIComponent(coachId)}` +
      `&select=id,parent_email,email&limit=1`,
  ));
  if (!athlete) throw new Error("setup athlete outside tenant");
  const customerId = typeof setupIntent.customer === "string" ? setupIntent.customer : setupIntent.customer?.id;
  let pm = setupIntent.payment_method;
  if (typeof pm === "string") pm = await stripeClient().paymentMethods.retrieve(pm);
  if (!customerId || !pm?.id) throw new Error("setup payment method missing");
  await sbPost(s, "stripe_customers?on_conflict=coach_id,athlete_id", {
    coach_id: coachId,
    athlete_id: athleteId,
    stripe_customer_id: customerId,
    email: athlete.parent_email || athlete.email || null,
    updated_at: new Date().toISOString(),
  }, { upsert: true });
  await sbPatch(s,
    `athlete_payment_methods?coach_id=eq.${encodeURIComponent(coachId)}` +
      `&athlete_id=eq.${encodeURIComponent(athleteId)}&status=eq.active`,
    { status: "removed", updated_at: new Date().toISOString() },
  );
  const card = pm.card || {};
  await sbPost(s, "athlete_payment_methods?on_conflict=stripe_payment_method_id", {
    coach_id: coachId,
    athlete_id: athleteId,
    stripe_customer_id: customerId,
    stripe_payment_method_id: pm.id,
    brand: card.brand || null,
    last4: card.last4 || null,
    exp_month: card.exp_month || null,
    exp_year: card.exp_year || null,
    status: "active",
    updated_at: new Date().toISOString(),
  }, { upsert: true });
}

async function handleProtectionSetupCompleted(event) {
  await savePaymentMethod(event?.data?.object || {});
}

async function handleSetupIntentSucceeded(event) {
  await savePaymentMethod(event?.data?.object || {});
}

async function handleProtectionChargeRefunded(event) {
  const s = sb();
  if (!s) throw new Error("protection not configured");
  const stripeCharge = event?.data?.object || {};
  const piId = typeof stripeCharge.payment_intent === "string"
    ? stripeCharge.payment_intent
    : stripeCharge.payment_intent?.id;
  if (!piId) return;
  // Only scope by coach_id when the charge actually carries it. A one-time
  // PACKAGE-purchase charge has NO coach_id metadata (Checkout session metadata
  // does not propagate to the Charge), so `coach_id=eq.` would send an empty
  // string to a uuid column -> Postgres 22P02 -> this handler throws -> the
  // route 500s and the package-refund handler that runs after it never executes,
  // leaving refunded credits un-revoked. booking_charges.stripe_payment_intent_id
  // is a unique per-charge link, so a package PI simply matches no protection
  // row and this no-ops safely. Protection charges still carry coach_id and keep
  // the scoped lookup.
  const mdCoach = String(stripeCharge.metadata?.coach_id || "").trim();
  const coachFilter = mdCoach ? `&coach_id=eq.${encodeURIComponent(mdCoach)}` : "";
  const charge = one(await sbGet(s,
    `booking_charges?stripe_payment_intent_id=eq.${encodeURIComponent(piId)}` +
      coachFilter +
      `&select=*&limit=1`,
  ));
  if (!charge) return;
  const refunded = await patchCharge(s, charge, { status: "refunded" });
  await voidPaymentMirror(s, charge.coach_id, piId);
  await notifyBoth(s, refunded, {
    type: "charge.refunded",
    dedupeKey: `charge.refunded:${stripeCharge.id}`,
    title: "Protection fee refunded",
    body: "The protection fee was refunded in full.",
  });
}

async function getProtectionPolicy({ coachId }) {
  const s = sb();
  if (!s) return { status: 503, data: { error: "protection_not_configured" } };
  const rows = await sbGet(s, `protection_policies?coach_id=eq.${encodeURIComponent(coachId)}&select=*&order=session_type_id.asc.nullsfirst`);
  const all = Array.isArray(rows) ? rows : [];
  return { status: 200, data: {
    default: publicPolicy(all.find((r) => r.session_type_id == null), null),
    overrides: all.filter((r) => r.session_type_id != null).map((r) => ({
      session_type_id: r.session_type_id, policy: publicPolicy(r, null),
    })),
  } };
}

async function setProtectionPolicy({ coachId, input = {} }) {
  const s = sb();
  if (!s) return { status: 503, data: { error: "protection_not_configured" } };
  const sessionTypeId = input.session_type_id == null ? null : String(input.session_type_id);
  if (sessionTypeId) {
    if (!UUID_RE.test(sessionTypeId)) return { status: 400, data: { error: "invalid_session_type_id" } };
    const owned = one(await sbGet(s, `session_types?id=eq.${encodeURIComponent(sessionTypeId)}&coach_id=eq.${encodeURIComponent(coachId)}&select=id&limit=1`));
    if (!owned) return { status: 403, data: { error: "cross_tenant" } };
  }
  const fee = (name) => {
    const value = input[name] && typeof input[name] === "object" ? input[name] : {};
    return { type: String(value.type || "none"), value: Number(value.value || 0) };
  };
  const late = fee("late_cancel_fee");
  const noShow = fee("no_show_fee");
  if (!["none", "flat", "percent"].includes(late.type) || !["none", "flat", "percent"].includes(noShow.type)) {
    return { status: 400, data: { error: "invalid_fee_type" } };
  }
  const validFee = (value) => Number.isFinite(value.value) && value.value >= 0 &&
    (value.type !== "none" || value.value === 0) &&
    (value.type !== "percent" || value.value <= 100) &&
    (value.type !== "flat" || (Number.isInteger(value.value) && value.value <= 10000000));
  if (!validFee(late) || !validFee(noShow)) {
    return { status: 400, data: { error: "invalid_fee_value" } };
  }
  const cancelHours = Number(input.free_cancel_hours);
  if (!Number.isInteger(cancelHours) || cancelHours < 0 || cancelHours > 168) {
    return { status: 400, data: { error: "invalid_free_cancel_hours" } };
  }
  const row = {
    coach_id: coachId, session_type_id: sessionTypeId,
    enabled: input.enabled === true, require_card: input.require_card === true,
    free_cancel_hours: cancelHours,
    late_cancel_fee_type: late.type, late_cancel_fee_value: late.value,
    no_show_fee_type: noShow.type, no_show_fee_value: noShow.value,
    booking_approval: input.booking_approval === true,
  };
  const typeFilter = sessionTypeId
    ? `session_type_id=eq.${encodeURIComponent(sessionTypeId)}` : "session_type_id=is.null";
  const existing = one(await sbGet(s, `protection_policies?coach_id=eq.${encodeURIComponent(coachId)}&${typeFilter}&select=id&limit=1`));
  const rows = existing
    ? await sbPatch(s, `protection_policies?id=eq.${encodeURIComponent(existing.id)}&coach_id=eq.${encodeURIComponent(coachId)}`, row)
    : await sbPost(s, "protection_policies", row);
  const saved = one(rows) || row;
  return { status: 200, data: { session_type_id: sessionTypeId, policy: publicPolicy(saved, null) } };
}

async function listBookingCharges({ coachId, status, athleteId, limit = 50, offset = 0 }) {
  const s = sb();
  if (!s) return { status: 503, data: { error: "protection_not_configured" } };
  let q = `booking_charges?coach_id=eq.${encodeURIComponent(coachId)}`;
  if (status) q += `&status=eq.${encodeURIComponent(status)}`;
  if (athleteId) q += `&athlete_id=eq.${encodeURIComponent(athleteId)}`;
  const rows = await sbGet(s, `${q}&select=*&order=created_at.desc&limit=${limit}&offset=${offset}`);
  return { status: 200, data: { charges: (Array.isArray(rows) ? rows : []).map(chargeDto), limit, offset } };
}

async function invokeCoachHandler({ coachId, kind, body, params, deps = {} }) {
  const handlers = buildProtectionHandlers({ ...deps,
    requireSupabaseUser: async () => ({ user: { id: coachId, app_metadata: { role: "coach" } } }),
  });
  return new Promise((resolve, reject) => {
    const req = { body: body || {}, params: params || {}, query: {} };
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; },
      json(data) { resolve({ status: this.statusCode, data }); return this; } };
    Promise.resolve(handlers[kind](req, res)).catch(reject);
  });
}

const chargeNoShow = ({ coachId, slotId, deps }) =>
  invokeCoachHandler({ coachId, kind: "postNoShow", body: { slot_id: slotId }, deps });
const waiveCharge = ({ coachId, chargeId, deps }) =>
  invokeCoachHandler({ coachId, kind: "postWaive", params: { id: chargeId }, deps });

function buildProtectionHandlers(deps = {}) {
  const { requireSupabaseUser, waitlistFill = null } = deps;
  runtime = {
    ...runtime,
    notify: deps.notify || defaultNotify,
    mirrorStripePayment: deps.mirrorStripePayment || defaultMirrorStripePayment,
    getStripeSecretKey: deps.getStripeSecretKey || (() => process.env.STRIPE_SECRET_KEY),
    createStripe: deps.createStripe || runtime.createStripe,
  };

  async function getInvitePolicy(req, res) {
    try {
      const s = sb();
      if (!s) return res.status(500).json({ error: "internal_error" });
      const token = String(req.params.inviteToken || "");
      if (!UUID_RE.test(token)) return res.status(400).json({ error: "invalid_invite_token" });
      const typeId = req.query.session_type_id == null ? null : String(req.query.session_type_id);
      if (typeId && !UUID_RE.test(typeId)) return res.status(400).json({ error: "invalid_session_type_id" });
      const invite = await lookupInvite(s, token);
      if (!inviteUsable(invite)) return res.status(404).json({ error: "not_found" });
      const resolved = await resolvePolicy(s, { coachId: invite.coach_id, sessionTypeId: typeId });
      const card = await hasActiveCard(s, invite.coach_id, invite.athlete_id);
      return res.json({ policy: publicPolicy(resolved.policy, card) });
    } catch (err) {
      console.error("[protection] invite policy failed:", err);
      return res.status(500).json({ error: "internal_error" });
    }
  }

  async function getSlugPolicy(req, res) {
    try {
      const s = sb();
      if (!s) return res.status(500).json({ error: "internal_error" });
      const slug = String(req.params.slug || "").toLowerCase();
      const typeId = req.query.session_type_id == null ? null : String(req.query.session_type_id);
      if (typeId && !UUID_RE.test(typeId)) return res.status(400).json({ error: "invalid_session_type_id" });
      if (!SLUG_RE.test(slug)) return res.status(404).json({ error: "not_found" });
      const coach = await lookupCoach(s, slug);
      if (!coach) return res.status(404).json({ error: "not_found" });
      const resolved = await resolvePolicy(s, { coachId: coach.id, sessionTypeId: typeId });
      return res.json({ policy: publicPolicy(resolved.policy, null) });
    } catch (err) {
      console.error("[protection] slug policy failed:", err);
      return res.status(500).json({ error: "internal_error" });
    }
  }

  async function postSetupIntent(req, res) {
    try {
      const s = sb();
      if (!s) return res.status(503).json({ error: "protection_not_configured" });
      const slug = String(req.params.slug || "").toLowerCase();
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const context = body.context;
      if (!SLUG_RE.test(slug) || !context || typeof context !== "object" || !["invite", "guest"].includes(context.kind)) {
        return res.status(400).json({ error: "invalid_body" });
      }
      const typeId = body.session_type_id == null ? null : String(body.session_type_id);
      if (typeId && !UUID_RE.test(typeId)) return res.status(400).json({ error: "invalid_session_type_id" });
      const coach = await lookupCoach(s, slug);
      if (!coach) return res.status(404).json({ error: "not_found" });
      let athlete;
      let canonicalPath;
      let email;
      if (context.kind === "invite") {
        const token = String(context.invite_token || "");
        if (!UUID_RE.test(token)) return res.status(400).json({ error: "invalid_body" });
        const invite = await lookupInvite(s, token, coach.id);
        if (!inviteUsable(invite)) return res.status(404).json({ error: "not_found" });
        athlete = one(await sbGet(s,
          `athletes?id=eq.${encodeURIComponent(invite.athlete_id)}` +
            `&coach_id=eq.${encodeURIComponent(coach.id)}&select=id,parent_email,email&limit=1`,
        ));
        canonicalPath = `/book/${token}`;
        email = athlete?.parent_email || athlete?.email || invite.email || null;
      } else {
        const rawEmail = typeof context.email === "string" ? context.email.trim().toLowerCase() : "";
        const name = typeof context.name === "string" ? context.name.trim() : "";
        if (!EMAIL_RE.test(rawEmail)) return res.status(400).json({ error: "invalid_email" });
        if (!name) return res.status(400).json({ error: "invalid_body" });
        athlete = await resolveGuestAthlete(s, { coachId: coach.id, email: rawEmail, name });
        canonicalPath = `/coach/${slug}`;
        email = rawEmail;
      }
      if (!athlete) return res.status(404).json({ error: "not_found" });
      if (body.return_path !== undefined && body.return_path !== canonicalPath) {
        return res.status(400).json({ error: "invalid_return_path" });
      }
      const resolved = await resolvePolicy(s, { coachId: coach.id, sessionTypeId: typeId });
      const policy = publicPolicy(resolved.policy, null);
      if (!policy.enabled || !policy.require_card || await hasActiveCard(s, coach.id, athlete.id)) {
        return res.status(409).json({ error: "protection_not_required" });
      }
      try {
        return res.json(await createSetupSession(s, {
          coachId: coach.id,
          athleteId: athlete.id,
          email,
          returnPath: canonicalPath,
        }));
      } catch (err) {
        console.error("[protection] setup Stripe failure:", err);
        return res.status(502).json({ error: "payment_provider_error" });
      }
    } catch (err) {
      console.error("[protection] setup failed:", err);
      return res.status(500).json({ error: "internal_error" });
    }
  }

  async function postNoShow(req, res) {
    let feeAssessmentStarted = false;
    let waitlistContext = null;
    async function finishFee(status, payload) {
      // HOOK:WAITLIST_FILL (waitlist factory, 0026 — fee must be assessed before fill)
      if (waitlistFill && waitlistContext) {
        try {
          await Promise.resolve().then(() => waitlistFill(waitlistContext));
        } catch (err) {
          console.error("[protection:hook:waitlist-fill] failed (non-fatal):", err);
        }
      }
      return res.status(status).json(payload);
    }
    try {
      const s = sb();
      if (!s) return res.status(503).json({ error: "protection_not_configured" });
      const auth = await authenticateCoach(req, requireSupabaseUser);
      if (auth.error) return res.status(auth.status).json({ error: auth.error });
      const coachId = auth.user.id;
      const slotId = req.body?.slot_id == null ? "" : String(req.body.slot_id);
      if (!UUID_RE.test(slotId)) return res.status(400).json({ error: "invalid_slot_id" });
      const slot = one(await sbGet(s,
        `bookable_slots?id=eq.${encodeURIComponent(slotId)}&coach_id=eq.${encodeURIComponent(coachId)}` +
          `&select=id,coach_id,status,booked_by,session_type_id,ends_at&limit=1`,
      ));
      if (!slot) return res.status(403).json({ error: "cross_tenant" });
      waitlistContext = { coachId, slot };
      const priorPath =
        `booking_charges?slot_id=eq.${encodeURIComponent(slotId)}&coach_id=eq.${encodeURIComponent(coachId)}` +
        `&kind=eq.no_show_fee&select=*&limit=1`;
      const prior = one(await sbGet(s, priorPath));
      if (prior && !["pending", "failed"].includes(prior.status)) {
        return finishFee(200, { charge: chargeDto(prior) });
      }
      if (!prior && (slot.status !== "booked" || new Date(slot.ends_at).getTime() > Date.now())) {
        return res.status(409).json({ error: "slot_not_eligible" });
      }
      feeAssessmentStarted = true;
      const resolved = await resolvePolicy(s, { coachId, sessionTypeId: slot.session_type_id });
      if (!resolved.policy || resolved.policy.enabled === false) return finishFee(409, { error: "protection_off" });
      const feeType = resolved.policy.no_show_fee_type;
      const feeValue = Number(resolved.policy.no_show_fee_value);
      const sessionType = slot.session_type_id ? one(await sbGet(s,
        `session_types?id=eq.${encodeURIComponent(slot.session_type_id)}` +
          `&coach_id=eq.${encodeURIComponent(coachId)}&select=id,price_cents&limit=1`,
      )) : null;
      const amount = feeType === "flat" ? feeValue
        : feeType === "percent" && sessionType ? Math.round(Number(sessionType.price_cents) * feeValue / 100)
          : 0;
      if (!Number.isInteger(amount) || amount <= 0) return finishFee(409, { error: "no_fee" });
      const saved = one(await sbGet(s,
        `athlete_payment_methods?coach_id=eq.${encodeURIComponent(coachId)}` +
          `&athlete_id=eq.${encodeURIComponent(slot.booked_by)}` +
          `&status=eq.active&select=*&limit=1`,
      ));
      if (!saved) return finishFee(409, { error: "no_payment_method" });
      let charge = prior;
      if (!charge) try {
        charge = one(await sbPost(s, "booking_charges", {
          coach_id: coachId,
          athlete_id: slot.booked_by,
          slot_id: slot.id,
          session_type_id: slot.session_type_id || null,
          kind: "no_show_fee",
          amount_cents: amount,
          status: "pending",
          stripe_payment_intent_id: null,
          reason: "No-show fee",
        }));
      } catch (err) {
        if (err instanceof DbError && (err.status === 409 || /23505|unique/i.test(err.detail))) {
          const winner = one(await sbGet(s, priorPath));
          if (winner) return finishFee(200, { charge: chargeDto(winner) });
        }
        throw err;
      }
      if (!prior) {
        const completed = await sbPatch(s,
          `bookable_slots?id=eq.${encodeURIComponent(slot.id)}&coach_id=eq.${encodeURIComponent(coachId)}&status=eq.booked`,
          { status: "completed" },
        );
        if (!one(completed)) return finishFee(409, { error: "slot_not_eligible" });
      }
      let pi;
      if (simulated()) {
        pi = {
          id: `pi_simulated_${charge.id}`,
          amount,
          amount_received: amount,
          currency: "usd",
          created: Math.floor(Date.now() / 1000),
          status: "succeeded",
          metadata: {
            booking_charge_id: charge.id, coach_id: coachId, athlete_id: slot.booked_by,
            slot_id: slot.id, kind: charge.kind,
          },
        };
      } else {
        try {
          pi = await stripeClient().paymentIntents.create({
            amount: charge.amount_cents,
            currency: "usd",
            customer: saved.stripe_customer_id,
            payment_method: saved.stripe_payment_method_id,
            off_session: true,
            confirm: true,
            metadata: {
              booking_charge_id: charge.id,
              coach_id: charge.coach_id,
              athlete_id: charge.athlete_id,
              slot_id: charge.slot_id,
              kind: charge.kind,
            },
          }, { idempotencyKey: `booking-charge:${charge.id}` });
        } catch (err) {
          const failedPi = err.payment_intent;
          if (failedPi?.id) {
            if (failedPi.status === "requires_action") {
              const requiresAction = await patchCharge(s, charge, {
                status: "requires_action",
                stripe_payment_intent_id: failedPi.id,
              });
              return finishFee(402, { error: "requires_action", charge: chargeDto(requiresAction) });
            }
            await patchCharge(s, charge, {
              status: "failed",
              stripe_payment_intent_id: failedPi.id,
            });
            await handleProtectionPaymentIntentFailed({ data: { object: failedPi } });
            const failed = one(await sbGet(s,
              `booking_charges?id=eq.${encodeURIComponent(charge.id)}&coach_id=eq.${encodeURIComponent(coachId)}&select=*&limit=1`,
            ));
            return finishFee(402, { error: "payment_failed", charge: chargeDto(failed) });
          }
          await patchCharge(s, charge, { status: "failed" });
          return finishFee(502, { error: "payment_provider_error" });
        }
      }
      charge = await patchCharge(s, charge, {
        stripe_payment_intent_id: pi.id,
        status: pi.status === "requires_action" ? "requires_action" : pi.status === "succeeded" ? "succeeded" : "failed",
      });
      if (pi.status === "succeeded") {
        await handleProtectionPaymentIntentSucceeded({ data: { object: pi } });
        charge = one(await sbGet(s,
          `booking_charges?id=eq.${encodeURIComponent(charge.id)}&coach_id=eq.${encodeURIComponent(coachId)}&select=*&limit=1`,
        ));
        return finishFee(200, { charge: chargeDto(charge) });
      }
      if (pi.status === "requires_action") {
        return finishFee(402, { error: "requires_action", charge: chargeDto(charge) });
      }
      await handleProtectionPaymentIntentFailed({ data: { object: pi } });
      charge = one(await sbGet(s,
        `booking_charges?id=eq.${encodeURIComponent(charge.id)}&coach_id=eq.${encodeURIComponent(coachId)}&select=*&limit=1`,
      ));
      return finishFee(402, { error: "payment_failed", charge: chargeDto(charge) });
    } catch (err) {
      console.error("[protection] no-show failed:", err);
      if (feeAssessmentStarted) return finishFee(500, { error: "internal_error" });
      return res.status(500).json({ error: "internal_error" });
    }
  }

  async function postWaive(req, res) {
    try {
      const s = sb();
      if (!s) return res.status(503).json({ error: "protection_not_configured" });
      const auth = await authenticateCoach(req, requireSupabaseUser);
      if (auth.error) return res.status(auth.status).json({ error: auth.error });
      const coachId = auth.user.id;
      const id = String(req.params.id || "");
      if (!UUID_RE.test(id)) return res.status(400).json({ error: "invalid_charge_id" });
      let charge = one(await sbGet(s,
        `booking_charges?id=eq.${encodeURIComponent(id)}&coach_id=eq.${encodeURIComponent(coachId)}&select=*&limit=1`,
      ));
      if (!charge) return res.status(403).json({ error: "cross_tenant" });
      if (["waived", "refunded"].includes(charge.status)) return res.json({ charge: chargeDto(charge) });
      if (["pending", "failed", "requires_action"].includes(charge.status)) {
        if (charge.stripe_payment_intent_id && !simulated()) {
          try { await stripeClient().paymentIntents.cancel(charge.stripe_payment_intent_id); }
          catch (err) { return res.status(502).json({ error: "payment_provider_error" }); }
        }
        charge = await patchCharge(s, charge, { status: "waived" });
        await notifyBoth(s, charge, {
          type: "charge.waived",
          dedupeKey: `charge.waived:${charge.id}`,
          title: "Protection fee waived",
          body: "The protection fee was waived.",
        });
        return res.json({ charge: chargeDto(charge) });
      }
      if (charge.status === "succeeded") {
        if (!charge.stripe_payment_intent_id) return res.status(409).json({ error: "charge_not_waivable" });
        if (!simulated()) {
          try { await stripeClient().refunds.create({ payment_intent: charge.stripe_payment_intent_id }); }
          catch (err) { return res.status(502).json({ error: "payment_provider_error" }); }
        }
        charge = await patchCharge(s, charge, { status: "refunded" });
        await voidPaymentMirror(s, coachId, charge.stripe_payment_intent_id);
        if (simulated()) {
          await handleProtectionChargeRefunded({ data: { object: {
            id: `ch_simulated_${charge.id}`,
            payment_intent: charge.stripe_payment_intent_id,
            metadata: { coach_id: coachId },
          } } });
          charge = one(await sbGet(s,
            `booking_charges?id=eq.${encodeURIComponent(charge.id)}` +
              `&coach_id=eq.${encodeURIComponent(coachId)}&select=*&limit=1`,
          ));
        }
        return res.json({ charge: chargeDto(charge) });
      }
      return res.status(409).json({ error: "charge_not_waivable" });
    } catch (err) {
      console.error("[protection] waive failed:", err);
      return res.status(500).json({ error: "internal_error" });
    }
  }

  return { getInvitePolicy, getSlugPolicy, postSetupIntent, postNoShow, postWaive };
}

module.exports = {
  buildProtectionHandlers,
  assessBookingGate,
  assessCancellationFee,
  getProtectionPolicy,
  setProtectionPolicy,
  listBookingCharges,
  chargeNoShow,
  waiveCharge,
  handleProtectionSetupCompleted,
  handleSetupIntentSucceeded,
  handleProtectionPaymentIntentSucceeded,
  handleProtectionPaymentIntentFailed,
  handleProtectionChargeRefunded,
};
