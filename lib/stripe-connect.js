// lib/stripe-connect.js
//
// Stripe Connect Standard for CoachTime. Each coach connects their OWN Stripe
// account and is the merchant of record: money settles into the coach's balance,
// the coach owns payouts, disputes, refunds, and Stripe issues the 1099-K to the
// coach — never to CoachTime. We route Checkout Sessions to the connected account
// as DIRECT charges (no application fee, no destination transfer). This is the
// Connect fork the universal-payments spec picked (Model B).
//
// SDK CHOICE (documented, per the spec's "confirm legacy Standard vs Accounts v2"):
//   The installed SDK is stripe@17.7.0, which exposes `accounts` + `accountLinks`
//   (legacy Standard onboarding) and does NOT ship the Accounts v2 API (that is
//   stripe SDK 18+/newer API versions). So we use LEGACY STANDARD onboarding:
//     - stripe.accounts.create({ type: "standard" })
//     - stripe.accountLinks.create({ type: "account_onboarding" })
//     - stripe.accounts.retrieve(acct)  (charges_enabled / details_submitted / payouts_enabled)
//   When CJ later moves to Accounts v2, only this module changes.
//
// SIMULATED-FIRST (same philosophy as lib/checkout.js): when no real `sk_`-prefixed
// secret key is set, every function returns stable fake ids/links and persists
// status, so the whole connect flow is testable end to end with NO Stripe account.
// The moment a real key lands in env, the same code calls Stripe for real.
//
// DEFAULT-ON FLAG (CJ 2026-07-22 live-not-gated): CONNECT_ENABLED is enabled
// unless env sets it to "0"/"false" — see connectEnabled(). The check is
// exported so index.js gates route mounting with the SAME semantics;
// checkout.js and the webhook also consult it so the emergency-off switch
// darkens money routing and connected events together, never a split.
//
// CONTRACT coded against (migration 0033; the column is unconstrained text —
// the migration comment's "pending / active / restricted" examples predate
// this domain and the real one is below):
//   coaches.stripe_account_id text   — the connected account id (acct_...)
//   coaches.connect_status     text  — one of: 'pending' | 'restricted' | 'enabled' | 'disabled'
//                                       ('none' is the API status for no account, never persisted)
//                                       'pending'    = created / onboarding unfinished (no charges yet)
//                                       'restricted' = submitted but not charge-enabled, or a
//                                                      Stripe requirements.disabled_reason is set
//                                       'enabled'    = charges_enabled === true (eligible to collect)
//                                       'disabled'   = account disabled by Stripe
//   coaches.id === the coach's Supabase auth user id (house convention).

// True when no real Stripe secret key is wired up yet — a key must start with
// "sk_" (sk_test_ / sk_live_). Anything else (unset, placeholder) => simulated.
function isSimulated(key) {
  return !key || !String(key).startsWith("sk_");
}

// The lane flag, DEFAULT-ON (CJ 2026-07-22 live-not-gated): identical semantics
// to index.js's envFlagDefaultOn — enabled unless env explicitly sets "0"/"false"
// (the emergency off switch). MUST stay in lockstep with the index.js mount gate:
// a split (routes mounted but routing/webhook dark) silently sends coach money to
// the PLATFORM account while the UI reads connected — the exact C1 the 2026-07-22
// adversarial verify blocked on. Read at CALL time so tests/env flips apply.
function connectEnabled() {
  const v = process.env.CONNECT_ENABLED;
  return !(v === "0" || v === "false");
}

// Supabase service client, read at CALL time (matches checkout.js / stripe-webhook.js
// so a test that sets env before requiring index.js still sees the creds).
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

function defaultGetStripeSecretKey() {
  return process.env.STRIPE_SECRET_KEY;
}

function defaultGetStripeClient(key) {
  const Stripe = require("stripe");
  return new Stripe(key);
}

