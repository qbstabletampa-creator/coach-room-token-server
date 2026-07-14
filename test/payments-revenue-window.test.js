// revenueByRail {from,to} windowing tests (round-2 dashboard extension).
// Proves: (1) the new explicit {from,to} window mode builds a half-open [from,to)
// UTC filter (gte.from + lt.to) and sums/groups correctly; (2) the default
// {range} path is UNCHANGED (gte.<since> only, no upper bound), so no existing
// call site (getOverview, MCP) shifts behavior. Pure unit test: require the lib
// directly, mock global.fetch to capture the PostgREST URL + return rows.

const test = require("node:test");
const assert = require("node:assert");

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";

const { revenueByRail } = require("../lib/payments.js");

const COACH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// Capture every fetch URL; reply with the supplied rows for the grouping read.
function installFetchMock(rows) {
  const realFetch = global.fetch;
  const urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => rows, text: async () => "" };
  };
  return { urls, restore() { global.fetch = realFetch; } };
}

test("window mode: {from,to} builds a half-open [from,to) UTC filter and sums by rail", async () => {
  const rows = [
    { amount_cents: 5000, collected_via: "venmo" },
    { amount_cents: 3000, collected_via: "stripe" },
    { amount_cents: 2000, collected_via: "venmo" },
  ];
  const mock = installFetchMock(rows);
  try {
    const from = "2026-07-01T00:00:00.000Z";
    const to = "2026-08-01T00:00:00.000Z";
    const out = await revenueByRail({ coachId: COACH, from, to });

    const u = mock.urls[0];
    assert.ok(u.includes(`occurred_at=gte.${encodeURIComponent(from)}`), `gte.from present: ${u}`);
    assert.ok(u.includes(`occurred_at=lt.${encodeURIComponent(to)}`), `lt.to present (exclusive): ${u}`);
    assert.ok(!u.includes("occurred_at=gte.2026-07-01T00:00:00.000Z&occurred_at=gte"), "no duplicate gte");

    // Math: grouped by rail, grand totals.
    assert.strictEqual(out.total_cents, 10000);
    assert.strictEqual(out.count, 3);
    assert.strictEqual(out.by_rail.venmo.total_cents, 7000);
    assert.strictEqual(out.by_rail.venmo.count, 2);
    assert.strictEqual(out.by_rail.stripe.total_cents, 3000);
  } finally {
    mock.restore();
  }
});

test("window mode accepts Date objects and normalizes to ISO", async () => {
  const mock = installFetchMock([]);
  try {
    const from = new Date(Date.UTC(2026, 6, 1)); // 2026-07-01T00:00:00.000Z
    const to = new Date(Date.UTC(2026, 7, 1));
    await revenueByRail({ coachId: COACH, from, to });
    const u = mock.urls[0];
    assert.ok(u.includes(`occurred_at=gte.${encodeURIComponent(from.toISOString())}`), u);
    assert.ok(u.includes(`occurred_at=lt.${encodeURIComponent(to.toISOString())}`), u);
  } finally {
    mock.restore();
  }
});

test("window mode: only `from` -> gte lower bound, no upper bound", async () => {
  const mock = installFetchMock([]);
  try {
    const from = "2026-07-01T00:00:00.000Z";
    await revenueByRail({ coachId: COACH, from });
    const u = mock.urls[0];
    assert.ok(u.includes(`occurred_at=gte.${encodeURIComponent(from)}`), u);
    assert.ok(!u.includes("occurred_at=lt."), "no upper bound when `to` is absent");
  } finally {
    mock.restore();
  }
});

test("default {range} path is UNCHANGED: gte.<since> only, never an lt upper bound", async () => {
  const mock = installFetchMock([]);
  try {
    await revenueByRail({ coachId: COACH, range: "this_month" });
    const u = mock.urls[0];
    // Original behavior: a single gte lower bound from rangeToSince, no lt.
    assert.ok(u.includes("occurred_at=gte."), `range mode keeps its gte lower bound: ${u}`);
    assert.ok(!u.includes("occurred_at=lt."), "range mode never adds an upper bound (byte-identical)");
    assert.ok(u.includes("select=amount_cents,collected_via"), "the grouping select is unchanged");
    assert.ok(u.includes(`coach_id=eq.${COACH}`), "tenant scoped");
    assert.ok(u.includes("status=eq.recorded"), "recorded-only, unchanged");
  } finally {
    mock.restore();
  }
});

test("default 'all' range still means no lower bound at all (unchanged)", async () => {
  const mock = installFetchMock([]);
  try {
    await revenueByRail({ coachId: COACH, range: "all" });
    const u = mock.urls[0];
    assert.ok(!u.includes("occurred_at="), `all-time keeps zero occurred_at filter: ${u}`);
  } finally {
    mock.restore();
  }
});
