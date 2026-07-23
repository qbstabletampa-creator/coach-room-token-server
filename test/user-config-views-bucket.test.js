// Saved-views bucket reconcile: the server's save_view / list_saved_views /
// delete_view (Lane B) must read/write the EXACT storage shape the CoachTime app
// ships (app repo lib/saved-views.ts). Named views for a screen live in ONE
// reserved key `<screen>:__named` in the views namespace, value `{ views:
// SavedView[] }` — NOT one key per view. The implicit last-used state lives under
// a SEPARATE key `<screen>:__last` and must never be touched by these tools.
//
// These fixtures are shaped straight from the app codec's output (ViewCodec ->
// toSavedView -> `{ id, name, screen, filters, sort, columns? }`, bucketed under
// `{ views: [...] }`). A view the app's isSavedView guard would drop is refused
// here, so an agent write can never land in a shape the phone silently ignores.

const test = require("node:test");
const assert = require("node:assert/strict");
const mod = require("../lib/user-config");

const COACH = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-07-22T12:00:00.000Z";
process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_KEY = "service";

function response(value, status = 200) {
  return new Response(typeof value === "string" ? value : JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
// encodeURIComponent("athletes:__named") — the colon is percent-encoded in the URL.
const NAMED_KEY_Q = "key=eq.athletes%3A__named";

test("save_view writes the whole named bucket under <screen>:__named, not a per-view key", async () => {
  const view = { id: "v_abc", name: "Unpaid", screen: "athletes", filters: { status: "unpaid" }, sort: "name.asc" };
  const calls = []; const real = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url); const method = (opts && opts.method) || "GET";
    calls.push({ u, method, body: opts && opts.body ? JSON.parse(opts.body) : undefined });
    if (method === "GET" && u.includes("select=value")) return response([]);      // bucket empty
    if (method === "GET" && u.includes("select=key")) return response([]);         // overCap: no keys
    const b = JSON.parse(opts.body); return response([{ namespace: b.namespace, key: b.key, value: b.value, updated_at: NOW }], 201);
  };
  try {
    const out = await mod.saveView({ coachId: COACH, view });
    assert.equal(out.status, 200);
    const post = calls.find((c) => c.method === "POST");
    assert.equal(post.body.namespace, "views");
    assert.equal(post.body.key, "athletes:__named", "the reserved bucket key, never athletes:v_abc");
    assert.deepEqual(post.body.value, { views: [view] }, "value is the { views: [...] } bucket the app reads");
    assert.ok(calls.every((c) => c.u.includes(`coach_id=eq.${COACH}`)), "tenant lock on every call");
    // the bucket read targeted the named key only — __last was never read
    assert.ok(calls.some((c) => c.method === "GET" && c.u.includes(NAMED_KEY_Q)), "read the named bucket key");
    assert.ok(calls.every((c) => !c.u.includes("__last")), "__last untouched");
  } finally { global.fetch = real; }
});

test("save_view upserts into an existing app-written bucket by id (replace in place)", async () => {
  const existing = { id: "v1", name: "Old", screen: "athletes", filters: {}, sort: null };
  const other = { id: "v2", name: "Keep", screen: "athletes", filters: { a: 1 }, sort: null };
  const updated = { id: "v1", name: "New", screen: "athletes", filters: { status: "paid" }, sort: "created.desc" };
  const calls = []; const real = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url); const method = (opts && opts.method) || "GET";
    calls.push({ u, method, body: opts && opts.body ? JSON.parse(opts.body) : undefined });
    if (method === "GET" && u.includes("select=value")) return response([{ value: { views: [existing, other] } }]);
    if (method === "GET" && u.includes("select=key")) return response([{ key: "athletes:__named" }]);
    const b = JSON.parse(opts.body); return response([{ namespace: b.namespace, key: b.key, value: b.value, updated_at: NOW }], 201);
  };
  try {
    const out = await mod.saveView({ coachId: COACH, view: updated });
    assert.equal(out.status, 200);
    const post = calls.find((c) => c.method === "POST");
    assert.deepEqual(post.body.value, { views: [updated, other] }, "v1 replaced in place, v2 preserved, no duplication");
  } finally { global.fetch = real; }
});

test("list_saved_views reads the app-written <screen>:__named bucket and drops __last / malformed", async () => {
  const good = { id: "v1", name: "Unpaid", screen: "athletes", filters: { status: "unpaid" }, sort: "name.asc" };
  const withCols = { id: "v2", name: "Cols", screen: "athletes", filters: {}, sort: null, columns: { name: true } };
  const bucket = { views: [
    good,
    withCols,
    { id: "__last", name: "implicit", screen: "athletes", filters: {}, sort: null }, // reserved id -> dropped
    { nope: 1 },                                                                     // not a SavedView -> dropped
  ] };
  const calls = []; const real = global.fetch;
  global.fetch = async (url) => { calls.push(String(url)); return response([{ value: bucket }]); };
  try {
    const out = await mod.listSavedViews({ coachId: COACH, screen: "athletes" });
    assert.equal(out.status, 200);
    assert.deepEqual(out.data.views, [good, withCols], "only well-formed non-reserved views survive");
    assert.ok(calls.every((u) => u.includes(`coach_id=eq.${COACH}`) && u.includes("namespace=eq.views")), "tenant + namespace lock");
    assert.ok(calls.every((u) => u.includes(NAMED_KEY_Q)), "reads only the named bucket key, not the whole namespace");
  } finally { global.fetch = real; }
});

