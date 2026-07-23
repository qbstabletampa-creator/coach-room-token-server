// lib/paypal.js
//
// The PayPal collect lane for CoachTime universal payments (spec:
// wiki/pages/tech/coachtime-universal-payments-spec-2026-07-22.md, Phase 3;
// migration 0033 payments.paypal_order_id + partial unique index). Two halves:
//
//   1. A tiny PayPal Orders v2 client (OAuth2 client-credentials with a cached
//      token, createOrder / captureOrder / verifyWebhookSignature). No PayPal SDK
//      dependency — plain fetch against the documented REST endpoints, so it is
//      fully unit-testable by mocking global.fetch (the house idiom).
//
//   2. buildPaypalHandlers: the three Express routes (create-order, return,
//      webhook). Same security posture as lib/checkout.js — identity from the
//      verified Supabase JWT, the price is server-authoritative from the package
//      row (packageId only, the client never names an amount), and the coach must
//      have a paypal_email on file for the rail to work.
//
// DISPOSITION (recorded per the build brief): the universal-payments spec's
// Phase 3 acceptance is "a PayPal order captures and writes ONE idempotent
// payments row (collected_via=paypal, paypal_order_id set); a replayed webhook
// changes zero rows." It does NOT define a credit mint / package_purchases row
// for PayPal package purchases (unlike the Stripe webhook). So this lane is
// LEDGER-ONLY: capture -> mirrorPayPalPayment -> one payments row. No credits.
//
// Idempotency: the capture-on-return AND the PAYMENT.CAPTURE.COMPLETED webhook
// both mirror on the SAME PayPal ORDER id, so they collide on the partial unique
// index and exactly one row is written. The webhook is the belt-and-braces
// backstop behind the synchronous return capture.

const { mirrorPayPalPayment } = require("./payments");
const { CLIENT_PRICE_FIELDS } = require("./checkout");

const DEFAULT_API_BASE = "https://api-m.paypal.com"; // live; sandbox via PAYPAL_API_BASE

// Read PayPal config at CALL time (not module load), same as every other lib here
// (sb(), paypalConfig, etc.), so a test that sets env before requiring the module
// still sees it. Returns null when creds are missing => the routes fail closed.
function paypalConfig() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    base: String(process.env.PAYPAL_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, ""),
    clientId,
    clientSecret,
    webhookId: process.env.PAYPAL_WEBHOOK_ID || null,
  };
}

// ---- OAuth2 client-credentials token, cached with expiry ---------------------
let _tokenCache = { key: null, token: null, expiresAt: 0 };
// Exposed so tests can force a fresh token fetch between cases.
function __resetTokenCache() {
  _tokenCache = { key: null, token: null, expiresAt: 0 };
}

