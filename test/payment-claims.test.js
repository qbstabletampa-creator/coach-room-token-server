// payment_claims (claim + confirm) tests — lib/payment-claims.js.
//
// The PAYMENT_CLAIMS routes are NOT wired in index.js yet (PM-reserved), so these
// tests exercise the module DIRECTLY: the compute-once core (createClaim,
// listClaims, confirmClaim, dismissClaim) plus the handler factory with stub
// req/res. global.fetch is mocked per test to route Supabase PostgREST calls by
// URL + method — the same idiom as test/payments-ledger.test.js.
//
// Coverage: enum + amount validation, tenant isolation (coach A cannot
// list/confirm/dismiss coach B's claim), confirm mints EXACTLY ONE payments row
// with the athlete_claim field mapping, a second confirm mints ZERO extra rows
// (both the fast-path and the CAS-race guard), dismiss never mints, and the
// never-auto-mint invariant (only an explicit confirm writes a payments row).
//
// Why the mint is asserted via a DIRECT payments POST (not an injected
// recordPayment spy): the canonical lib/payments.js recordPayment accepts neither
// matched_by nor external_ref and never writes them, but the spec REQUIRES both
// on an athlete_claim row. confirmClaim therefore mints directly (recordPayment
// idiom, like mirrorStripePayment). The tests assert the exact row PostgREST
// receives, which is the real contract.

const test = require("node:test");
const assert = require("node:assert");

// sb() reads creds at CALL time; set them before requiring the module so it boots.
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";

const {
  createClaim,
  listClaims,
  confirmClaim,
  dismissClaim,
  buildPaymentClaimsHandlers,
  CLAIM_RAILS,
  CLAIM_STATUS,
} = require("../lib/payment-claims.js");

// ---- fetch mock (same shape as the sibling ledger test) --------------------

function installFetchMock(routes) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ u, method, body: opts.body ? JSON.parse(opts.body) : null });
    for (const r of routes) {
      if (r.test(u, method)) return r.reply(u, method, opts);
    }
    return { ok: true, status: 200, json: async () => [], text: async () => "" };
  };
  return { calls, restore() { global.fetch = realFetch; } };
}
function okr(json, status = 200) {
  return { ok: status < 400, status, json: async () => json, text: async () => "" };
}
function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}
// A payments POST route that counts inserts and echoes the row back.
function paymentsPostRoute(counter) {
  return {
    test: (u, m) => u.includes("/rest/v1/payments") && m === "POST",
    reply: (u2, m2, opts) => {
      counter.n += 1;
      return okr([{ id: PAYMENT_ID, ...JSON.parse(opts.body) }], 201);
    },
  };
}
function noPaymentsPost(calls) {
  return calls.some((c) => c.u.includes("/rest/v1/payments") && c.method === "POST");
}

const COACH_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COACH_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ATHLETE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CLAIM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PAYMENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

// ===========================================================================
// enum + amount validation (createClaim)
// ===========================================================================

test("createClaim rejects amount <= 0 / non-integer and inserts nothing", async () => {
  for (const amt of [0, -100, 12.5, "50", null, undefined, NaN]) {
    const mock = installFetchMock([]);
    try {
      const r = await createClaim({ coachId: COACH_A, amount_cents: amt, claimed_rail: "venmo" });
      assert.ok(r.error, `amount ${JSON.stringify(amt)} is rejected`);
      assert.ok(
        !mock.calls.some((c) => c.u.includes("/payment_claims") && c.method === "POST"),
        "no claim row is inserted on a bad amount",
      );
    } finally { mock.restore(); }
  }
});

test("createClaim rejects an invalid claimed_rail and inserts nothing", async () => {
  for (const rail of ["paypal", "stripe", "card", "cash", "", null, "Venmo"]) {
    const mock = installFetchMock([]);
    try {
      const r = await createClaim({ coachId: COACH_A, amount_cents: 5000, claimed_rail: rail });
      assert.ok(r.error, `rail ${JSON.stringify(rail)} is rejected`);
      assert.ok(!mock.calls.some((c) => c.u.includes("/payment_claims") && c.method === "POST"));
    } finally { mock.restore(); }
  }
  // the enum contract is exactly the frozen migration set.
  assert.deepStrictEqual([...CLAIM_RAILS].sort(), ["cashapp", "other", "venmo", "zelle"]);
  assert.deepStrictEqual([...CLAIM_STATUS].sort(), ["confirmed", "dismissed", "pending"]);
});

