const { notify: defaultNotify } = require("./notify");
const { mirrorStripePayment: defaultMirrorStripePayment } = require("./payments");

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ACTIVE_STATES = new Set(["active", "trialing", "past_due", "paused"]);
const TERMINAL_STRIPE_STATES = new Set(["unpaid", "canceled"]);

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

async function checked(resp, method) {
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    const err = new Error(`supabase ${method} ${resp.status}: ${detail}`);
    err.status = resp.status;
    err.detail = detail;
    throw err;
  }
  return resp;
}

async function sbGet(s, query) {
  const resp = await checked(
    await fetch(`${s.url}/rest/v1/${query}`, { headers: s.headers }),
    "GET",
  );
  return resp.json().catch(() => []);
}

async function sbPost(s, table, body, { upsert = false } = {}) {
  const resp = await fetch(`${s.url}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      ...s.headers,
      prefer: upsert
        ? "resolution=merge-duplicates,return=representation"
        : "return=representation",
    },
    body: JSON.stringify(body),
  });
  await checked(resp, "POST");
  return resp.json().catch(() => []);
}

async function sbPatch(s, query, body) {
  const resp = await checked(
    await fetch(`${s.url}/rest/v1/${query}`, {
      method: "PATCH",
      headers: { ...s.headers, prefer: "return=representation" },
      body: JSON.stringify(body),
    }),
    "PATCH",
  );
  return resp.json().catch(() => []);
}

async function sbRpc(s, name, body) {
  const resp = await checked(
    await fetch(`${s.url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: s.headers,
      body: JSON.stringify(body),
    }),
    "RPC",
  );
  return resp.json();
}

function stripeClient(override) {
  if (override) return override;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !String(key).startsWith("sk_")) return null;
  const Stripe = require("stripe");
  return new Stripe(key);
}