async function getAccessToken(cfg) {
  if (!cfg) throw new Error("paypal is not configured");
  const key = `${cfg.base}:${cfg.clientId}`;
  const now = Date.now();
  if (_tokenCache.token && _tokenCache.key === key && _tokenCache.expiresAt > now + 5000) {
    return _tokenCache.token;
  }
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const resp = await fetch(`${cfg.base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`paypal oauth ${resp.status}: ${detail}`);
  }
  const data = await resp.json().catch(() => ({}));
  const token = data.access_token;
  if (!token) throw new Error("paypal oauth returned no access_token");
  // expires_in is seconds (PayPal default ~9h). Cache with a 60s safety margin.
  const ttlS = Number(data.expires_in) > 0 ? Number(data.expires_in) : 32400;
  _tokenCache = { key, token, expiresAt: now + ttlS * 1000 - 60000 };
  return token;
}

// amountCents (server-authoritative) -> PayPal "value" string ("50.00").
function formatAmount(amountCents) {
  const cents = Number(amountCents);
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new Error("amountCents must be a positive integer");
  }
  return (cents / 100).toFixed(2);
}

// Create an Orders v2 order (intent CAPTURE). Amount comes from the SERVER-side
// package price only. custom_id carries the tenant context (see the handler).
// Returns { id, approveUrl, order }.
async function createOrder({
  cfg,
  amountCents,
  currency = "USD",
  customId,
  description,
  returnUrl,
  cancelUrl,
}) {
  if (!cfg) throw new Error("paypal is not configured");
  const token = await getAccessToken(cfg);
  const purchaseUnit = {
    amount: {
      currency_code: String(currency).toUpperCase(),
      value: formatAmount(amountCents),
    },
  };
  if (customId) purchaseUnit.custom_id = String(customId);
  if (description) purchaseUnit.description = String(description).slice(0, 127);

  const body = { intent: "CAPTURE", purchase_units: [purchaseUnit] };
  if (returnUrl || cancelUrl) {
    body.application_context = {
      shipping_preference: "NO_SHIPPING",
      user_action: "PAY_NOW",
    };
    if (returnUrl) body.application_context.return_url = returnUrl;
    if (cancelUrl) body.application_context.cancel_url = cancelUrl;
  }

  const resp = await fetch(`${cfg.base}/v2/checkout/orders`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`paypal create-order ${resp.status}: ${detail}`);
  }
  const order = await resp.json().catch(() => ({}));
  const approve = Array.isArray(order.links)
    ? order.links.find((l) => l && l.rel === "approve")
    : null;
  return { id: order.id || null, approveUrl: approve ? approve.href : null, order };
}

// Capture an approved order. Returns the captured order object (status COMPLETED
// on success, with purchase_units[0].payments.captures[0]).
async function captureOrder({ cfg, orderId }) {
  if (!cfg) throw new Error("paypal is not configured");
  if (!orderId) throw new Error("orderId is required");
  const token = await getAccessToken(cfg);
  const resp = await fetch(
    `${cfg.base}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    },
  );
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    const err = new Error(`paypal capture ${resp.status}: ${detail}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json().catch(() => ({}));
}

// Verify a webhook via PayPal's verify-webhook-signature endpoint. Fails CLOSED:
// returns false when the webhook id is missing or the endpoint does not answer
// SUCCESS. Never throws on a verification miss (the route maps false -> 400).
async function verifyWebhookSignature({ cfg, headers, body }) {
  if (!cfg) throw new Error("paypal is not configured");
  if (!cfg.webhookId) return false; // no webhook id => cannot verify => fail closed
  const h = headers || {};
  const get = (k) => h[k] || h[k.toLowerCase()] || h[k.toUpperCase()];
  const token = await getAccessToken(cfg);
  const webhookEvent = typeof body === "string"
    ? JSON.parse(body)
    : Buffer.isBuffer(body)
      ? JSON.parse(body.toString("utf8"))
      : body;
  const payload = {
    transmission_id: get("paypal-transmission-id"),
    transmission_time: get("paypal-transmission-time"),
    cert_url: get("paypal-cert-url"),
    auth_algo: get("paypal-auth-algo"),
    transmission_sig: get("paypal-transmission-sig"),
    webhook_id: cfg.webhookId,
    webhook_event: webhookEvent,
  };
  const resp = await fetch(`${cfg.base}/v1/notification/verify-webhook-signature`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) return false;
  const data = await resp.json().catch(() => ({}));
  return data.verification_status === "SUCCESS";
}

// Parse a raw request body (Buffer from express.raw, a string, or an object).
function parseBody(raw) {
  if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString("utf8"));
  if (typeof raw === "string") return JSON.parse(raw);
  return raw || {};
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// The tiny self-contained "done" page shown after a return capture. Matches the
// CoachTime /join interstitial brand (dark, Vegas Gold accent, Space Grotesk).
function donePage({ ok, message }) {
  const title = ok ? "Payment complete" : "Payment not complete";
  const dot = ok ? "#D4C36A" : "#8A8880";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: #0E0E0F; color: #F2F0EB;
    font-family: "Space Grotesk", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    display: flex; align-items: center; justify-content: center;
    text-align: center; padding: 24px; -webkit-font-smoothing: antialiased;
  }
  .card {
    background: #16161A; border-radius: 8px; padding: 40px 32px;
    max-width: 380px; width: 100%; box-shadow: 0 10px 40px rgba(0,0,0,0.4);
  }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: ${dot}; margin: 0 auto 20px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; letter-spacing: .2px; }
  p { font-size: 14px; line-height: 1.5; color: #B8B6B0; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <div class="dot"></div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}

/**
 * Build the PayPal route handlers. deps injects the shared primitives so the
 * routes stay testable and this module never reaches into index.js internals.
 *
 * @param {object} deps
 * @param {(req)=>Promise<{user?:object,error?:string,status?:number}>} deps.requireSupabaseUser
 * @param {(packageId:string,userId:string)=>Promise<object|null>} deps.getPackage
 *   resolves a package id to its row (id, coach_id, name, price_cents, active).
 * @param {(coachId:string)=>Promise<string|null>} deps.getCoachPaypalEmail
 *   returns the coach's paypal_email (null when the rail is not set up).
 */
function buildPaypalHandlers(deps) {
  const {
    requireSupabaseUser,
    getPackage,
    getCoachPaypalEmail,
    // Overridable for tests; default to the module-level primitives.
    mirrorPayment = mirrorPayPalPayment,
    getConfig = paypalConfig,
    getPublicUrl = () =>
      process.env.SCHEDULING_PUBLIC_URL ||
      process.env.PUBLIC_BASE_URL ||
      "https://coachtime.app",
    paypalCreateOrder = createOrder,
    paypalCaptureOrder = captureOrder,
    paypalVerifyWebhook = verifyWebhookSignature,
  } = deps || {};

  // The shared mirror step for BOTH the return capture and the webhook. coach_id
  // is resolved from the order custom_id (documented format: "<coachId>:<packageId>").
  // Idempotent on the PayPal ORDER id, so return + webhook write exactly one row.
  async function doMirror({ orderId, customId, amountVal, currency, occurredAt }) {
    if (!orderId) {
      console.error("[paypal] capture with no order id — cannot mirror");
      return;
    }
    const coachId = customId ? String(customId).split(":")[0] : null;
    if (!coachId) {
      console.error("[paypal] capture missing coach custom_id — cannot mirror:", orderId);
      return;
    }
    const cents = Math.round(Number(amountVal) * 100);
    if (!Number.isFinite(cents) || cents < 0) {
      console.error("[paypal] capture has a bad amount — cannot mirror:", orderId, amountVal);
      return;
    }
    await mirrorPayment({
      coachId,
      amount_cents: cents,
      currency: currency ? String(currency).toLowerCase() : "usd",
      collected_via: "paypal",
      paypal_order_id: orderId,
      occurred_at: occurredAt || null,
    });
  }

  // POST /paypal/create-order — field-compatible with /checkout/create-session:
  // Bearer JWT identity, packageId (never a client price), server-side amount.
  async function handleCreateOrder(req, res) {
    try {
      const cfg = getConfig();
      if (!cfg) return res.status(503).json({ error: "paypal is not configured" });

      const authd = await requireSupabaseUser(req);
      if (authd.error) return res.status(authd.status || 401).json({ error: authd.error });
      const user = authd.user;

      const bodyObj = req.body && typeof req.body === "object" ? req.body : {};
      for (const f of CLIENT_PRICE_FIELDS) {
        if (bodyObj[f] !== undefined) {
          return res.status(400).json({
            error: "amount is computed server-side; do not send a price",
          });
        }
      }
      const packageId = bodyObj.packageId || bodyObj.package_id;
      if (!packageId || typeof packageId !== "string") {
        return res.status(400).json({ error: "packageId is required" });
      }

      let pkg = null;
      try {
        pkg = await getPackage(packageId, user.id);
      } catch (err) {
        console.error("[paypal] package lookup failed:", err);
        return res.status(502).json({ error: "could not load package" });
      }
      if (!pkg) return res.status(404).json({ error: "package not found" });
      if (pkg.active === false) {
        return res.status(409).json({ error: "package is not available" });
      }

      const priceCents = Number(pkg.price_cents);
      if (!Number.isInteger(priceCents) || priceCents <= 0) {
        console.error("[paypal] package has an invalid price_cents:", pkg);
        return res.status(500).json({ error: "package is misconfigured" });
      }

      // The coach must have a PayPal email on file (money routing config, not a
      // renameable label). No paypal_email => the rail is off for this coach.
      let paypalEmail = null;
      try {
        paypalEmail = await getCoachPaypalEmail(pkg.coach_id);
      } catch (err) {
        console.error("[paypal] coach paypal_email lookup failed:", err);
        return res.status(502).json({ error: "could not load coach" });
      }
      if (!paypalEmail) {
        return res.status(409).json({ error: "paypal_not_enabled" });
      }

      const base = String(getPublicUrl()).replace(/\/+$/, "");
      let created;
      try {
        created = await paypalCreateOrder({
          cfg,
          amountCents: priceCents,
          currency: "USD",
          // Tenant context carried on the order so the async webhook (which never
          // sees the buyer JWT) can resolve the coach: "<coachId>:<packageId>".
          customId: `${pkg.coach_id}:${pkg.id}`,
          description: pkg.name || "CoachTime package",
          returnUrl: `${base}/paypal/return`,
          cancelUrl: `${base}/paypal/cancel`,
        });
      } catch (err) {
        console.error("[paypal] create order failed:", err);
        return res.status(502).json({ error: "payment provider error" });
      }
      if (!created || !created.id || !created.approveUrl) {
        return res.status(502).json({ error: "payment provider error" });
      }
      return res.json({ orderId: created.id, approveUrl: created.approveUrl });
    } catch (err) {
      console.error("[paypal] create-order error:", err);
      return res.status(500).json({ error: "create order failed" });
    }
  }

  // GET /paypal/return — PayPal redirects here with ?token=<orderId>. Capture the
  // order, mirror the payment (fail-soft: the webhook is the durable backstop),
  // and show a tiny done page.
  async function handleReturn(req, res) {
    const cfg = getConfig();
    if (!cfg) {
      return res
        .status(503)
        .type("html")
        .send(donePage({ ok: false, message: "PayPal is not set up yet." }));
    }
    const q = req.query || {};
    const orderId = q.token || q.orderId;
    if (!orderId || typeof orderId !== "string") {
      return res
        .status(400)
        .type("html")
        .send(donePage({ ok: false, message: "Missing order reference." }));
    }

    let captured;
    try {
      captured = await paypalCaptureOrder({ cfg, orderId });
    } catch (err) {
      console.error("[paypal] capture on return failed:", err);
      return res.status(502).type("html").send(
        donePage({
          ok: false,
          message: "We couldn't confirm that payment. If you were charged, it will still land.",
        }),
      );
    }

    const status = captured && captured.status ? String(captured.status) : "";
    if (status !== "COMPLETED") {
      return res.status(200).type("html").send(
        donePage({ ok: false, message: "That payment didn't go through. Please try again." }),
      );
    }

    try {
      const pu = Array.isArray(captured.purchase_units) ? captured.purchase_units[0] : null;
      const cap = pu && pu.payments && Array.isArray(pu.payments.captures)
        ? pu.payments.captures[0]
        : null;
      const amount = (cap && cap.amount) || (pu && pu.amount) || {};
      await doMirror({
        orderId: captured.id || orderId,
        customId: pu && pu.custom_id ? String(pu.custom_id) : null,
        amountVal: amount.value,
        currency: amount.currency_code,
        occurredAt: (cap && cap.create_time) || null,
      });
    } catch (err) {
      // Fail-soft: the buyer already paid and the webhook (PAYMENT.CAPTURE.COMPLETED)
      // is the belt-and-braces backstop that will mirror the same order id. Never
      // show the buyer an error for a ledger hiccup on a completed capture.
      console.error("[paypal] mirror on return (non-fatal, webhook backstops):", err);
    }
    return res
      .status(200)
      .type("html")
      .send(donePage({ ok: true, message: "You're all set. You can close this tab." }));
  }

  // POST /paypal/webhook — signature-verified. Handles PAYMENT.CAPTURE.COMPLETED
  // as the durable backstop behind the return capture. Everything else is ACK'd
  // 200 and ignored (no retry-storm).
  async function handleWebhook(req, res) {
    const cfg = getConfig();
    if (!cfg) return res.status(503).json({ error: "paypal not configured" });

    let verified = false;
    try {
      verified = await paypalVerifyWebhook({ cfg, headers: req.headers, body: req.body });
    } catch (err) {
      console.error("[paypal] webhook verify threw:", err);
      verified = false;
    }
    if (!verified) return res.status(400).json({ error: "invalid signature" });

    let event;
    try {
      event = parseBody(req.body);
    } catch (err) {
      // Verified but unparseable (should not happen). ACK so PayPal stops retrying.
      console.error("[paypal] webhook parse (non-fatal):", err);
      return res.json({ received: true });
    }

    const type = event && event.event_type;
    if (type !== "PAYMENT.CAPTURE.COMPLETED") {
      return res.json({ received: true }); // ack + ignore
    }

    try {
      const resource = (event && event.resource) || {};
      // For a capture resource, resource.id is the CAPTURE id; the ORDER id lives
      // in supplementary_data.related_ids.order_id. Use the ORDER id so this
      // collides with the return-path mirror on the partial unique index.
      const orderId =
        (resource.supplementary_data &&
          resource.supplementary_data.related_ids &&
          resource.supplementary_data.related_ids.order_id) ||
        resource.id ||
        null;
      const amount = resource.amount || {};
      await doMirror({
        orderId,
        customId: resource.custom_id ? String(resource.custom_id) : null,
        amountVal: amount.value,
        currency: amount.currency_code,
        occurredAt: resource.create_time || null,
      });
    } catch (err) {
      // R2 (throw-so-5xx-so-retry): a transient DB failure must NOT be swallowed
      // as 200. Answer 500 so PayPal redelivers; the mirror is idempotent on the
      // order id, so a redelivery that finds the row changes zero rows.
      console.error("[paypal] webhook mirror failed — signaling retry:", err);
      return res.status(500).json({ error: "webhook_handler_failed" });
    }
    return res.json({ received: true });
  }

  return { handleCreateOrder, handleReturn, handleWebhook };
}

module.exports = {
  paypalConfig,
  getAccessToken,
  createOrder,
  captureOrder,
  verifyWebhookSignature,
  buildPaypalHandlers,
  donePage,
  __resetTokenCache,
};
