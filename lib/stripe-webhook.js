// lib/stripe-webhook.js
//
// The little-soles defensive Stripe webhook skeleton
// (ls-api/src/controllers/stripeWebhook.controller.ts) adapted to this stack.
// CommonJS, and — deliberately — NO `stripe` dependency: signature verification
// is done with Node's crypto against Stripe's documented scheme, so the webhook
// works with zero new packages and is fully unit-testable.
//
// Contract (identical safety posture to the original):
//   - The route is mounted with express.raw() BEFORE any express.json() so the
//     body arrives as the exact bytes Stripe signed (index.js wires this).
//   - Signature verification runs ONLY when STRIPE_WEBHOOK_SECRET is set (real
//     mode). A bad/missing signature is the ONE case we answer non-200 (400) —
//     Stripe SHOULD retry a tampered/garbled delivery.
//   - Simulated mode: no secret set -> nothing to verify, parse the body and
//     proceed. DEV-ONLY; a real deploy MUST set the secret.
//   - HANDLED is the set of event types we act on. Everything else is ACK'd 200
//     and ignored, so Stripe never retry-storms us.
//   - checkout.session.completed is the only HANDLED type for now, and its
//     handler is a STUB: it logs and returns (credit provisioning lands later).
//   - Any handler error is logged and still ACK'd 200 (handlers are idempotent;
//     a hard failure would only trigger a retry-storm).

const crypto = require("crypto");
const { notify } = require("./notify");
const { mintOrReuseClaim, claimUrl } = require("./claims");
const {
  emailLocalPart,
  findAthleteByEmail,
  createAthlete,
} = require("./athlete-match");
const { mirrorStripePayment } = require("./payments");
// MONEY_ROUND:WEBHOOK_PROTECTION:BEGIN
const {
  handleProtectionSetupCompleted,
  handleSetupIntentSucceeded,
  handleProtectionPaymentIntentSucceeded,
  handleProtectionPaymentIntentFailed,
  handleProtectionChargeRefunded,
} = require("./protection");
// MONEY_ROUND:WEBHOOK_PROTECTION:END
// MONEY_ROUND:WEBHOOK_BILLING:BEGIN
const {
  handleBillingCheckoutCompleted,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
} = require("./billing");
// MONEY_ROUND:WEBHOOK_BILLING:END

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Events we act on. Everything else is ack'd 200 and ignored.
const HANDLED = new Set([
  "checkout.session.completed",
  // MONEY_ROUND:WEBHOOK_PROTECTION:BEGIN
  "setup_intent.succeeded",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
  // MONEY_ROUND:WEBHOOK_PROTECTION:END
  // MONEY_ROUND:WEBHOOK_BILLING:BEGIN
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  // MONEY_ROUND:WEBHOOK_BILLING:END
]);

// Read Supabase creds at CALL time (not module load), same as scheduling.js/
// notify.js, so a test that sets env before requiring index.js still sees them.
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

// emailLocalPart, findAthleteByEmail, createAthlete now live in lib/athlete-match.js
// (shared with the storefront guest-booking lane) and are imported above.