test("createClaim inserts a pending row stamped with the coach id, text trimmed", async () => {
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/athletes") && m === "GET", reply: () => okr([{ id: ATHLETE }]) },
    {
      test: (u, m) => u.includes("/payment_claims") && m === "POST",
      reply: (u2, m2, opts) => okr([{ id: CLAIM_ID, ...JSON.parse(opts.body) }], 201),
    },
  ]);
  try {
    const r = await createClaim({
      coachId: COACH_A,
      athlete_id: ATHLETE,
      amount_cents: 5000,
      claimed_rail: "zelle",
      external_ref: "  conf#123  ",
      note: "  paid you  ",
    });
    assert.ok(r.claim, "claim returned");
    const ins = mock.calls.find((c) => c.u.includes("/payment_claims") && c.method === "POST");
    assert.strictEqual(ins.body.coach_id, COACH_A);
    assert.strictEqual(ins.body.status, "pending");
    assert.strictEqual(ins.body.claimed_rail, "zelle");
    assert.strictEqual(ins.body.external_ref, "conf#123", "external_ref trimmed");
    assert.strictEqual(ins.body.note, "paid you", "note trimmed");
    assert.strictEqual(ins.body.athlete_id, ATHLETE);
  } finally { mock.restore(); }
});

test("createClaim rejects an athlete that is not the coach's own (no insert)", async () => {
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/athletes") && m === "GET", reply: () => okr([]) },
  ]);
  try {
    const r = await createClaim({ coachId: COACH_A, athlete_id: ATHLETE, amount_cents: 5000, claimed_rail: "venmo" });
    assert.strictEqual(r.error, "athlete is not in your account");
    assert.ok(!mock.calls.some((c) => c.u.includes("/payment_claims") && c.method === "POST"));
    const own = mock.calls.find((c) => c.u.includes("/athletes") && c.method === "GET");
    assert.ok(own.u.includes(`coach_id=eq.${COACH_A}`), "the ownership read is tenant-scoped");
  } finally { mock.restore(); }
});

// ===========================================================================
// listClaims: tenant scope + pending-first
// ===========================================================================

test("listClaims is coach-scoped and floats pending claims to the top", async () => {
  const mock = installFetchMock([
    {
      test: (u, m) => u.includes("/payment_claims") && m === "GET",
      reply: () => okr([
        { id: "1", status: "confirmed", created_at: "2026-07-10T00:00:00Z" },
        { id: "2", status: "pending", created_at: "2026-07-09T00:00:00Z" },
        { id: "3", status: "dismissed", created_at: "2026-07-08T00:00:00Z" },
        { id: "4", status: "pending", created_at: "2026-07-07T00:00:00Z" },
      ]),
    },
  ]);
  try {
    const list = await listClaims({ coachId: COACH_A });
    assert.deepStrictEqual(
      list.map((c) => c.id),
      ["2", "4", "1", "3"],
      "pending first; DB (created_at.desc) order preserved within each group",
    );
    const read = mock.calls.find((c) => c.u.includes("/payment_claims") && c.method === "GET");
    assert.ok(read.u.includes(`coach_id=eq.${COACH_A}`), "the list read is tenant-scoped");
  } finally { mock.restore(); }
});

// ===========================================================================
// confirmClaim: the ONE mint + exact field mapping
// ===========================================================================