function defaultGetUrls() {
  return {
    refreshUrl:
      process.env.CONNECT_REFRESH_URL || "https://coachtime.app/connect/refresh",
    returnUrl:
      process.env.CONNECT_RETURN_URL || "https://coachtime.app/connect/return",
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

// Map a Stripe account object to our stored status + the raw booleans. charges
// is the money gate; details-without-charges is 'restricted'; neither is 'pending'.
function statusFromAccount(acct) {
  const a = acct || {};
  const charges = a.charges_enabled === true;
  const details = a.details_submitted === true;
  const payouts = a.payouts_enabled === true;
  let status;
  if (charges) status = "enabled";
  else if (details) status = "restricted";
  else status = "pending";
  return {
    status,
    charges_enabled: charges,
    details_submitted: details,
    payouts_enabled: payouts,
  };
}

// Read the coach's connect row. Returns { accountId, connectStatus } or null when
// the coach row is missing. accountId/connectStatus are null when never onboarded.
async function readCoachConnect(s, coachId) {
  const resp = await fetch(
    `${s.url}/rest/v1/coaches?id=eq.${encodeURIComponent(coachId)}` +
      `&select=id,stripe_account_id,connect_status&limit=1`,
    { headers: s.headers },
  );
  const rows = await jsonRows(resp);
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!row) return null;
  return {
    accountId: row.stripe_account_id || null,
    connectStatus: row.connect_status || null,
  };
}

// Persist the connect fields on the coach row. Only sets keys that are provided.
async function writeCoachConnect(s, coachId, fields) {
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(fields, "stripe_account_id")) {
    patch.stripe_account_id = fields.stripe_account_id;
  }
  if (Object.prototype.hasOwnProperty.call(fields, "connect_status")) {
    patch.connect_status = fields.connect_status;
  }
  if (Object.keys(patch).length === 0) return;
  const resp = await fetch(
    `${s.url}/rest/v1/coaches?id=eq.${encodeURIComponent(coachId)}`,
    {
      method: "PATCH",
      headers: { ...s.headers, prefer: "return=minimal" },
      body: JSON.stringify(patch),
    },
  );
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`coach connect PATCH failed: ${resp.status} ${detail}`);
  }
}

// ---- createConnectAccount --------------------------------------------------
// Create (or reuse) the coach's connected Standard account and persist its id.
// Idempotent: a coach that already carries a stripe_account_id gets it back,
// never a second account. Simulated mode mints a stable fake id.
async function createConnectAccount({ coachId } = {}, deps = {}) {
  const {
    getStripeSecretKey = defaultGetStripeSecretKey,
    getStripeClient = defaultGetStripeClient,
  } = deps;
  if (!coachId) throw new Error("coachId is required");
  const s = supabase();
  if (!s) throw new Error("connect is not configured");

  const existing = await readCoachConnect(s, coachId);
  if (existing && existing.accountId) {
    return {
      accountId: existing.accountId,
      connectStatus: existing.connectStatus || "pending",
      reused: true,
      simulated: isSimulated(getStripeSecretKey()),
    };
  }

  const key = getStripeSecretKey();
  if (isSimulated(key)) {
    const accountId = `acct_sim_${String(coachId).replace(/-/g, "").slice(0, 16)}`;
    await writeCoachConnect(s, coachId, {
      stripe_account_id: accountId,
      connect_status: "pending",
    });
    return { accountId, connectStatus: "pending", reused: false, simulated: true };
  }

  const stripe = getStripeClient(key);
  const account = await stripe.accounts.create({
    type: "standard",
    metadata: { coach_id: String(coachId) },
  });
  await writeCoachConnect(s, coachId, {
    stripe_account_id: account.id,
    connect_status: "pending",
  });
  return { accountId: account.id, connectStatus: "pending", reused: false, simulated: false };
}

// ---- createOnboardingLink --------------------------------------------------
// Return a hosted onboarding URL for the coach. Creates the account first if the
// coach has none (so the app can call one endpoint). account_onboarding link.
async function createOnboardingLink({ coachId } = {}, deps = {}) {
  const {
    getStripeSecretKey = defaultGetStripeSecretKey,
    getStripeClient = defaultGetStripeClient,
    getUrls = defaultGetUrls,
  } = deps;
  if (!coachId) throw new Error("coachId is required");

  const created = await createConnectAccount({ coachId }, deps);
  const accountId = created.accountId;
  const { refreshUrl, returnUrl } = getUrls();
  const key = getStripeSecretKey();

  if (isSimulated(key)) {
    return {
      accountId,
      url: `${refreshUrl}?simulated_onboarding=1&acct=${encodeURIComponent(accountId)}`,
      simulated: true,
    };
  }

  const stripe = getStripeClient(key);
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: "account_onboarding",
  });
  return { accountId, url: link.url, simulated: false };
}

// ---- getConnectStatus ------------------------------------------------------
// Read the connected account's live capabilities from Stripe, persist the mapped
// connect_status on the coach row, and return the booleans. No account => 'none'.
// Simulated mode returns the stored status without a Stripe round-trip.
async function getConnectStatus({ coachId } = {}, deps = {}) {
  const {
    getStripeSecretKey = defaultGetStripeSecretKey,
    getStripeClient = defaultGetStripeClient,
  } = deps;
  if (!coachId) throw new Error("coachId is required");
  const s = supabase();
  if (!s) throw new Error("connect is not configured");

  const existing = await readCoachConnect(s, coachId);
  const accountId = existing && existing.accountId;
  if (!accountId) {
    return {
      accountId: null,
      status: "none",
      charges_enabled: false,
      details_submitted: false,
      payouts_enabled: false,
    };
  }

  const key = getStripeSecretKey();
  if (isSimulated(key)) {
    const status = (existing && existing.connectStatus) || "pending";
    return {
      accountId,
      status,
      charges_enabled: status === "enabled",
      details_submitted: status === "enabled" || status === "restricted",
      payouts_enabled: status === "enabled",
    };
  }

  const stripe = getStripeClient(key);
  const account = await stripe.accounts.retrieve(accountId);
  const mapped = statusFromAccount(account);
  await writeCoachConnect(s, coachId, { connect_status: mapped.status });
  return { accountId, ...mapped };
}