// Look up the package server-side (the AUTHORITY for credits/coach/expiry — the
// client never names these). Returns { id, coach_id, credits, expires_days } or null.
async function lookupPackage(s, packageId) {
  try {
    const resp = await fetch(
      `${s.url}/rest/v1/packages?id=eq.${encodeURIComponent(packageId)}` +
        `&select=id,coach_id,credits,expires_days,name&limit=1`,
      { headers: s.headers },
    );
    if (!resp.ok) return null;
    const rows = await resp.json().catch(() => []);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (err) {
    console.error("[stripeWebhook] package lookup failed:", err);
    return null;
  }
}

// Idempotency pre-check: is a purchase already keyed on this session id? Returns
// the row or null. The DB unique(stripe_session_id) is the true guard; this is
// the cheap fast path so a redelivery no-ops before any writes.
async function findPurchaseBySession(s, sessionId) {
  try {
    const resp = await fetch(
      `${s.url}/rest/v1/package_purchases?stripe_session_id=eq.${encodeURIComponent(
        sessionId,
      )}&select=id,coach_id,athlete_id&limit=1`,
      { headers: s.headers },
    );
    if (!resp.ok) return null;
    const rows = await resp.json().catch(() => []);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (err) {
    console.error("[stripeWebhook] purchase lookup failed:", err);
    return null;
  }
}

// Insert the purchase row. Returns the raw response so the caller can read status
// (201 fresh, 409 unique conflict => idempotent no-op).
async function insertPurchase(s, row) {
  return fetch(`${s.url}/rest/v1/package_purchases`, {
    method: "POST",
    headers: { ...s.headers, prefer: "return=representation" },
    body: JSON.stringify(row),
  });
}

// Decide which rail a completed Checkout session collected on. Best-effort: a
// wallet of type apple_pay (surfaced on the session's payment method details or
// options, or listed in payment_method_types) tags the row apple_pay; everything
// else is plain card => 'stripe'. Fail-safe: any uncertainty defaults to stripe.
// (Apple Pay tagging is Phase 2; the detector lands now, harmless, defaulting
// stripe so the Phase 1 mirror is correct without it.)
function detectCollectedVia(session) {
  try {
    const s = session || {};
    const walletCandidates = [
      s.payment_method_options &&
        s.payment_method_options.card &&
        s.payment_method_options.card.wallet,
      s.wallet,
      s.payment_method_details &&
        s.payment_method_details.card &&
        s.payment_method_details.card.wallet &&
        s.payment_method_details.card.wallet.type,
    ];
    for (const w of walletCandidates) {
      if (w && String(typeof w === "object" ? w.type : w).toLowerCase().includes("apple")) {
        return "apple_pay";
      }
    }
    const types = Array.isArray(s.payment_method_types) ? s.payment_method_types : [];
    if (types.some((t) => String(t).toLowerCase().includes("apple"))) return "apple_pay";
  } catch {
    /* fall through to stripe */
  }
  return "stripe";
}

// Default tolerance for the timestamp in the Stripe-Signature header, seconds.
// Stripe's own libraries default to 300s. We keep the same so a slightly slow
// delivery still verifies, but a replayed old payload eventually fails.
const DEFAULT_TOLERANCE_S = Number(process.env.STRIPE_WEBHOOK_TOLERANCE_S || 300);

// Parse a "t=...,v1=...,v1=..." Stripe-Signature header into { t, v1: [...] }.
function parseSigHeader(header) {
  const out = { t: null, v1: [] };
  if (typeof header !== "string" || !header) return out;
  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === "t") out.t = v;
    else if (k === "v1") out.v1.push(v);
  }
  return out;
}