test("confirmClaim mints EXACTLY ONE payments row with the athlete_claim field mapping", async () => {
  const counter = { n: 0 };
  const mock = installFetchMock([
    {
      test: (u, m) => u.includes("/payment_claims") && m === "GET",
      reply: () => okr([{
        id: CLAIM_ID, coach_id: COACH_A, athlete_id: ATHLETE, amount_cents: 7500,
        claimed_rail: "venmo", external_ref: "note-xyz", note: "thanks", status: "pending",
        posted_at: null, created_at: "2026-07-10T00:00:00Z",
      }]),
    },
    { test: (u, m) => u.includes("/athletes") && m === "GET", reply: () => okr([{ id: ATHLETE }]) },
    { test: (u, m) => u.includes("/payment_claims") && m === "PATCH", reply: () => okr([{ id: CLAIM_ID, status: "confirmed" }]) },
    paymentsPostRoute(counter),
  ]);
  try {
    const r = await confirmClaim({ coachId: COACH_A, claimId: CLAIM_ID, posted_at: "2026-07-11T00:00:00Z" });
    assert.ok(r.payment, "a payment was minted");
    assert.strictEqual(counter.n, 1, "exactly ONE payments row");
    const row = mock.calls.find((c) => c.u.includes("/rest/v1/payments") && c.method === "POST").body;
    assert.strictEqual(row.coach_id, COACH_A);
    assert.strictEqual(row.athlete_id, ATHLETE);
    assert.strictEqual(row.amount_cents, 7500, "amount from the claim");
    assert.strictEqual(row.collected_via, "venmo", "collected_via = claim rail");
    assert.strictEqual(row.entry_source, "athlete_claim");
    assert.strictEqual(row.matched_by, "athlete_claim");
    assert.strictEqual(row.external_ref, "note-xyz", "external_ref carried over from the claim");
    assert.strictEqual(row.status, "recorded");
    assert.strictEqual(row.occurred_at, "2026-07-11T00:00:00Z", "posted_at override -> ledger occurred_at");
    const cas = mock.calls.find((c) => c.u.includes("/payment_claims") && c.method === "PATCH");
    assert.ok(
      cas.u.includes("status=eq.pending") && cas.u.includes(`coach_id=eq.${COACH_A}`),
      "the CAS flip is guarded on pending AND tenant-scoped",
    );
  } finally { mock.restore(); }
});

test("confirmClaim maps an 'other' claim rail to collected_via 'other'; null athlete stays null", async () => {
  const counter = { n: 0 };
  const mock = installFetchMock([
    {
      test: (u, m) => u.includes("/payment_claims") && m === "GET",
      reply: () => okr([{
        id: CLAIM_ID, coach_id: COACH_A, athlete_id: null, amount_cents: 100,
        claimed_rail: "other", external_ref: null, note: null, status: "pending", posted_at: null,
      }]),
    },
    { test: (u, m) => u.includes("/payment_claims") && m === "PATCH", reply: () => okr([{ id: CLAIM_ID, status: "confirmed" }]) },
    paymentsPostRoute(counter),
  ]);
  try {
    const r = await confirmClaim({ coachId: COACH_A, claimId: CLAIM_ID });
    assert.ok(r.payment);
    const row = mock.calls.find((c) => c.u.includes("/rest/v1/payments") && c.method === "POST").body;
    assert.strictEqual(row.collected_via, "other");
    assert.strictEqual(row.athlete_id, null, "a null-athlete claim keeps athlete_id null");
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/athletes") && c.method === "GET"),
      "no athlete ownership read fired for a null-athlete claim",
    );
  } finally { mock.restore(); }
});

// ===========================================================================
// double-confirm: ZERO additional rows (fast-path + CAS race)
// ===========================================================================