// ---- handleAccountUpdated (webhook: account.updated) -----------------------
// Refresh the stored connect_status from the account object Stripe delivered.
// Resolves the coach by the connected account id (event.account for connected
// events, or the object id). Unknown account => safe no-op. Never throws for a
// missing match; only a hard DB write failure propagates (route -> 500 -> retry).
async function handleAccountUpdated(event) {
  const s = supabase();
  if (!s) return; // no DB (dev/test without creds) — nothing to refresh.
  const account = (event && event.data && event.data.object) || {};
  const accountId =
    (event && event.account) || (account && account.id) || null;
  if (!accountId) return;

  const mapped = statusFromAccount(account);
  const resp = await fetch(
    `${s.url}/rest/v1/coaches?stripe_account_id=eq.${encodeURIComponent(accountId)}`,
    {
      method: "PATCH",
      headers: { ...s.headers, prefer: "return=minimal" },
      body: JSON.stringify({ connect_status: mapped.status }),
    },
  );
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`account.updated PATCH failed: ${resp.status} ${detail}`);
  }
}

// ---- routingForCheckout (consumed by lib/checkout.js) ----------------------
// Decide whether a given coach's checkout should route to a connected account.
// Returns { accountId, chargesEnabled } or null. null means "use the platform
// account" (flag off, no account, or DB/coach missing => fail OPEN to platform,
// exactly the unchanged behavior the spec requires when there's no connected
// account). Only { chargesEnabled: true } routes a DIRECT charge.
async function routingForCheckout({ coachId } = {}) {
  if (!connectEnabled()) return null;
  if (!coachId) return null;
  const s = supabase();
  if (!s) return null;
  let row;
  try {
    row = await readCoachConnect(s, coachId);
  } catch (err) {
    // A read failure must NEVER block a platform checkout. Fail open.
    console.error("[stripeConnect] routingForCheckout read failed (fail-open to platform):", err);
    return null;
  }
  if (!row || !row.accountId) return null;
  return {
    accountId: row.accountId,
    chargesEnabled: row.connectStatus === "enabled",
  };
}

// ---- Express route handlers (mounted by index.js behind CONNECT_ENABLED) ---
// Coach-authed: identity from the verified Supabase JWT, and app_metadata.role
// must be "coach" (same posture as POST /data). coachId === the coach's user id.
//
// Route shapes (PM mounts these):
//   POST /connect/account          -> { accountId, connectStatus, reused }
//   POST /connect/onboarding-link  -> { accountId, url }
//   GET  /connect/status           -> { accountId, status, charges_enabled, details_submitted, payouts_enabled }
function createConnectHandlers(deps = {}) {
  const { requireSupabaseUser } = deps;
  if (typeof requireSupabaseUser !== "function") {
    throw new Error("createConnectHandlers requires requireSupabaseUser");
  }

  async function requireCoach(req, res) {
    const authd = await requireSupabaseUser(req);
    if (authd.error) {
      res.status(authd.status || 401).json({ error: authd.error });
      return null;
    }
    if (authd.user.app_metadata?.role !== "coach") {
      res.status(403).json({ error: "coach role required" });
      return null;
    }
    return authd.user;
  }

  return {
    async createAccount(req, res) {
      try {
        const user = await requireCoach(req, res);
        if (!user) return;
        const out = await createConnectAccount({ coachId: user.id }, deps);
        return res.json({
          accountId: out.accountId,
          connectStatus: out.connectStatus,
          reused: out.reused === true,
        });
      } catch (err) {
        console.error("[connect] create account failed:", err);
        return res.status(502).json({ error: "connect provider error" });
      }
    },

    async onboardingLink(req, res) {
      try {
        const user = await requireCoach(req, res);
        if (!user) return;
        const out = await createOnboardingLink({ coachId: user.id }, deps);
        return res.json({ accountId: out.accountId, url: out.url });
      } catch (err) {
        console.error("[connect] onboarding link failed:", err);
        return res.status(502).json({ error: "connect provider error" });
      }
    },

    async status(req, res) {
      try {
        const user = await requireCoach(req, res);
        if (!user) return;
        const out = await getConnectStatus({ coachId: user.id }, deps);
        return res.json(out);
      } catch (err) {
        console.error("[connect] status failed:", err);
        return res.status(502).json({ error: "connect provider error" });
      }
    },
  };
}

module.exports = {
  connectEnabled,
  isSimulated,
  statusFromAccount,
  createConnectAccount,
  createOnboardingLink,
  getConnectStatus,
  handleAccountUpdated,
  routingForCheckout,
  createConnectHandlers,
};