// Verify a Stripe signature against the raw body. Implements Stripe's scheme:
//   signed_payload = `${t}.${rawBody}`
//   expected       = HMAC_SHA256(secret, signed_payload)  (hex)
//   valid          = any v1 in the header equals expected (constant-time) AND
//                    the timestamp is within tolerance.
// Returns true/false. Never throws.
function verifyStripeSignature(rawBody, sigHeader, secret, toleranceS) {
  try {
    if (!secret) return false;
    const { t, v1 } = parseSigHeader(sigHeader);
    if (!t || v1.length === 0) return false;

    const bodyBuf = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(String(rawBody == null ? "" : rawBody), "utf8");
    const signedPayload = Buffer.concat([
      Buffer.from(`${t}.`, "utf8"),
      bodyBuf,
    ]);
    const expected = crypto
      .createHmac("sha256", secret)
      .update(signedPayload)
      .digest("hex");
    const expectedBuf = Buffer.from(expected, "utf8");

    // Constant-time compare against every provided v1 signature.
    let matched = false;
    for (const provided of v1) {
      const providedBuf = Buffer.from(provided, "utf8");
      if (
        providedBuf.length === expectedBuf.length &&
        crypto.timingSafeEqual(providedBuf, expectedBuf)
      ) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;

    // Replay guard: reject if the timestamp is outside tolerance.
    const tol = Number.isFinite(toleranceS) ? toleranceS : DEFAULT_TOLERANCE_S;
    const tsSeconds = Number(t);
    if (!Number.isFinite(tsSeconds)) return false;
    const ageS = Math.abs(Date.now() / 1000 - tsSeconds);
    if (tol > 0 && ageS > tol) return false;

    return true;
  } catch {
    return false;
  }
}

// Resolve the incoming request into a Stripe event, verifying the signature when
// a secret is configured. Returns { event } on success, or { badSignature:true }
// when a secret is set but the signature check fails (the only 400 case).
function resolveEvent(req) {
  const raw = req.body;
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  // Real verification: a signing secret is set.
  if (secret) {
    const sig = req.headers["stripe-signature"];
    if (!sig || typeof sig !== "string") return { badSignature: true };
    if (!verifyStripeSignature(raw, sig, secret)) return { badSignature: true };
    // Verified — now parse the (trusted) bytes into the event object.
    const parsed = parseBody(raw);
    return { event: parsed };
  }

  // SIMULATED / DEV (no secret): trust the payload and parse it.
  return { event: parseBody(raw) };
}

// Parse the raw request body (Buffer from express.raw, a string, or an
// already-parsed object) into a plain event object.
function parseBody(raw) {
  if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString("utf8"));
  if (typeof raw === "string") return JSON.parse(raw);
  return raw || {};
}

