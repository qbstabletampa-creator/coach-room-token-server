#!/usr/bin/env node
// scripts/backfill-payments-0022.js
//
// One-time backfill for migration 0022: mint ONE payments ledger row per
// historical package_purchases with amount_cents > 0, so the single payments
// ledger (wave-2 decree #1) reflects every dollar already collected through
// Stripe checkout BEFORE the webhook mirror started writing rows. Without it,
// revenue read from `payments` would miss all pre-mirror purchases.
//
// This lives in a hand-run script (NOT the DDL) on purpose: wave-2 decree #2
// requires the backfill to be a SEPARATELY-PROVED step — revenue(before) ==
// revenue(after), asserted — and the 7/12 blast-radius rule requires proving a
// shared money path where it actually runs (real Postgres), not inside a DDL
// that a hand-applier runs blind.
//
// SAFETY:
//   - DRY RUN BY DEFAULT. Prints what it WOULD do and the projected revenue
//     reconciliation. Writes nothing.
//   - Pass --apply to actually insert.
//   - Idempotent: skips any purchase that already has a payments row linked by
//     purchase_id (so re-runs never double-mint), and sets stripe_session_id
//     from the purchase row where present (the partial unique index is a second
//     guard for session-keyed rows).
//   - After --apply it recomputes revenue-after and asserts it equals
//     revenue-before, exiting NON-ZERO on mismatch.
//
// STILL DEPLOY-GATED FOR THE PM (decree #2, NOT done by this script):
//   - Run this against a STAGING CLONE first and confirm before==after there.
//   - Prove one real test-mode Stripe checkout (4242 card) provisions credits +
//     exactly one payments mirror row + revenue counted once.
//   - PREPARE-check the new dashboard revenue SQL on real Postgres.
//   This script is the tooling; those three proofs are the human gate.
//
// Env: SUPABASE_URL + SUPABASE_SERVICE_KEY (read from the environment / .env,
// exactly like the server). This script never edits .env.

require("dotenv").config();

const APPLY = process.argv.includes("--apply");
const PAGE = 1000; // PostgREST default max page size.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function headers() {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "content-type": "application/json",
  };
}

async function getAll(pathWithQuery) {
  const out = [];
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url =
      `${SUPABASE_URL}/rest/v1/${pathWithQuery}` +
      `${pathWithQuery.includes("?") ? "&" : "?"}limit=${PAGE}&offset=${offset}`;
    const resp = await fetch(url, { headers: headers() });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`GET ${pathWithQuery} -> ${resp.status}: ${detail}`);
    }
    const rows = await resp.json().catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

function sumCents(rows, field = "amount_cents") {
  return rows.reduce((acc, r) => acc + (Number(r[field]) || 0), 0);
}