test("delete_view removes one view from the bucket, keeps siblings, never touches __last", async () => {
  const a = { id: "v1", name: "A", screen: "athletes", filters: {}, sort: null };
  const b = { id: "v2", name: "B", screen: "athletes", filters: {}, sort: null };
  const calls = []; const real = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url); const method = (opts && opts.method) || "GET";
    calls.push({ u, method, body: opts && opts.body ? JSON.parse(opts.body) : undefined });
    if (method === "GET" && u.includes("select=value")) return response([{ value: { views: [a, b] } }]);
    if (method === "GET" && u.includes("select=key")) return response([{ key: "athletes:__named" }]);
    const bod = JSON.parse(opts.body); return response([{ namespace: bod.namespace, key: bod.key, value: bod.value, updated_at: NOW }], 201);
  };
  try {
    const out = await mod.deleteView({ coachId: COACH, screen: "athletes", viewId: "v1" });
    assert.deepEqual([out.status, out.data.deleted], [200, true]);
    const post = calls.find((c) => c.method === "POST");
    assert.equal(post.body.key, "athletes:__named");
    assert.deepEqual(post.body.value, { views: [b] }, "sibling v2 preserved, v1 removed");
    assert.ok(calls.every((c) => !c.u.includes("__last")), "the __last key is never read or written");
    assert.ok(calls.every((c) => c.method !== "DELETE"), "delete is a bucket rewrite, not a row DELETE");
  } finally { global.fetch = real; }
});

test("delete_view of an absent id is a no-op (deleted:false) and never writes the bucket", async () => {
  const a = { id: "v1", name: "A", screen: "athletes", filters: {}, sort: null };
  let wrote = false; const real = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url); const method = (opts && opts.method) || "GET";
    if (method === "GET" && u.includes("select=value")) return response([{ value: { views: [a] } }]);
    if (method === "GET") return response([]);
    wrote = true; return response([{}], 201);
  };
  try {
    const out = await mod.deleteView({ coachId: COACH, screen: "athletes", viewId: "ghost" });
    assert.deepEqual([out.status, out.data.deleted], [200, false]);
    assert.equal(wrote, false, "no rewrite when nothing changed");
  } finally { global.fetch = real; }
});

test("save_view rejects a bucket that would blow the jsonb ceiling with a clear 4xx", async () => {
  let posted = false; const real = global.fetch;
  const huge = { id: "big", name: "big", screen: "athletes", filters: { blob: "x".repeat(20000) }, sort: null };
  global.fetch = async (url, opts) => {
    const method = (opts && opts.method) || "GET";
    if (method === "GET") return response([]); // empty bucket + no keys
    posted = true; const b = JSON.parse(opts.body); return response([{ namespace: b.namespace, key: b.key, value: b.value, updated_at: NOW }], 201);
  };
  try {
    const out = await mod.saveView({ coachId: COACH, view: huge });
    assert.equal(out.status, 413);
    assert.equal(out.data.error, "view_bucket_too_large");
    assert.equal(posted, false, "the oversized bucket write never fires");
  } finally { global.fetch = real; }
});

test("save_view refuses a reserved view id and any shape the app would silently drop", async () => {
  let hit = false; const real = global.fetch; global.fetch = async () => { hit = true; return response([]); };
  try {
    // reserved id (KEY_RE + explicit guard both bar a leading-underscore id)
    assert.equal((await mod.saveView({ coachId: COACH, view: { id: "__named", name: "x", screen: "athletes", filters: {}, sort: null } })).status, 400);
    // filters must be a plain object (the app's isSavedView drops a non-object filters)
    assert.equal((await mod.saveView({ coachId: COACH, view: { id: "v1", name: "x", screen: "athletes", filters: [], sort: null } })).status, 400);
    // sort must be string|null
    assert.equal((await mod.saveView({ coachId: COACH, view: { id: "v1", name: "x", screen: "athletes", filters: {}, sort: 3 } })).status, 400);
    assert.equal(hit, false, "invalid saves never reach the DB");
  } finally { global.fetch = real; }
});

test("delete_view refuses a reserved view id (cannot delete __last / __named via this tool)", async () => {
  let hit = false; const real = global.fetch; global.fetch = async () => { hit = true; return response([]); };
  try {
    assert.equal((await mod.deleteView({ coachId: COACH, screen: "athletes", viewId: "__last" })).status, 400);
    assert.equal((await mod.deleteView({ coachId: COACH, screen: "athletes", viewId: "__named" })).status, 400);
    assert.equal(hit, false);
  } finally { global.fetch = real; }
});
