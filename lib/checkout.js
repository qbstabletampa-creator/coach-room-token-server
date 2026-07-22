// lib/checkout.js
//
// Simulated-mode-first checkout, ported from little-soles'
// ls-api/src/controllers/checkout.controller.ts to this stack. The whole buy
// flow is testable end to end with NO live Stripe account: when no real
// `sk_`-prefixed key is set, we return a simulated checkout URL + clientSecret.
// The moment CJ drops a real secret key into env, the same route creates a real
// Stripe Checkout Session — no code change, no redeploy.
//
// Two hard security rules, straight from the little-soles precedent:
//   1. The SERVER computes the amount from a `packages` row (fetched via
//      Supabase). The client NEVER names its own price — a request that carries
//      an amount/price field is rejected outright.
//   2. Identity comes from the verified Supabase JWT, not the body. The buyer is
//      whoever the token says they are.
//
// The route is guarded behind CHECKOUT_ENABLED (default OFF) in index.js.

// True when no real Stripe secret key is wired up yet — a key must start with
// "sk_" (sk_test_ / sk_live_). Anything else (unset, placeholder) => simulated.
function isSimulated(key) {
  return !key || !String(key).startsWith("sk_");
}

function supabase() {
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

async function jsonRows(resp) {
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    const err = new Error(`supabase ${resp.status}: ${detail}`);
    err.status = resp.status;
    err.detail = detail;
    throw err;
  }
  return resp.json().catch(() => []);
}