function first(rows) {
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function isoFromSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

function subscriptionDto(row) {
  const packageRow = Array.isArray(row.packages) ? row.packages[0] : row.packages;
  const athleteRow = Array.isArray(row.athletes) ? row.athletes[0] : row.athletes;
  return {
    id: row.id,
    package_id: row.package_id || null,
    package_name: packageRow?.name || row.package_name || null,
    athlete_id: row.athlete_id || null,
    athlete_name: athleteRow?.name || row.athlete_name || null,
    purchaser_email: row.purchaser_email,
    billing_type: row.billing_type,
    status: row.status,
    cycles_completed: Number(row.cycles_completed || 0),
    max_cycles: row.max_cycles == null ? null : Number(row.max_cycles),
    current_period_end: row.current_period_end || null,
    grace_until: row.grace_until || null,
    cancel_at_period_end: row.cancel_at_period_end === true,
  };
}

const DTO_SELECT =
  "id,package_id,athlete_id,purchaser_email,billing_type,status,cycles_completed," +
  "max_cycles,current_period_end,grace_until,cancel_at_period_end,stripe_subscription_id," +
  "packages(name),athletes(name,user_id,parent_email)";

async function loadEnrollment(s, coachId, id) {
  return first(await sbGet(
    s,
    `billing_subscriptions?id=eq.${encodeURIComponent(id)}` +
      `&coach_id=eq.${encodeURIComponent(coachId)}&select=${DTO_SELECT}&limit=1`,
  ));
}

async function expireActiveCredits(s, enrollment) {
  const packs = await sbGet(
    s,
    `package_purchases?coach_id=eq.${encodeURIComponent(enrollment.coach_id)}` +
      `&subscription_id=eq.${encodeURIComponent(enrollment.id)}` +
      `&status=eq.active&credits_remaining=gt.0` +
      `&select=id,credits_remaining`,
  );
  for (const pack of Array.isArray(packs) ? packs : []) {
    const amount = Number(pack.credits_remaining);
    if (!(amount > 0)) continue;
    const updated = await sbPatch(
      s,
      `package_purchases?id=eq.${encodeURIComponent(pack.id)}` +
        `&coach_id=eq.${encodeURIComponent(enrollment.coach_id)}` +
        `&status=eq.active&credits_remaining=eq.${amount}`,
      { credits_remaining: 0, status: "expired" },
    );
    if (!first(updated)) continue;
    await sbPost(s, "credit_deductions", {
      coach_id: enrollment.coach_id,
      purchase_id: pack.id,
      slot_id: null,
      action: "expire",
      amount,
      reason: "billing_canceled",
    });
  }
}

function buildBillingHandlers(deps = {}) {
  const requireSupabaseUser = deps.requireSupabaseUser;
  const getStripeClient = deps.getStripeClient || (() => stripeClient());

  async function coach(req, res) {
    const authd = await requireSupabaseUser(req);
    if (authd.error) {
      res.status(authd.status || 401).json({ error: authd.error });
      return null;
    }
    if (authd.user?.app_metadata?.role !== "coach") {
      res.status(403).json({ error: "coach_access_required" });
      return null;
    }
    return authd.user;
  }

  async function getSubscriptions(req, res) {
    try {
      const user = await coach(req, res);
      if (!user) return;
      const s = sb();
      if (!s) return res.status(503).json({ error: "billing_not_configured" });
      const rows = await sbGet(
        s,
        `billing_subscriptions?coach_id=eq.${encodeURIComponent(user.id)}` +
          `&select=${DTO_SELECT}&order=current_period_end.asc.nullslast,created_at.desc`,
      );
      return res.json({ subscriptions: (Array.isArray(rows) ? rows : []).map(subscriptionDto) });
    } catch (err) {
      console.error("[billing] list failed:", err);
      return res.status(500).json({ error: "internal_error" });
    }
  }

  async function action(req, res, kind) {
    try {
      const user = await coach(req, res);
      if (!user) return;
      const id = req.body?.subscription_id;
      if (!UUID_RE.test(String(id || ""))) {
        return res.status(400).json({ error: "invalid_subscription_id" });
      }
      const when = req.body?.when == null ? "period_end" : req.body.when;
      if (kind === "cancel" && !new Set(["period_end", "now"]).has(when)) {
        return res.status(400).json({ error: "invalid_when" });
      }
      const s = sb();
      if (!s) return res.status(503).json({ error: "billing_not_configured" });
      const enrollment = await loadEnrollment(s, user.id, id);
      if (!enrollment) return res.status(404).json({ error: "subscription_not_found" });

      const stripe = getStripeClient();
      if (!stripe) return res.status(503).json({ error: "billing_not_configured" });
      let patch;
      let expireNow = false;
      try {
        if (kind === "pause") {
          if (!ACTIVE_STATES.has(enrollment.status) || enrollment.status === "paused") {
            return res.status(409).json({ error: "invalid_subscription_state" });
          }
          await stripe.subscriptions.update(enrollment.stripe_subscription_id, {
            pause_collection: { behavior: "void" },
          });
          patch = { status: "paused" };
        } else if (kind === "resume") {
          if (enrollment.status !== "paused") {
            return res.status(409).json({ error: "invalid_subscription_state" });
          }
          const updated = await stripe.subscriptions.update(
            enrollment.stripe_subscription_id,
            { pause_collection: "" },
          );
          patch = { status: updated.status === "trialing" ? "trialing" : "active" };
        } else {
          if (!ACTIVE_STATES.has(enrollment.status)) {
            return res.status(409).json({ error: "invalid_subscription_state" });
          }
          if (when === "period_end") {
            await stripe.subscriptions.update(enrollment.stripe_subscription_id, {
              cancel_at_period_end: true,
            });
            patch = { cancel_at_period_end: true };
          } else {
            await stripe.subscriptions.cancel(enrollment.stripe_subscription_id);
            expireNow = true;
            patch = { status: "canceled", cancel_at_period_end: false };
          }
        }
      } catch (err) {
        console.error(`[billing] Stripe ${kind} failed:`, err);
        return res.status(502).json({ error: "payment_provider_error" });
      }
      if (expireNow) {
        await expireActiveCredits(s, { ...enrollment, coach_id: user.id });
      }
      await sbPatch(
        s,
        `billing_subscriptions?id=eq.${encodeURIComponent(id)}` +
          `&coach_id=eq.${encodeURIComponent(user.id)}`,
        { ...patch, updated_at: new Date().toISOString() },
      );
      const updated = await loadEnrollment(s, user.id, id);
      return res.json({ subscription: subscriptionDto(updated) });
    } catch (err) {
      console.error(`[billing] ${kind} failed:`, err);
      return res.status(500).json({ error: "internal_error" });
    }
  }

  return {
    getSubscriptions,
    postPause: (req, res) => action(req, res, "pause"),
    postResume: (req, res) => action(req, res, "resume"),
    postCancel: (req, res) => action(req, res, "cancel"),
  };
}

async function expandedSubscription(invoiceOrSession, stripe) {
  // Classic API versions put the subscription id at invoice.subscription; the
  // basil versions (2025+) move it to invoice.parent.subscription_details.
  // Live proof 2026-07-16: this account sends ONLY the basil shape — a real
  // invoice.paid failed here while every classic-shaped test passed. Read both.
  const value =
    invoiceOrSession.subscription ??
    invoiceOrSession?.parent?.subscription_details?.subscription;
  if (value && typeof value === "object") return value;
  if (!value || !stripe) return null;
  return stripe.subscriptions.retrieve(String(value));
}

function metadataOf(subscription, fallback = {}) {
  return { ...(fallback || {}), ...((subscription && subscription.metadata) || {}) };
}

async function ensureCustomerMapping(s, { coachId, athleteId, customerId, email }) {
  if (!customerId) throw new Error("billing event missing Stripe customer");
  const rows = await sbGet(
    s,
    `stripe_customers?coach_id=eq.${encodeURIComponent(coachId)}` +
      `&athlete_id=eq.${encodeURIComponent(athleteId)}` +
      `&select=stripe_customer_id&limit=1`,
  );
  if (first(rows)) return first(rows).stripe_customer_id;
  try {
    await sbPost(s, "stripe_customers", {
      coach_id: coachId,
      athlete_id: athleteId,
      stripe_customer_id: customerId,
      email: email || null,
    });
  } catch (err) {
    if (err.status !== 409 && !String(err.detail).includes("23505")) throw err;
  }
  return customerId;
}

async function ensureEnrollment(s, subscription, fallback = {}) {
  const md = metadataOf(subscription, fallback.metadata);
  const coachId = md.coach_id;
  const athleteId = md.athlete_id;
  const packageId = md.package_id;
  const subscriptionId = String(subscription?.id || fallback.subscription_id || "");
  if (!UUID_RE.test(String(coachId || "")) || !UUID_RE.test(String(athleteId || "")) ||
      !UUID_RE.test(String(packageId || "")) || !subscriptionId) {
    throw new Error("billing event metadata is incomplete");
  }
  const packageRow = first(await sbGet(
    s,
    `packages?id=eq.${encodeURIComponent(packageId)}` +
      `&coach_id=eq.${encodeURIComponent(coachId)}` +
      `&select=id,billing_type,carry_forward,max_cycles,installment_count,grace_days&limit=1`,
  ));
  if (!packageRow) throw new Error("billing package not found in tenant");
  const athleteRow = first(await sbGet(
    s,
    `athletes?id=eq.${encodeURIComponent(athleteId)}` +
      `&coach_id=eq.${encodeURIComponent(coachId)}` +
      `&select=id&limit=1`,
  ));
  if (!athleteRow) {
    console.error(
      `[billing] subscription ${subscriptionId}: metadata athlete is outside package tenant; creating without athlete link`,
    );
  }
  const verifiedAthleteId = athleteRow?.id || null;
  let enrollment = first(await sbGet(
    s,
    `billing_subscriptions?coach_id=eq.${encodeURIComponent(coachId)}` +
      `&stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}` +
      `&select=*&limit=1`,
  ));
  if (enrollment) {
    const existingCustomerId = String(
      subscription?.customer?.id || subscription?.customer || fallback.customer || "",
    );
    if (existingCustomerId && verifiedAthleteId) {
      await ensureCustomerMapping(s, {
        coachId,
        athleteId: verifiedAthleteId,
        customerId: existingCustomerId,
        email: fallback.email || fallback.customer_email || fallback.customer_details?.email ||
          enrollment.purchaser_email,
      });
    }
    return enrollment;
  }
  const billingType = md.billing_type || packageRow.billing_type;
  const maxCycles = billingType === "installment"
    ? Number(md.installments_total || packageRow.installment_count)
    : (md.max_cycles ? Number(md.max_cycles) : packageRow.max_cycles);
  const email = String(
    fallback.email || fallback.customer_email || fallback.customer_details?.email || "unknown@unknown.invalid",
  ).trim().toLowerCase();
  const customerId = String(subscription?.customer?.id || subscription?.customer || fallback.customer || "");
  if (verifiedAthleteId) {
    await ensureCustomerMapping(s, { coachId, athleteId: verifiedAthleteId, customerId, email });
  }
  const row = {
    coach_id: coachId,
    package_id: packageId,
    athlete_id: verifiedAthleteId,
    purchaser_email: email,
    billing_type: billingType,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    status: subscription?.pause_collection ? "paused" :
      (subscription?.status === "trialing" ? "trialing" : "active"),
    carry_forward: md.carry_forward === "true",
    cycles_completed: 0,
    max_cycles: maxCycles || null,
    grace_days: Number(md.grace_days || packageRow.grace_days || 3),
    current_period_end: isoFromSeconds(subscription?.current_period_end),
    grace_until: null,
    cancel_at_period_end: subscription?.cancel_at_period_end === true,
  };
  try {
    enrollment = first(await sbPost(s, "billing_subscriptions", row));
  } catch (err) {
    if (err.status !== 409 && !String(err.detail).includes("23505")) throw err;
    enrollment = first(await sbGet(
      s,
      `billing_subscriptions?coach_id=eq.${encodeURIComponent(coachId)}` +
        `&stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}` +
        `&select=*&limit=1`,
    ));
  }
  if (!enrollment) throw new Error("billing enrollment could not be ensured");
  return enrollment;
}

async function athleteForNotify(s, enrollment) {
  if (!enrollment.athlete_id) return null;
  return first(await sbGet(
    s,
    `athletes?id=eq.${encodeURIComponent(enrollment.athlete_id)}` +
      `&coach_id=eq.${encodeURIComponent(enrollment.coach_id)}` +
      `&select=id,user_id,parent_email&limit=1`,
  ));
}

async function notifyBoth(s, enrollment, notify, { type, title, body, dedupeKey }) {
  const athlete = await athleteForNotify(s, enrollment);
  await notify({
    userId: enrollment.coach_id,
    type,
    title,
    body,
    dedupeKey,
  });
  if (athlete || enrollment.purchaser_email) {
    await notify({
      userId: athlete?.user_id || athlete?.id || enrollment.athlete_id,
      email: athlete?.parent_email || enrollment.purchaser_email || undefined,
      type,
      title,
      body,
      dedupeKey,
    });
  }
}

async function handleBillingCheckoutCompleted(event, deps = {}) {
  const session = event?.data?.object || {};
  const s = deps.supabase || sb();
  if (!s) throw new Error("billing Supabase is not configured");
  const stripe = stripeClient(deps.stripe);
  const subscription = await expandedSubscription(session, stripe);
  if (!subscription) throw new Error("billing checkout missing subscription");
  await ensureEnrollment(s, subscription, {
    ...session,
    metadata: session.metadata,
    subscription_id: typeof session.subscription === "string" ? session.subscription : null,
  });
}

async function handleInvoicePaid(event, deps = {}) {
  const invoice = event?.data?.object || {};
  if (!invoice.id) throw new Error("invoice.paid missing invoice id");
  const s = deps.supabase || sb();
  if (!s) throw new Error("billing Supabase is not configured");
  const stripe = stripeClient(deps.stripe);
  const subscription = await expandedSubscription(invoice, stripe);
  if (!subscription) throw new Error("invoice.paid missing subscription");
  const enrollment = await ensureEnrollment(s, subscription, invoice);
  const pkg = first(await sbGet(
    s,
    `packages?id=eq.${encodeURIComponent(enrollment.package_id)}` +
      `&coach_id=eq.${encodeURIComponent(enrollment.coach_id)}` +
      `&select=id,credits,expires_days&limit=1`,
  ));
  if (!pkg) throw new Error("invoice package not found in tenant");
  const nextCycle = Number(enrollment.cycles_completed || 0) + 1;
  const grantCredits = enrollment.billing_type === "subscription" || nextCycle === 1
    ? Number(pkg.credits || 0)
    : 0;
  const purchasedAt = new Date(Number(invoice.created) * 1000).toISOString();
  const expiresAt = pkg.expires_days == null
    ? null
    : new Date(Date.now() + Number(pkg.expires_days) * 86400000).toISOString();
  const mintResult = await sbRpc(s, "mint_billing_cycle", {
    p_subscription_id: enrollment.id,
    p_stripe_invoice_id: String(invoice.id),
    p_amount_cents: Number(invoice.amount_paid),
    p_credits: grantCredits,
    p_source: enrollment.billing_type,
    p_expires_at: expiresAt,
    p_reset_prior: enrollment.billing_type === "subscription" && !enrollment.carry_forward,
    p_purchased_at: purchasedAt,
  });
  if (mintResult?.reason === "subscription_not_found") {
    console.error(
      `[billing] mint_billing_cycle orphaned subscription ${enrollment.id}; ACKing invoice ${invoice.id}`,
    );
    return;
  }
  if (!mintResult?.minted && mintResult?.reason !== "replay") {
    throw new Error(`invoice cycle mint failed: ${mintResult?.reason || "unknown"}`);
  }

  const mirror = deps.mirrorStripePayment || defaultMirrorStripePayment;
  await mirror({
    coachId: enrollment.coach_id,
    athlete_id: enrollment.athlete_id,
    amount_cents: Number(invoice.amount_paid),
    currency: String(invoice.currency || "usd").toLowerCase(),
    collected_via: "stripe",
    slot_id: null,
    purchase_id: mintResult.purchase_id,
    note: `billing_subscription:${enrollment.id}:cycle:${mintResult.cycle}`,
    occurred_at: purchasedAt,
    stripe_invoice_id: String(invoice.id),
  });

  if (mintResult.minted && mintResult.completed && stripe) {
    await stripe.subscriptions.update(subscription.id, { cancel_at_period_end: true });
  }
  if (mintResult.minted) {
    await (deps.notify || defaultNotify)({
      userId: enrollment.coach_id,
      type: "billing.payment_received",
      title: "Payment received",
      body: "A recurring plan payment was received.",
      dedupeKey: `invoice.paid:${invoice.id}`,
    });
    const athlete = await athleteForNotify(s, enrollment);
    await (deps.notify || defaultNotify)({
      userId: athlete?.user_id || athlete?.id || enrollment.athlete_id,
      email: athlete?.parent_email || enrollment.purchaser_email || undefined,
      type: "payment.confirmed",
      title: "Payment confirmed",
      body: "Your plan payment was confirmed.",
      dedupeKey: `invoice.paid:${invoice.id}`,
    });
  }
}

async function enrollmentFromStripeEvent(s, object) {
  const md = object.metadata || {};
  const coachId = md.coach_id;
  if (!UUID_RE.test(String(coachId || "")) || !object.id) {
    throw new Error("subscription event missing tenant metadata");
  }
  const enrollment = first(await sbGet(
    s,
    `billing_subscriptions?coach_id=eq.${encodeURIComponent(coachId)}` +
      `&stripe_subscription_id=eq.${encodeURIComponent(object.id)}` +
      `&select=*&limit=1`,
  ));
  if (!enrollment) throw new Error("billing subscription not found in tenant");
  return enrollment;
}

async function handleInvoicePaymentFailed(event, deps = {}) {
  const invoice = event?.data?.object || {};
  const s = deps.supabase || sb();
  if (!s) throw new Error("billing Supabase is not configured");
  const stripe = stripeClient(deps.stripe);
  const subscription = await expandedSubscription(invoice, stripe);
  if (!subscription) throw new Error("failed invoice missing subscription");
  const enrollment = await ensureEnrollment(s, subscription, invoice);
  if (!enrollment) return;
  const graceUntil = new Date(
    Number(event.created ?? invoice.created) * 1000 + Number(enrollment.grace_days || 3) * 86400000,
  ).toISOString();
  await sbPatch(
    s,
    `billing_subscriptions?id=eq.${encodeURIComponent(enrollment.id)}` +
      `&coach_id=eq.${encodeURIComponent(enrollment.coach_id)}`,
    { status: "past_due", grace_until: graceUntil, updated_at: new Date().toISOString() },
  );
  await notifyBoth(s, enrollment, deps.notify || defaultNotify, {
    type: "billing.payment_failed",
    title: "Payment failed",
    body: "Your payment didn't go through. Stripe will retry it.",
    dedupeKey: `invoice.payment_failed:${invoice.id}`,
  });
}

function mappedStripeStatus(object) {
  if (object.pause_collection != null) return "paused";
  if (object.status === "trialing") return "trialing";
  if (object.status === "past_due") return "past_due";
  if (object.status === "active") return "active";
  return null;
}

async function finalizeSubscription(event, deps = {}, deleted = false) {
  const object = event?.data?.object || {};
  const s = deps.supabase || sb();
  if (!s) throw new Error("billing Supabase is not configured");
  const enrollment = await enrollmentFromStripeEvent(s, object);
  const alreadyCompletedInstallment =
    enrollment.billing_type === "installment" && enrollment.status === "completed";
  const terminal = deleted || TERMINAL_STRIPE_STATES.has(object.status);
  if (terminal && !alreadyCompletedInstallment) {
    const freezeResult = await sbRpc(s, "freeze_subscription_credits", {
      p_subscription_id: enrollment.id,
      p_reason: "billing_final_failure",
    });
    if (freezeResult?.reason === "subscription_not_found") {
      console.error(
        `[billing] freeze_subscription_credits orphaned subscription ${enrollment.id}; ACKing ${object.id}`,
      );
      return;
    }
    if (freezeResult?.already) return;
    await notifyBoth(s, enrollment, deps.notify || defaultNotify, {
      type: "billing.canceled",
      title: "Plan canceled",
      body: "The recurring plan was canceled.",
      dedupeKey: `billing.frozen:${object.id}`,
    });
    return;
  }
  if (alreadyCompletedInstallment) return;
  const status = mappedStripeStatus(object) || enrollment.status;
  await sbPatch(
    s,
    `billing_subscriptions?id=eq.${encodeURIComponent(enrollment.id)}` +
      `&coach_id=eq.${encodeURIComponent(enrollment.coach_id)}`,
    {
      status,
      current_period_end: isoFromSeconds(object.current_period_end),
      cancel_at_period_end: object.cancel_at_period_end === true,
      updated_at: new Date().toISOString(),
    },
  );
}

const handleSubscriptionUpdated = (event, deps) => finalizeSubscription(event, deps, false);
const handleSubscriptionDeleted = (event, deps) => finalizeSubscription(event, deps, true);

module.exports = {
  buildBillingHandlers,
  subscriptionDto,
  handleBillingCheckoutCompleted,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  _test: { ensureEnrollment, expireActiveCredits, sbGet, sbPost, sbPatch, sbRpc },
};
