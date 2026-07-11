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
 * @param {(packageId:string) => Promise<object|null>} deps.getPackage
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
        pkg = await getPackage(packageId);
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

      // Server-computed amount. Never from the client.
      const amountCents = Number(pkg.price_cents);
      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        console.error("[checkout] package has an invalid price_cents:", pkg);
        return res.status(500).json({ error: "package is misconfigured" });
      }

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
          clientSecret: `cs_simulated_${packageId}_secret`,
          amountCents,
          packageId: pkg.id,
        });
      }

      // ---- REAL mode: create a Stripe Checkout Session --------------------
      try {
        // Lazy require so simulated mode (and the tests) never load the SDK.
        const Stripe = require("stripe");
        const stripe = new Stripe(stripeSecretKey);
        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: { name: pkg.name || "CoachTime package" },
                unit_amount: amountCents,
              },
              quantity: 1,
            },
          ],
          success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: cancelUrl,
          client_reference_id: user.id,
          metadata: { packageId: pkg.id, userId: user.id },
        });
        return res.json({
          simulated: false,
          url: session.url,
          sessionId: session.id,
          clientSecret: session.client_secret || null,
          amountCents,
          packageId: pkg.id,
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

module.exports = { isSimulated, createSessionHandler, CLIENT_PRICE_FIELDS };