test("a second confirm is a no-op via the status fast-path: ZERO additional payments rows", async () => {
  const store = { status: "pending" };
  const counter = { n: 0 };
  const mock = installFetchMock([
    {
      test: (u, m) => u.includes("/payment_claims") && m === "GET",
      reply: () => okr([{
        id: CLAIM_ID, coach_id: COACH_A, athlete_id: null, amount_cents: 5000,
        claimed_rail: "cashapp", external_ref: null, note: null, status: store.status, posted_at: null,
      }]),
    },
    {
      test: (u, m) => u.includes("/payment_claims") && m === "PATCH",
      reply: () => {
        if (store.status === "pending") { store.status = "confirmed"; return okr([{ id: CLAIM_ID, status: "confirmed" }]); }
        return okr([]);
      },
    },
    paymentsPostRoute(counter),
  ]);
  try {
    const r1 = await confirmClaim({ coachId: COACH_A, claimId: CLAIM_ID });
    const r2 = await confirmClaim({ coachId: COACH_A, claimId: CLAIM_ID });
    assert.ok(r1.payment, "the first confirm mints");
    assert.strictEqual(r2.error, "already_confirmed", "the second confirm is a conflict");
    assert.strictEqual(counter.n, 1, "exactly one payments row across two confirms");
  } finally { mock.restore(); }
});

test("confirm CAS is the single-mint gate even when both callers pass the pending fast-path", async () => {
  // load ALWAYS returns pending (two racers read before either flip commits);
  // only the FIRST CAS PATCH matches a row, the second matches 0.
  let casCalls = 0;
  const counter = { n: 0 };
  const mock = installFetchMock([
    {
      test: (u, m) => u.includes("/payment_claims") && m === "GET",
      reply: () => okr([{
        id: CLAIM_ID, coach_id: COACH_A, athlete_id: null, amount_cents: 5000,
        claimed_rail: "venmo", external_ref: null, note: null, status: "pending", posted_at: null,
      }]),
    },
    {
      test: (u, m) => u.includes("/payment_claims") && m === "PATCH",
      reply: () => { casCalls += 1; return casCalls === 1 ? okr([{ id: CLAIM_ID, status: "confirmed" }]) : okr([]); },
    },
    paymentsPostRoute(counter),
  ]);
  try {
    const r1 = await confirmClaim({ coachId: COACH_A, claimId: CLAIM_ID });
    const r2 = await confirmClaim({ coachId: COACH_A, claimId: CLAIM_ID });
    assert.ok(r1.payment, "the CAS winner mints");
    assert.strictEqual(r2.error, "already_confirmed", "the CAS loser mints nothing");
    assert.strictEqual(counter.n, 1, "the CAS gate allows exactly one mint");
  } finally { mock.restore(); }
});

// ===========================================================================
// tenant isolation (confirm) + mint-failure rollback
// ===========================================================================

test("confirmClaim 404s for a claim that is not the coach's own; no CAS, no mint", async () => {
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/payment_claims") && m === "GET", reply: () => okr([]) },
  ]);
  try {
    const r = await confirmClaim({ coachId: COACH_A, claimId: CLAIM_ID });
    assert.strictEqual(r.error, "not_found");
    assert.ok(!mock.calls.some((c) => c.u.includes("/payment_claims") && c.method === "PATCH"), "no CAS flip");
    assert.ok(!noPaymentsPost(mock.calls), "no mint");
    const load = mock.calls.find((c) => c.u.includes("/payment_claims") && c.method === "GET");
    assert.ok(load.u.includes(`coach_id=eq.${COACH_A}`), "the load is tenant-scoped");
  } finally { mock.restore(); }
});

test("confirmClaim mint failure rolls the claim back to pending and returns mint_failed", async () => {
  const patches = [];
  const mock = installFetchMock([
    {
      test: (u, m) => u.includes("/payment_claims") && m === "GET",
      reply: () => okr([{
        id: CLAIM_ID, coach_id: COACH_A, athlete_id: null, amount_cents: 5000,
        claimed_rail: "venmo", external_ref: null, note: null, status: "pending", posted_at: null,
      }]),
    },
    {
      test: (u, m) => u.includes("/payment_claims") && m === "PATCH",
      reply: (u2, m2, opts) => { patches.push({ u: u2, body: JSON.parse(opts.body) }); return okr([{ id: CLAIM_ID }]); },
    },
    { test: (u, m) => u.includes("/rest/v1/payments") && m === "POST", reply: () => okr("boom", 500) },
  ]);
  try {
    const r = await confirmClaim({ coachId: COACH_A, claimId: CLAIM_ID });
    assert.strictEqual(r.error, "mint_failed");
    const rollback = patches.find((p) => p.body.status === "pending" && p.u.includes("status=eq.confirmed"));
    assert.ok(rollback, "the claim is rolled back to pending after the mint fails (confirmed<=>minted invariant)");
  } finally { mock.restore(); }
});