// checkout.session.completed handler — REAL provisioning, idempotent on the
// unique stripe_session_id. Only ever reached AFTER the route's hard gate has
// confirmed STRIPE_WEBHOOK_SECRET is set and the signature verified (we never
// provision on an unverified event — the qb-stable scar). Every branch returns
// cleanly so the route ACKs 200; a throw is caught by the route and still 200'd
// (handlers are idempotent, a retry-storm helps nobody).
async function handlePaymentCheckoutSessionCompleted(event) {
  const session = (event && event.data && event.data.object) || {};
  const sessionId = session.id ? String(session.id) : null;
  if (!sessionId) {
    console.log("[stripeWebhook] checkout.session.completed with no session id — skipping");
    return; // nothing to key idempotency on.
  }

  const s = sb();
  if (!s) {
    // No Supabase creds (dev/test without a DB). Can't provision; ACK + ignore.
    console.error("[stripeWebhook] Supabase not configured — cannot provision", sessionId);
    return;
  }

  // The package id rides the checkout session metadata (checkout.js sets
  // metadata.packageId). No package => a foreign/malformed session we cannot
  // provision; ACK and ignore.
  const md = session.metadata || {};
  const packageId = md.packageId || md.package_id || null;
  if (!packageId || !UUID_RE.test(String(packageId))) {
    console.log("[stripeWebhook] session carries no package metadata — skipping", sessionId);
    return;
  }

  // Idempotency (pre-check): a purchase already keyed on this session id => no-op.
  const existing = await findPurchaseBySession(s, sessionId);
  if (existing) {
    console.log("[stripeWebhook] duplicate session already provisioned:", sessionId);
    if (existing.coach_id) {
      await mirrorStripePayment({
        coachId: existing.coach_id,
        athlete_id: existing.athlete_id || null,
        amount_cents: Number.isInteger(Number(session.amount_total)) && Number(session.amount_total) >= 0
          ? Number(session.amount_total)
          : 0,
        currency: session.currency ? String(session.currency).toLowerCase() : "usd",
        collected_via: detectCollectedVia(session),
        purchase_id: existing.id,
        stripe_session_id: sessionId,
      }).catch((err) =>
        console.error("[stripeWebhook] payments mirror repair (non-fatal):", err),
      );
    }
    return;
  }

  // Look up the package server-side: it is the authority for credits / coach /
  // expiry. The client's amount is never trusted for provisioning.
  const pkg = await lookupPackage(s, packageId);
  if (!pkg) {
    console.error("[stripeWebhook] package not found, cannot provision:", sessionId, packageId);
    return;
  }
  const credits = Number(pkg.credits);
  if (!Number.isInteger(credits) || credits <= 0) {
    console.error("[stripeWebhook] package has invalid credits:", pkg);
    return;
  }
  const expiresAt =
    pkg.expires_days == null
      ? null
      : new Date(Date.now() + Number(pkg.expires_days) * 86400000).toISOString();

  // Buyer email: Stripe fills customer_details.email; fall back to customer_email
  // / metadata.email. Normalized to lowercase so the tenant match is stable.
  const rawEmail =
    (session.customer_details && session.customer_details.email) ||
    session.customer_email ||
    md.email ||
    null;
  const email = rawEmail ? String(rawEmail).trim().toLowerCase() : null;

  // ---- Buy-first funnel: resolve the athlete + the account offer ------------
  // Matched + unclaimed, or newly created => mint/reuse a claim (the account
  // offer rides the payment.confirmed email). Matched + already claimed => link
  // the purchase, no claim. No email at all => an unlinked purchase (rare).
  let athleteId = null;
  let claimToken = null;
  if (email) {
    const matched = await findAthleteByEmail(s, { coachId: pkg.coach_id, email });
    if (matched) {
      athleteId = matched.id;
      if (matched.user_id == null) {
        claimToken = await mintOrReuseClaim(s, { coachId: pkg.coach_id, athleteId });
      }
    } else {
      // No athlete in this tenant: create the card from the email THEN mint the
      // claim. NOT a Supabase auth user — the claim tap creates that (the magic
      // link), so there is no new auth surface here.
      const name =
        (session.customer_details && session.customer_details.name) ||
        emailLocalPart(email);
      const created = await createAthlete(s, { coachId: pkg.coach_id, name, email, source: "storefront" });
      if (created) {
        athleteId = created.id;
        claimToken = await mintOrReuseClaim(s, { coachId: pkg.coach_id, athleteId });
      }
    }
  }

  // ---- Insert the purchase (idempotent on the unique stripe_session_id) ------
  const amountCents = Number(session.amount_total);
  // Capture the payment_intent so a later charge.refunded can find THIS purchase
  // (migration 0032). It is the only globally-unique link a refund event carries
  // back to a one-time package purchase; the refund does not carry the session id.
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent && session.payment_intent.id) || null;
  const purchaseRow = {
    coach_id: pkg.coach_id,
    package_id: pkg.id,
    athlete_id: athleteId,
    purchaser_email: email || "unknown@unknown.invalid", // NOT NULL column
    credits_total: credits,
    credits_remaining: credits,
    amount_cents: Number.isInteger(amountCents) && amountCents >= 0 ? amountCents : 0,
    expires_at: expiresAt,
    status: "active",
    stripe_session_id: sessionId,
    stripe_payment_intent_id: paymentIntentId,
    source: "checkout",
  };

  let resp;
  try {
    resp = await insertPurchase(s, purchaseRow);
  } catch (err) {
    // R2: a transient network/DB failure BEFORE a durable mint. Do NOT ACK 200 —
    // that tells Stripe the paid event is handled and it will never retry, so the
    // athlete's credits are lost forever. THROW so the route returns 5xx and
    // Stripe redelivers. The mint is idempotent on the unique stripe_session_id:
    // a redelivery that finds the row no-ops via the pre-check / 409 path below.
    console.error("[stripeWebhook] purchase insert threw — signaling Stripe retry:", err);
    throw err;
  }
  if (resp.status === 409) {
    // A concurrent redelivery won the purchase race. Independently repair the
    // payments mirror before treating the delivery as idempotent success.
    console.log("[stripeWebhook] concurrent duplicate session (unique conflict):", sessionId);
    const racedPurchase = await findPurchaseBySession(s, sessionId);
    if (racedPurchase) {
      await mirrorStripePayment({
        coachId: pkg.coach_id,
        athlete_id: racedPurchase.athlete_id || athleteId,
        amount_cents: Number.isInteger(amountCents) && amountCents >= 0 ? amountCents : 0,
        currency: session.currency ? String(session.currency).toLowerCase() : "usd",
        collected_via: detectCollectedVia(session),
        purchase_id: racedPurchase.id,
        stripe_session_id: sessionId,
      }).catch((err) =>
        console.error("[stripeWebhook] payments mirror race repair (non-fatal):", err),
      );
    }
    return;
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    // A unique violation surfaced in the body is still idempotent success.
    if (detail && detail.includes("23505")) {
      const racedPurchase = await findPurchaseBySession(s, sessionId);
      if (racedPurchase) {
        await mirrorStripePayment({
          coachId: pkg.coach_id,
          athlete_id: racedPurchase.athlete_id || athleteId,
          amount_cents: Number.isInteger(amountCents) && amountCents >= 0 ? amountCents : 0,
          currency: session.currency ? String(session.currency).toLowerCase() : "usd",
          collected_via: detectCollectedVia(session),
          purchase_id: racedPurchase.id,
          stripe_session_id: sessionId,
        }).catch((err) =>
          console.error("[stripeWebhook] payments mirror race repair (non-fatal):", err),
        );
      }
      return;
    }
    // R2: a genuine failure to mint (transient 5xx, timeout surfaced as non-ok,
    // etc.) that is NOT the idempotent unique-conflict. MUST NOT ACK 200 — throw
    // so the route returns 5xx and Stripe retries; the credits are preserved and
    // provision on redelivery (the unique stripe_session_id keeps it exactly-once).
    console.error("[stripeWebhook] purchase insert failed — signaling Stripe retry:", resp.status, detail);
    throw new Error(`purchase insert failed: ${resp.status}`);
  }

  // The inserted purchase id links the mirror row back to package_purchases.
  let purchaseId = null;
  try {
    const created = await resp.json();
    if (Array.isArray(created) && created[0]) purchaseId = created[0].id;
  } catch {
    /* representation not readable; mirror still writes with a null purchase_id */
  }

  // ---- Mirror into the ONE payments ledger (decree #1). FAIL-SOFT ABSOLUTE ---
  await mirrorStripePayment({
    coachId: pkg.coach_id,
    athlete_id: athleteId,
    amount_cents: Number.isInteger(amountCents) && amountCents >= 0 ? amountCents : 0,
    currency: session.currency ? String(session.currency).toLowerCase() : "usd",
    collected_via: detectCollectedVia(session),
    purchase_id: purchaseId,
    stripe_session_id: sessionId,
  }).catch((err) =>
    console.error("[stripeWebhook] payments mirror (non-fatal):", err),
  );

  // ---- notify() payment.confirmed, claim link in the email when present -----
  // dedupe_key = stripe_session_id so a redelivery that slipped past the pre-
  // check still fires the buyer exactly once. The email channel targets the
  // buyer directly; the in-app row targets the best available auth user.
  const base = process.env.SCHEDULING_PUBLIC_URL || "https://coachtime.app";
  const link = claimToken ? claimUrl(base, claimToken) : null;
  const creditWord = credits === 1 ? "credit" : "credits";
  const bodyLines = [`Payment confirmed. You've got ${credits} session ${creditWord} ready.`];
  if (link) bodyLines.push(`Set up your portal: ${link}`);
  try {
    await notify({
      userId: session.client_reference_id || pkg.coach_id,
      type: "payment.confirmed",
      title: "Payment confirmed",
      body: bodyLines.join(" "),
      data: link ? { claimUrl: link, credits } : { credits },
      dedupeKey: sessionId,
      email: email || undefined,
    });
  } catch (err) {
    console.error("[stripeWebhook] payment.confirmed notify (non-fatal):", err);
  }
}

