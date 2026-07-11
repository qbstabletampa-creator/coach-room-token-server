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

// Events we act on. Everything else is ack'd 200 and ignored.
const HANDLED = new Set(["checkout.session.completed"]);

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

// checkout.session.completed handler — STUB. Logs and returns. Real credit /
// package provisioning (idempotent on the session id) lands in a later phase;
// this is the safe landing pad so the webhook can be wired and verified now.
async function handleCheckoutSessionCompleted(event) {
  const session = (event && event.data && event.data.object) || {};
  console.log(
    "[stripeWebhook] checkout.session.completed (stub):",
    JSON.stringify({
      id: session.id || null,
      clientReferenceId: session.client_reference_id || null,
      amountTotal: session.amount_total == null ? null : session.amount_total,
      metadata: session.metadata || null,
    }),
  );
  // No state change yet. Returning cleanly => the route ACKs 200.
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

  // Unmatched event types: ack and ignore (always 200, no retry-storm).
  if (!event.type || !HANDLED.has(event.type)) {
    return res.json({ received: true });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(event);
        break;
    }
  } catch (err) {
    // Never fail a webhook hard. Log and still ack 200.
    console.error(
      `[stripeWebhook] handler for ${event.type} failed (non-fatal):`,
      err,
    );
  }

  return res.json({ received: true });
}

module.exports = {
  stripeWebhookHandler,
  verifyStripeSignature,
  parseSigHeader,
  HANDLED,
};