// ===========================================================================
// never-auto-mint + dismiss
// ===========================================================================

test("NEVER auto-mint: create, list, and dismiss never write a payments row", async () => {
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/athletes") && m === "GET", reply: () => okr([{ id: ATHLETE }]) },
    { test: (u, m) => u.includes("/payment_claims") && m === "POST", reply: () => okr([{ id: CLAIM_ID }], 201) },
    { test: (u, m) => u.includes("/payment_claims") && m === "GET", reply: () => okr([{ id: CLAIM_ID, status: "pending" }]) },
    { test: (u, m) => u.includes("/payment_claims") && m === "PATCH", reply: () => okr([{ id: CLAIM_ID, status: "dismissed" }]) },
  ]);
  try {
    await createClaim({ coachId: COACH_A, athlete_id: ATHLETE, amount_cents: 5000, claimed_rail: "venmo" });
    await listClaims({ coachId: COACH_A });
    await dismissClaim({ coachId: COACH_A, claimId: CLAIM_ID });
    assert.ok(!noPaymentsPost(mock.calls), "no payments row is ever minted outside an explicit confirm");
  } finally { mock.restore(); }
});

test("dismissClaim flips pending -> dismissed (CAS-guarded, tenant-scoped) and NEVER mints", async () => {
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/payment_claims") && m === "GET", reply: () => okr([{ id: CLAIM_ID, status: "pending" }]) },
    { test: (u, m) => u.includes("/payment_claims") && m === "PATCH", reply: () => okr([{ id: CLAIM_ID, status: "dismissed" }]) },
  ]);
  try {
    const r = await dismissClaim({ coachId: COACH_A, claimId: CLAIM_ID });
    assert.strictEqual(r.claim.status, "dismissed");
    const cas = mock.calls.find((c) => c.u.includes("/payment_claims") && c.method === "PATCH");
    assert.ok(cas.u.includes("status=eq.pending") && cas.u.includes(`coach_id=eq.${COACH_A}`));
    assert.ok(!noPaymentsPost(mock.calls), "dismiss never mints");
  } finally { mock.restore(); }
});

test("dismissClaim 404s for a claim not the coach's own; no flip, no mint", async () => {
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/payment_claims") && m === "GET", reply: () => okr([]) },
  ]);
  try {
    const r = await dismissClaim({ coachId: COACH_A, claimId: CLAIM_ID });
    assert.strictEqual(r.error, "not_found");
    assert.ok(!mock.calls.some((c) => c.u.includes("/payment_claims") && c.method === "PATCH"));
    assert.ok(!noPaymentsPost(mock.calls));
  } finally { mock.restore(); }
});

test("dismissClaim refuses a confirmed claim (already_confirmed) and never mints", async () => {
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/payment_claims") && m === "GET", reply: () => okr([{ id: CLAIM_ID, status: "confirmed" }]) },
  ]);
  try {
    const r = await dismissClaim({ coachId: COACH_A, claimId: CLAIM_ID });
    assert.strictEqual(r.error, "already_confirmed");
    assert.ok(!mock.calls.some((c) => c.u.includes("/payment_claims") && c.method === "PATCH"));
    assert.ok(!noPaymentsPost(mock.calls));
  } finally { mock.restore(); }
});

// ===========================================================================
// handler factory: auth lanes + status mapping
// ===========================================================================