async function insertPayment(row) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/payments`, {
    method: "POST",
    headers: { ...headers(), prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  if (resp.status === 409) return { ok: true, skipped: true }; // unique conflict = idempotent
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    if (detail && detail.includes("23505")) return { ok: true, skipped: true };
    return { ok: false, detail: `${resp.status}: ${detail}` };
  }
  return { ok: true, skipped: false };
}

function log(...args) {
  console.log(...args);
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in env. Aborting.");
    process.exit(2);
  }

  log(`\n=== backfill-payments-0022  [${APPLY ? "APPLY" : "DRY RUN"}] ===\n`);

  // 1. Historical purchases with real money on them.
  const purchases = await getAll(
    "package_purchases?amount_cents=gt.0&select=id,coach_id,athlete_id,amount_cents,stripe_session_id,purchased_at",
  );
  log(`package_purchases with amount_cents > 0: ${purchases.length}`);

  // 2. Existing payments keyed by purchase_id (idempotency: never double-mint).
  const existingPayments = await getAll(
    "payments?purchase_id=not.is.null&select=purchase_id",
  );
  const alreadyMirrored = new Set(
    existingPayments.map((p) => p.purchase_id).filter(Boolean),
  );
  log(`payments already linked to a purchase: ${alreadyMirrored.size}`);

  // 3. Revenue BEFORE = sum of collected money on package_purchases (> 0).
  const revenueBefore = sumCents(purchases);

  // Current recorded-payments revenue (what the ledger already reflects).
  const currentPayments = await getAll(
    "payments?status=eq.recorded&select=amount_cents",
  );
  const currentPaymentsRevenue = sumCents(currentPayments);

  // 4. Plan the inserts (skip anything already mirrored).
  const toInsert = purchases.filter((p) => !alreadyMirrored.has(p.id));
  const plannedCents = sumCents(toInsert);

  log("");
  log(`revenue-before (package_purchases > 0):        $${(revenueBefore / 100).toFixed(2)}`);
  log(`current recorded payments revenue:             $${(currentPaymentsRevenue / 100).toFixed(2)}`);
  log(`purchases to mint a payments row for:          ${toInsert.length}`);
  log(`sum of planned new rows:                       $${(plannedCents / 100).toFixed(2)}`);
  log(`projected recorded payments revenue after:     $${((currentPaymentsRevenue + plannedCents) / 100).toFixed(2)}`);
  log("");

  if (!APPLY) {
    const projectedAfter = currentPaymentsRevenue + plannedCents;
    log("DRY RUN: no rows written. Re-run with --apply to execute.");
    if (projectedAfter !== revenueBefore) {
      log(
        `NOTE: projected-after ($${(projectedAfter / 100).toFixed(2)}) != before ` +
          `($${(revenueBefore / 100).toFixed(2)}). On a clean pre-launch clone these ` +
          `should match. A difference means the ledger already holds non-purchase ` +
          `payments (mark-paid rails etc.) or some purchases are already mirrored — ` +
          `review before applying.`,
      );
    } else {
      log("Projected reconciliation OK: after would equal before.");
    }
    return;
  }

  // 5. APPLY: insert one payments row per planned purchase.
  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  for (const p of toInsert) {
    const row = {
      coach_id: p.coach_id,
      athlete_id: p.athlete_id || null,
      amount_cents: Number(p.amount_cents) || 0,
      currency: "usd",
      collected_via: "stripe",
      purchase_id: p.id,
      entry_source: "stripe_webhook",
      stripe_session_id: p.stripe_session_id || null,
      status: "recorded",
      occurred_at: p.purchased_at || undefined,
    };
    const res = await insertPayment(row);
    if (!res.ok) {
      failed += 1;
      console.error(`  FAIL purchase ${p.id}: ${res.detail}`);
    } else if (res.skipped) {
      skipped += 1;
    } else {
      inserted += 1;
    }
  }

  log("");
  log(`inserted: ${inserted}  skipped(idempotent): ${skipped}  failed: ${failed}`);

  // 6. Recompute revenue-after and ASSERT it equals revenue-before.
  const afterPayments = await getAll(
    "payments?status=eq.recorded&select=amount_cents",
  );
  const revenueAfter = sumCents(afterPayments);

  log("");
  log(`revenue-before (package_purchases > 0):   $${(revenueBefore / 100).toFixed(2)}`);
  log(`revenue-after  (recorded payments):       $${(revenueAfter / 100).toFixed(2)}`);

  if (failed > 0) {
    console.error(`\nABORT: ${failed} insert(s) failed. Ledger may be partial — investigate.`);
    process.exit(1);
  }
  if (revenueAfter !== revenueBefore) {
    console.error(
      `\nMISMATCH: revenue-after ($${(revenueAfter / 100).toFixed(2)}) != revenue-before ` +
        `($${(revenueBefore / 100).toFixed(2)}). The ledger does NOT reconcile. Do NOT ` +
        `promote the dashboard revenue read until this is explained (e.g. pre-existing ` +
        `non-purchase payments on this DB).`,
    );
    process.exit(1);
  }

  log("\nRECONCILED: revenue-after == revenue-before. Backfill complete.");
}

main().catch((err) => {
  console.error("backfill failed:", err);
  process.exit(1);
});