// MONEY_ROUND:WEBHOOK_PROTECTION:BEGIN
// W1 handler definitions live in lib/protection.js.
// MONEY_ROUND:WEBHOOK_PROTECTION:END
// MONEY_ROUND:WEBHOOK_BILLING:BEGIN
// Billing event implementations live in lib/billing.js; this shared file only dispatches.
// MONEY_ROUND:WEBHOOK_BILLING:END

async function handleCheckoutSessionCompleted(event) {
  const session = event?.data?.object || {};
  if (session.mode === "setup") return handleProtectionSetupCompleted(event);
  if (session.mode === "subscription") return handleBillingCheckoutCompleted(event);
  return handlePaymentCheckoutSessionCompleted(event);
}

// ---- R3: package-purchase refund revoke ------------------------------------
// A refund of a one-time package purchase (charge.refunded) must revoke the
// credits it minted, or the athlete keeps spendable credits they no longer paid
// for. The Charge's payment_intent is the only globally-unique link back to the
// purchase (stored at mint, migration 0032). We revoke the still-UNSPENT credits
// (clamp at zero — already-spent credits cannot be un-spent; that shortfall is
// recorded in the ledger reason, never as a negative balance), flip the purchase
// to 'refunded', append the immutable 'expire' ledger row (same shape 0011/0025
// use for zeroing credits with a reason), and void the collected-money mirror so
// revenue reflects the refund. Idempotent: a redelivery finds status='refunded'
// and no-ops. A protection or foreign payment_intent matches no purchase -> safe
// no-op (the protection refund handler owns those).