test("handler postClaim derives coach+athlete from resolveClaimant, NOT the request body", async () => {
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/athletes") && m === "GET", reply: () => okr([{ id: ATHLETE }]) },
    { test: (u, m) => u.includes("/payment_claims") && m === "POST", reply: (u2, m2, opts) => okr([{ id: CLAIM_ID, ...JSON.parse(opts.body) }], 201) },
  ]);
  const handlers = buildPaymentClaimsHandlers({
    resolveClaimant: async () => ({ coachId: COACH_A, athleteId: ATHLETE }),
  });
  const res = fakeRes();
  try {
    await handlers.postClaim(
      { body: { coach_id: COACH_B, amount_cents: 4200, claimed_rail: "venmo" } },
      res,
    );
    assert.strictEqual(res.statusCode, 201);
    const ins = mock.calls.find((c) => c.u.includes("/payment_claims") && c.method === "POST");
    assert.strictEqual(ins.body.coach_id, COACH_A, "coach id comes from resolveClaimant, never the body's coach_id");
    assert.strictEqual(ins.body.athlete_id, ATHLETE);
  } finally { mock.restore(); }
});

test("handler postClaim 503s when no athlete-auth lane (resolveClaimant) is wired", async () => {
  const mock = installFetchMock([]);
  const handlers = buildPaymentClaimsHandlers({});
  const res = fakeRes();
  try {
    await handlers.postClaim({ body: { amount_cents: 5000, claimed_rail: "venmo" } }, res);
    assert.strictEqual(res.statusCode, 503);
  } finally { mock.restore(); }
});

test("handler getClaims requires a coach JWT (401 when unauthenticated)", async () => {
  const mock = installFetchMock([]);
  const handlers = buildPaymentClaimsHandlers({
    requireSupabaseUser: async () => ({ error: "sign in required", status: 401 }),
  });
  const res = fakeRes();
  try {
    await handlers.getClaims({ query: {} }, res);
    assert.strictEqual(res.statusCode, 401);
  } finally { mock.restore(); }
});

test("handler postConfirm 404s on a cross-tenant claim (coach can only confirm own); no mint", async () => {
  const mock = installFetchMock([
    { test: (u, m) => u.includes("/payment_claims") && m === "GET", reply: () => okr([]) },
  ]);
  const handlers = buildPaymentClaimsHandlers({
    requireSupabaseUser: async () => ({ user: { id: COACH_A, app_metadata: { role: "coach" } } }),
  });
  const res = fakeRes();
  try {
    await handlers.postConfirm({ params: { id: CLAIM_ID }, body: {} }, res);
    assert.strictEqual(res.statusCode, 404);
    assert.ok(!noPaymentsPost(mock.calls), "no mint for a claim the coach does not own");
    const load = mock.calls.find((c) => c.u.includes("/payment_claims") && c.method === "GET");
    assert.ok(load.u.includes(`coach_id=eq.${COACH_A}`), "the confirm load is tenant-scoped to the JWT coach");
  } finally { mock.restore(); }
});

test("handler postConfirm success returns {claim,payment} (200) and threads posted_at from the body", async () => {
  const counter = { n: 0 };
  const mock = installFetchMock([
    {
      test: (u, m) => u.includes("/payment_claims") && m === "GET",
      reply: () => okr([{
        id: CLAIM_ID, coach_id: COACH_A, athlete_id: null, amount_cents: 3300,
        claimed_rail: "zelle", external_ref: null, note: null, status: "pending", posted_at: null,
      }]),
    },
    { test: (u, m) => u.includes("/payment_claims") && m === "PATCH", reply: () => okr([{ id: CLAIM_ID, status: "confirmed" }]) },
    paymentsPostRoute(counter),
  ]);
  const handlers = buildPaymentClaimsHandlers({
    requireSupabaseUser: async () => ({ user: { id: COACH_A, app_metadata: { role: "coach" } } }),
  });
  const res = fakeRes();
  try {
    await handlers.postConfirm({ params: { id: CLAIM_ID }, body: { posted_at: "2026-07-12T00:00:00Z" } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.claim && res.body.payment, "returns both the flipped claim and the minted payment");
    assert.strictEqual(counter.n, 1);
    const row = mock.calls.find((c) => c.u.includes("/rest/v1/payments") && c.method === "POST").body;
    assert.strictEqual(row.occurred_at, "2026-07-12T00:00:00Z", "posted_at from the body threads to occurred_at");
  } finally { mock.restore(); }
});