async function resolveTenantAthlete(s, { userId, coachId }) {
  const resp = await fetch(
    `${s.url}/rest/v1/athletes?user_id=eq.${encodeURIComponent(userId)}` +
      `&coach_id=eq.${encodeURIComponent(coachId)}` +
      `&select=id,parent_email&limit=1`,
    { headers: s.headers },
  );
  const rows = await jsonRows(resp);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// `requestOpts` carries Stripe per-request options. For a Connect DIRECT charge
// pass { stripeAccount } so the customer is created ON the connected account
// (a platform customer id is not usable on a connected account — the
// 2026-07-22 connect e2e proved "No such customer" when a platform id was
// replayed against a connected account). The two lanes NEVER share mapping
// rows: platform customers stay in stripe_customers (whose exact
// (coach_id, athlete_id) unique shape is load-bearing for protection.js's
// on_conflict upsert and billing.js), and connected customers live in the
// account-scoped stripe_connect_customers (migration 0034).
async function getOrCreateStripeCustomer(s, stripe, { coachId, athleteId, email }, requestOpts = {}) {
  const stripeAccount = requestOpts.stripeAccount || null;
  const table = stripeAccount ? "stripe_connect_customers" : "stripe_customers";
  const accountFilter = stripeAccount
    ? `&stripe_account_id=eq.${encodeURIComponent(stripeAccount)}`
    : "";
  const query =
    `${s.url}/rest/v1/${table}?coach_id=eq.${encodeURIComponent(coachId)}` +
    `&athlete_id=eq.${encodeURIComponent(athleteId)}${accountFilter}` +
    `&select=stripe_customer_id&limit=1`;
  let rows = await jsonRows(await fetch(query, { headers: s.headers }));
  if (Array.isArray(rows) && rows[0]) return rows[0].stripe_customer_id;

  const customer = await stripe.customers.create(
    {
      email: email || undefined,
      metadata: { coach_id: String(coachId), athlete_id: String(athleteId) },
    },
    {
      // The idempotency key carries the account context: the same
      // (coach, athlete) pair legitimately creates ONE customer per account.
      idempotencyKey:
        `stripe-customer:${coachId}:${athleteId}` +
        (stripeAccount ? `:${stripeAccount}` : ""),
      ...requestOpts,
    },
  );
  const insert = await fetch(`${s.url}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...s.headers, prefer: "return=minimal" },
    body: JSON.stringify({
      coach_id: coachId,
      athlete_id: athleteId,
      stripe_customer_id: customer.id,
      email: email || null,
      ...(stripeAccount ? { stripe_account_id: stripeAccount } : {}),
    }),
  });
  if (insert.ok) return customer.id;
  const detail = await insert.text().catch(() => "");
  if (insert.status !== 409 && !detail.includes("23505")) {
    throw new Error(`stripe customer mapping ${insert.status}: ${detail}`);
  }
  rows = await jsonRows(await fetch(query, { headers: s.headers }));
  if (Array.isArray(rows) && rows[0]) return rows[0].stripe_customer_id;
  throw new Error("stripe customer mapping race could not be repaired");
}

// Field names a client must never send: the price is server-authoritative.
const CLIENT_PRICE_FIELDS = [
  "amount",
  "amountCents",
  "price",
  "priceCents",
  "unitAmount",
  "unit_amount",
  "total",
  "totalCents",
];

/**
 * Build the POST /checkout/create-session handler. Dependencies are injected so
 * the route stays testable (the harness drives the real Express app and mocks
 * global.fetch used by requireSupabaseUser + getPackage).
 *
 * @param {object} deps
 * @param {(req) => Promise<{user?:object,error?:string,status?:number}>} deps.requireSupabaseUser
 *        the same JWT primitive index.js uses everywhere.
 * @param {(packageId:string,userId:string) => Promise<object|null>} deps.getPackage
 *        resolves a package id to its row ({ id, name, price_cents, active }) or null.
 * @param {() => (string|undefined)} [deps.getStripeSecretKey]
 *        reads the current STRIPE_SECRET_KEY (call-time so tests can vary it).
 * @param {() => {successUrl:string,cancelUrl:string}} [deps.getUrls]
 */
function createSessionHandler(deps) {
  const {
    requireSupabaseUser,
    getPackage,
    getStripeSecretKey = () => process.env.STRIPE_SECRET_KEY,
    getUrls = () => ({
      successUrl:
        process.env.CHECKOUT_SUCCESS_URL || "https://coachtime.app/checkout/success",
      cancelUrl:
        process.env.CHECKOUT_CANCEL_URL || "https://coachtime.app/checkout/cancel",
    }),
    billingEnabled = false,
    getStripeClient = (key) => {
      const Stripe = require("stripe");
      return new Stripe(key);
    },
    // Connect routing. Returns { accountId, chargesEnabled } to route a DIRECT
    // charge, or null to use the platform account. Default delegates to
    // lib/stripe-connect (which itself returns null unless CONNECT_ENABLED is on
    // AND the coach has an 'enabled' connected account). Injected for tests.
    resolveConnectRouting = (coachId) => {
      const { routingForCheckout } = require("./stripe-connect");
      return routingForCheckout({ coachId });
    },
  } = deps;

  return async function createSession(req, res) {
    try {
      // ---- AUTH: identity from the verified JWT, never the body ------------
      const authd = await requireSupabaseUser(req);
      if (authd.error) {
        return res.status(authd.status || 401).json({ error: authd.error });
      }
      const user = authd.user;

      const bodyObj = req.body && typeof req.body === "object" ? req.body : {};

      // ---- REJECT any client-supplied price -------------------------------
      // The server is the sole source of the amount. If the client tries to
      // name a price, refuse the whole request (don't silently ignore it).
      for (const f of CLIENT_PRICE_FIELDS) {
        if (bodyObj[f] !== undefined) {
          return res.status(400).json({
            error: "amount is computed server-side; do not send a price",
          });
        }
      }

      // ---- Resolve the package (the ONLY thing the client picks) ----------
      const packageId = bodyObj.packageId || bodyObj.package_id;
      if (!packageId || typeof packageId !== "string") {
        return res.status(400).json({ error: "packageId is required" });
      }

      let pkg = null;
      try {
        pkg = await getPackage(packageId, user.id);
      } catch (err) {
        console.error("[checkout] package lookup failed:", err);
        return res.status(502).json({ error: "could not load package" });
      }
      if (!pkg) {
        return res.status(404).json({ error: "package not found" });
      }
      if (pkg.active === false) {
        return res.status(409).json({ error: "package is not available" });
      }

      const billingType = pkg.billing_type || "one_time";
      if (!new Set(["one_time", "subscription", "installment"]).has(billingType)) {
        return res.status(500).json({ error: "package is misconfigured" });
      }
      if (billingType !== "one_time" && !billingEnabled) {
        return res.status(404).json({ error: "billing_not_enabled" });
      }

      const packagePriceCents = Number(pkg.price_cents);
      if (!Number.isInteger(packagePriceCents) || packagePriceCents <= 0) {
        console.error("[checkout] package has an invalid price_cents:", pkg);
        return res.status(500).json({ error: "package is misconfigured" });
      }
      const installmentsTotal = billingType === "installment"
        ? Number(pkg.installment_count)
        : null;
      if (
        billingType === "installment" &&
        (!Number.isInteger(installmentsTotal) || installmentsTotal < 2 || installmentsTotal > 24)
      ) {
        return res.status(500).json({ error: "package is misconfigured" });
      }
      if (billingType === "installment" && packagePriceCents % installmentsTotal !== 0) {
        return res.status(400).json({ error: "installment_price_not_divisible" });
      }
      const billingInterval = billingType === "one_time" ? null : pkg.billing_interval;
      if (billingType !== "one_time" && !new Set(["week", "month"]).has(billingInterval)) {
        return res.status(500).json({ error: "package is misconfigured" });
      }
      const amountCents = billingType === "installment"
        ? packagePriceCents / installmentsTotal
        : packagePriceCents;

      const { successUrl, cancelUrl } = getUrls();
      const stripeSecretKey = getStripeSecretKey();

      // ---- SIMULATED mode: stable, fake, fully testable -------------------
      if (isSimulated(stripeSecretKey)) {
        return res.json({
          simulated: true,
          url: `${successUrl}?session_id=cs_simulated_${encodeURIComponent(
            packageId,
          )}`,
          sessionId: `cs_simulated_${packageId}`,
          clientSecret: null,
          amountCents,
          packageId: pkg.id,
          billing_type: billingType,
          billing_interval: billingInterval,
          installments_total: installmentsTotal,
        });
      }

      // ---- REAL mode: create a Stripe Checkout Session --------------------
      try {
        const stripe = getStripeClient(stripeSecretKey);
        const s = supabase();
        if (!s) return res.status(500).json({ error: "checkout is not configured" });
        const athlete = await resolveTenantAthlete(s, {
          userId: user.id,
          coachId: pkg.coach_id,
        });
        if (!athlete) return res.status(403).json({ error: "athlete_not_in_tenant" });
        const email = String(user.email || athlete.parent_email || "").trim().toLowerCase() || null;

        // ---- Connect routing: DIRECT charge on the coach's connected account --
        // When CONNECT_ENABLED and the coach has an 'enabled' connected account,
        // the coach is the merchant of record: create the customer AND the session
        // on the connected account via the stripeAccount per-request option. Any
        // failure to resolve routing falls OPEN to the platform account so a
        // routing hiccup never blocks a sale (platform behavior is unchanged when
        // the flag is off or there is no connected account).
        let stripeAccount = null;
        try {
          const routing = await resolveConnectRouting(pkg.coach_id);
          if (routing && routing.accountId && routing.chargesEnabled === true) {
            stripeAccount = routing.accountId;
          }
        } catch (err) {
          console.error("[checkout] connect routing failed (fall back to platform):", err);
        }
        const requestOpts = stripeAccount ? { stripeAccount } : {};

        const customer = await getOrCreateStripeCustomer(
          s,
          stripe,
          { coachId: pkg.coach_id, athleteId: athlete.id, email },
          requestOpts,
        );
        const sessionMetadata = {
          package_id: String(pkg.id),
          coach_id: String(pkg.coach_id),
          athlete_id: String(athlete.id),
          user_id: String(user.id),
          billing_type: billingType,
        };
        const params = {
          mode: billingType === "one_time" ? "payment" : "subscription",
          customer,
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: { name: pkg.name || "CoachTime package" },
                unit_amount: amountCents,
                ...(billingType === "one_time"
                  ? {}
                  : { recurring: { interval: billingInterval } }),
              },
              quantity: 1,
            },
          ],
          success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: cancelUrl,
          client_reference_id: user.id,
          metadata: sessionMetadata,
        };
        if (billingType !== "one_time") {
          params.subscription_data = {
            metadata: {
              package_id: String(pkg.id),
              coach_id: String(pkg.coach_id),
              athlete_id: String(athlete.id),
              billing_type: billingType,
              installments_total: billingType === "installment" ? String(installmentsTotal) : "",
              max_cycles: billingType === "installment"
                ? String(installmentsTotal)
                : (pkg.max_cycles == null ? "" : String(pkg.max_cycles)),
              carry_forward: pkg.carry_forward === true ? "true" : "false",
              grace_days: String(pkg.grace_days == null ? 3 : pkg.grace_days),
            },
          };
          if (Number(pkg.trial_days) > 0) {
            params.subscription_data.trial_period_days = Number(pkg.trial_days);
          }
        }
        // stripe-node rejects an EMPTY options object ("Unknown arguments",
        // proven live 2026-07-22 e2e) — pass options ONLY on the connected
        // path. The platform path stays the exact pre-Connect single-arg call.
        const session = stripeAccount
          ? await stripe.checkout.sessions.create(params, requestOpts)
          : await stripe.checkout.sessions.create(params);
        return res.json({
          simulated: false,
          connected: !!stripeAccount,
          url: session.url,
          sessionId: session.id,
          clientSecret: session.client_secret || null,
          amountCents,
          packageId: pkg.id,
          billing_type: billingType,
          billing_interval: billingInterval,
          installments_total: installmentsTotal,
        });
      } catch (err) {
        console.error("[checkout] Stripe session create failed:", err);
        return res.status(502).json({ error: "payment provider error" });
      }
    } catch (err) {
      console.error("[checkout] create-session error:", err);
      return res.status(500).json({ error: "checkout failed" });
    }
  };
}

module.exports = {
  isSimulated,
  createSessionHandler,
  CLIENT_PRICE_FIELDS,
  getOrCreateStripeCustomer,
  resolveTenantAthlete,
};