function firstRow(rows) {
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function findPurchaseByPaymentIntent(s, piId) {
  const resp = await fetch(
    `${s.url}/rest/v1/package_purchases?stripe_payment_intent_id=eq.${encodeURIComponent(piId)}` +
      `&select=id,coach_id,athlete_id,credits_total,credits_remaining,status&limit=1`,
    { headers: s.headers },
  );
  if (!resp.ok) throw new Error(`purchase-by-payment-intent lookup failed: ${resp.status}`);
  return firstRow(await resp.json().catch(() => []));
}

// Conditional revoke: zero the EXACT credits we read (CAS on credits_remaining +
// a not-yet-refunded status) so a concurrent spend or webhook redelivery can
// never double-count. Returns the updated row when THIS delivery won the revoke,
// else null (someone else moved the row; the caller re-reads and retries).
async function casRevokePurchase(s, purchase) {
  const remaining = Number(purchase.credits_remaining);
  const guard = Number.isInteger(remaining) ? remaining : 0;
  const resp = await fetch(
    `${s.url}/rest/v1/package_purchases?id=eq.${encodeURIComponent(purchase.id)}` +
      `&coach_id=eq.${encodeURIComponent(purchase.coach_id)}` +
      `&status=neq.refunded&credits_remaining=eq.${guard}`,
    {
      method: "PATCH",
      headers: { ...s.headers, prefer: "return=representation" },
      body: JSON.stringify({ credits_remaining: 0, status: "refunded" }),
    },
  );
  if (!resp.ok) throw new Error(`refund revoke PATCH failed: ${resp.status}`);
  return firstRow(await resp.json().catch(() => []));
}

async function appendExpireLedger(s, { coachId, purchaseId, amount, reason }) {
  const resp = await fetch(`${s.url}/rest/v1/credit_deductions`, {
    method: "POST",
    headers: { ...s.headers, prefer: "return=minimal" },
    body: JSON.stringify({
      coach_id: coachId,
      purchase_id: purchaseId,
      action: "expire", // 0011 ledger action for "credits zeroed, with a reason"
      amount, // positive magnitude (0011 CHECK amount > 0); only called when > 0
      reason,
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`refund ledger append failed: ${resp.status} ${detail}`);
  }
}

async function voidPurchasePaymentMirror(s, coachId, purchaseId) {
  await fetch(
    `${s.url}/rest/v1/payments?coach_id=eq.${encodeURIComponent(coachId)}` +
      `&purchase_id=eq.${encodeURIComponent(purchaseId)}&status=eq.recorded`,
    {
      method: "PATCH",
      headers: { ...s.headers, prefer: "return=minimal" },
      body: JSON.stringify({ status: "void" }),
    },
  );
}

async function handlePackageChargeRefunded(event) {
  const s = sb();
  if (!s) return; // no DB (dev/test without creds) — nothing to revoke.
  const charge = (event && event.data && event.data.object) || {};
  const piId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : (charge.payment_intent && charge.payment_intent.id) || null;
  if (!piId) return; // no payment_intent -> nothing to link a package refund to.

  // Bounded CAS loop: re-read + revoke so a credit spend landing at the exact
  // moment the refund arrives cannot make us silently skip the revoke.
  let old = null;
  let won = null;
  for (let attempt = 0; attempt < 3 && !won; attempt += 1) {
    old = await findPurchaseByPaymentIntent(s, piId);
    if (!old) return; // not a package purchase (protection / foreign PI) — safe no-op.
    if (old.status === "refunded") return; // idempotent: already revoked.
    won = await casRevokePurchase(s, old);
  }
  if (!won) {
    console.error("[stripeWebhook] refund revoke could not settle after retries:", piId);
    return;
  }

  const oldRemaining = Math.max(0, Number(old.credits_remaining) || 0);
  const total = Math.max(0, Number(old.credits_total) || 0);
  const spent = Math.max(0, total - oldRemaining);

  // Immutable ledger row for the clawback. amount is a positive magnitude, so a
  // FULLY-spent pack (oldRemaining 0) writes no row (nothing was clawed back);
  // its refund is still recorded by status='refunded' + the mirror void. When
  // there ARE unspent credits, the already-spent shortfall rides the reason so
  // the ledger records it without ever driving the balance negative.
  if (oldRemaining > 0) {
    await appendExpireLedger(s, {
      coachId: old.coach_id,
      purchaseId: old.id,
      amount: oldRemaining,
      reason: spent > 0 ? `payment_refunded:shortfall_${spent}` : "payment_refunded",
    });
  }

  // Void the collected-money mirror so revenue reflects the refund. Fail-soft:
  // the credit revoke above is the correctness-critical step and already landed.
  await voidPurchasePaymentMirror(s, old.coach_id, old.id).catch((err) =>
    console.error("[stripeWebhook] refund payments void (non-fatal):", err),
  );

  try {
    const word = oldRemaining === 1 ? "credit" : "credits";
    await notify({
      userId: old.coach_id,
      type: "payment.refunded",
      title: "Payment refunded",
      body:
        oldRemaining > 0
          ? `A payment was refunded; ${oldRemaining} unused ${word} were removed.`
          : "A payment was refunded.",
      dedupeKey: `charge.refunded:package:${charge.id || piId}`,
    });
  } catch (err) {
    console.error("[stripeWebhook] refund notify (non-fatal):", err);
  }
}

// The Express handler. PUBLIC (Stripe calls it server-to-server). Always ACK 200
// except a genuinely bad signature (400).
async function stripeWebhookHandler(req, res) {
  let resolved;
  try {
    resolved = resolveEvent(req);
  } catch (err) {
    // Unparseable body on the dev path. ACK 200 so Stripe doesn't retry-storm an
    // event we can never parse.
    console.error("[stripeWebhook] could not parse event (non-fatal):", err);
    return res.json({ received: true });
  }

  if (resolved && resolved.badSignature) {
    return res.status(400).json({ error: "Invalid signature" });
  }

  const event = resolved.event || {};

  // Unmatched event types: ack and ignore (always 200, no retry-storm). This is
  // BEFORE the secret gate on purpose — an ignored event needs no provisioning,
  // so a missing secret must not turn a harmless ignore into a retry loop.
  if (!event.type || !HANDLED.has(event.type)) {
    return res.json({ received: true });
  }

  // ---- HARD GATE: never provision on an unverified event --------------------
  // A handled event provisions credits/accounts. If STRIPE_WEBHOOK_SECRET is
  // unset the event is UNVERIFIED (resolveEvent trusted the raw payload), so we
  // refuse to provision anything — the qb-stable scar. We answer 503 (not 200)
  // deliberately: 503 tells Stripe "temporarily unavailable, retry later", so a
  // genuinely paid event is PRESERVED for redelivery (Stripe retries with
  // backoff for up to ~3 days) and provisions correctly once the secret is
  // configured — a paid purchase is never silently dropped. A 200 here would
  // permanently lose the purchase; a 400 would tell Stripe the delivery is
  // malformed (it isn't). Non-handled events already returned 200 above, so a
  // misconfigured server never retry-storms on noise, only on real handled events.
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error(
      "[stripeWebhook] refusing to provision a handled event without STRIPE_WEBHOOK_SECRET",
      event.type,
    );
    return res.status(503).json({ error: "webhook secret not configured" });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        try { await handleCheckoutSessionCompleted(event); }
        catch (err) {
          if (event?.data?.object?.mode !== "setup") throw err;
          console.error("[stripeWebhook] protection checkout setup failed:", err);
          return res.status(500).json({ error: "webhook_handler_failed" });
        }
        break;
      // MONEY_ROUND:WEBHOOK_PROTECTION:BEGIN
      case "setup_intent.succeeded":
        try { await handleSetupIntentSucceeded(event); }
        catch (err) {
          console.error("[stripeWebhook] protection setup_intent failed:", err);
          return res.status(500).json({ error: "webhook_handler_failed" });
        }
        break;
      case "payment_intent.succeeded":
        try { await handleProtectionPaymentIntentSucceeded(event); }
        catch (err) {
          console.error("[stripeWebhook] protection payment success failed:", err);
          return res.status(500).json({ error: "webhook_handler_failed" });
        }
        break;
      case "payment_intent.payment_failed":
        try { await handleProtectionPaymentIntentFailed(event); }
        catch (err) {
          console.error("[stripeWebhook] protection payment failure handler failed:", err);
          return res.status(500).json({ error: "webhook_handler_failed" });
        }
        break;
      case "charge.refunded":
        try {
          // A refunded charge is either a protection no-show fee OR a one-time
          // package purchase. Run both; each no-ops when the charge is not its
          // own (protection matches by booking_charge, package by payment_intent).
          await handleProtectionChargeRefunded(event);
          await handlePackageChargeRefunded(event);
        }
        catch (err) {
          console.error("[stripeWebhook] refund handler failed:", err);
          return res.status(500).json({ error: "webhook_handler_failed" });
        }
        break;
      // MONEY_ROUND:WEBHOOK_PROTECTION:END
      // MONEY_ROUND:WEBHOOK_BILLING:BEGIN
      case "invoice.paid":
        await (global.handleInvoicePaid || handleInvoicePaid)(event);
        break;
      case "invoice.payment_failed":
        await (global.handleInvoicePaymentFailed || handleInvoicePaymentFailed)(event);
        break;
      case "customer.subscription.updated":
        await (global.handleSubscriptionUpdated || handleSubscriptionUpdated)(event);
        break;
      case "customer.subscription.deleted":
        await (global.handleSubscriptionDeleted || handleSubscriptionDeleted)(event);
        break;
      // MONEY_ROUND:WEBHOOK_BILLING:END
    }
  } catch (err) {
    console.error(
      `[stripeWebhook] handler for ${event.type} failed:`,
      err,
    );
    return res.status(500).json({ error: "webhook_handler_failed" });
  }

  return res.json({ received: true });
}

module.exports = {
  stripeWebhookHandler,
  verifyStripeSignature,
  parseSigHeader,
  HANDLED,
  detectCollectedVia,
  handlePackageChargeRefunded,
};
