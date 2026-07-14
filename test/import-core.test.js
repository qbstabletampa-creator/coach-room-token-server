// Bulk athlete import core unit tests (round-2, lib/import.js). No network, no
// live creds. global.fetch is mocked per test to route Supabase PostgREST calls
// by URL + method. Drives buildImportCore / undoImport / listImports directly.
//
// Covers: happy-path create + source stamp + claim links, dedupe by email
// (DB match + intra-batch), email+name sibling split, dedupe off, 500-row cap,
// name-required error, dry-run (writes nothing), claim-mint fail-soft, tenant
// scoping on the dedupe read, batch-of-200 chunking, and undo (delete unclaimed,
// skip claimed/paid, foreign batch 404, idempotent re-undo).

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";

const { buildImportCore, undoImport, listImports, MAX_ROWS } = require("../lib/import.js");

const COACH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BATCH = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function okr(json, status = 200) {
  return { ok: status < 400, status, json: async () => json, text: async () => "" };
}

// Install a routing fetch mock. `routes` is an array of { test(u,m), reply(u,m,opts) }.
// Unmatched calls return an empty 200 array. Records every call for assertions.
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
    return okr([]);
  };
  return { calls, restore() { global.fetch = realFetch; } };
}

// Common route builders ------------------------------------------------------
function dedupeRoute(matches = []) {
  // GET athletes?...&parent_email=in.(...) — the dedupe existing-athlete lookup.
  return {
    test: (u, m) => m === "GET" && u.includes("/athletes?") && u.includes("parent_email=in."),
    reply: () => okr(matches),
  };
}
function batchInsertRoute(id = BATCH, sink) {
  return {
    test: (u, m) => m === "POST" && u.includes("/athlete_imports"),
    reply: (u, m, opts) => {
      if (sink) sink.push(JSON.parse(opts.body));
      return okr([{ id }]);
    },
  };
}
function athleteInsertRoute(sink) {
  // POST athletes — echo each row back with a fresh uuid + its name.
  return {
    test: (u, m) => m === "POST" && u.includes("/athletes"),
    reply: (u, m, opts) => {
      const body = JSON.parse(opts.body);
      if (sink) sink.push(body);
      return okr(body.map((r) => ({ id: crypto.randomUUID(), name: r.name })));
    },
  };
}
function claimRoutes(token = "tok-123") {
  return [
    { // findReusableClaim: none -> mint
      test: (u, m) => m === "GET" && u.includes("/athlete_claims"),
      reply: () => okr([]),
    },
    { // mintClaim
      test: (u, m) => m === "POST" && u.includes("/athlete_claims"),
      reply: () => okr([{ token }]),
    },
  ];
}
function batchPatchRoute() {
  return {
    test: (u, m) => m === "PATCH" && u.includes("/athlete_imports"),
    reply: () => okr([]),
  };
}

const core = buildImportCore({ baseUrl: "https://claim.test" });

// ===========================================================================
test("imports valid rows, stamps source=import, mints one claim link each", async () => {
  const athletePayloads = [];
  const mock = installFetchMock([
    dedupeRoute([]),
    batchInsertRoute(BATCH),
    athleteInsertRoute(athletePayloads),
    batchPatchRoute(),
    ...claimRoutes("tok-abc"),
  ]);
  try {
    const res = await core.importAthletes({
      coachId: COACH,
      rows: [
        { name: "Alex Rivera", parent_email: "Mom@Example.com", position: "QB" },
        { name: "Sam Cole", parent_phone: "555-1212" },
      ],
      options: {},
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.data.created, 2);
    assert.strictEqual(res.data.skipped, 0);
    assert.strictEqual(res.data.batch_id, BATCH);
    assert.strictEqual(res.data.claim_links.length, 2, "one claim link per created athlete");
    for (const link of res.data.claim_links) {
      assert.match(link.url, /^https:\/\/claim\.test\/claim\/tok-abc$/);
    }
    // Source stamp + tenant + lowercased email on the insert payload.
    const inserted = athletePayloads.flat();
    assert.strictEqual(inserted.length, 2);
    for (const a of inserted) {
      assert.strictEqual(a.source, "import");
      assert.strictEqual(a.source_ref, BATCH);
      assert.strictEqual(a.import_batch_id, BATCH);
      assert.strictEqual(a.coach_id, COACH);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(a, "notes"), false, "no notes column written");
    }
    assert.strictEqual(inserted[0].parent_email, "mom@example.com");
  } finally {
    mock.restore();
  }
});

test("dedupe email: a DB match is skipped, not overwritten", async () => {
  const mock = installFetchMock([
    dedupeRoute([{ id: crypto.randomUUID(), name: "Existing Kid", parent_email: "dup@example.com" }]),
    batchInsertRoute(BATCH),
    athleteInsertRoute(),
    batchPatchRoute(),
    ...claimRoutes(),
  ]);
  try {
    const res = await core.importAthletes({
      coachId: COACH,
      rows: [
        { name: "New Kid", parent_email: "fresh@example.com" },
        { name: "Dup Kid", parent_email: "dup@example.com" },
      ],
      options: { dedupe: "email" },
    });
    assert.strictEqual(res.data.created, 1);
    assert.strictEqual(res.data.skipped, 1);
  } finally {
    mock.restore();
  }
});

test("dedupe email: two rows sharing an email in one paste -> second skipped", async () => {
  const mock = installFetchMock([
    dedupeRoute([]),
    batchInsertRoute(BATCH),
    athleteInsertRoute(),
    batchPatchRoute(),
    ...claimRoutes(),
  ]);
  try {
    const res = await core.importAthletes({
      coachId: COACH,
      rows: [
        { name: "First", parent_email: "same@example.com" },
        { name: "Second", parent_email: "same@example.com" },
      ],
      options: { dedupe: "email" },
    });
    assert.strictEqual(res.data.created, 1);
    assert.strictEqual(res.data.skipped, 1);
  } finally {
    mock.restore();
  }
});

test("dedupe email+name: siblings on one parent email both import", async () => {
  const mock = installFetchMock([
    // Existing row for the shared email but a DIFFERENT name -> not a match.
    dedupeRoute([{ id: crypto.randomUUID(), name: "Older Sibling", parent_email: "parent@example.com" }]),
    batchInsertRoute(BATCH),
    athleteInsertRoute(),
    batchPatchRoute(),
    ...claimRoutes(),
  ]);
  try {
    const res = await core.importAthletes({
      coachId: COACH,
      rows: [
        { name: "Younger Sibling", parent_email: "parent@example.com" },
        { name: "Older Sibling", parent_email: "parent@example.com" }, // matches existing name
      ],
      options: { dedupe: "email+name" },
    });
    assert.strictEqual(res.data.created, 1, "younger imports, older is the dup");
    assert.strictEqual(res.data.skipped, 1);
  } finally {
    mock.restore();
  }
});

test("dedupe off: every row imports even with a DB email match", async () => {
  const mock = installFetchMock([
    dedupeRoute([{ id: crypto.randomUUID(), name: "Existing", parent_email: "dup@example.com" }]),
    batchInsertRoute(BATCH),
    athleteInsertRoute(),
    batchPatchRoute(),
    ...claimRoutes(),
  ]);
  try {
    const res = await core.importAthletes({
      coachId: COACH,
      rows: [
        { name: "A", parent_email: "dup@example.com" },
        { name: "B", parent_email: "dup@example.com" },
      ],
      options: { dedupe: "off" },
    });
    assert.strictEqual(res.data.created, 2);
    assert.strictEqual(res.data.skipped, 0);
  } finally {
    mock.restore();
  }
});

test("500-row cap: 501 rows -> 400, nothing written", async () => {
  const posts = [];
  const mock = installFetchMock([
    dedupeRoute([]),
    { test: (u, m) => m === "POST", reply: (u, m, opts) => { posts.push(u); return okr([]); } },
  ]);
  try {
    const rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ name: `Athlete ${i}` }));
    const res = await core.importAthletes({ coachId: COACH, rows, options: {} });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(posts.length, 0, "no writes on an over-cap request");
  } finally {
    mock.restore();
  }
});

test("name required: a nameless row is an error, valid rows still import", async () => {
  const mock = installFetchMock([
    dedupeRoute([]),
    batchInsertRoute(BATCH),
    athleteInsertRoute(),
    batchPatchRoute(),
    ...claimRoutes(),
  ]);
  try {
    const res = await core.importAthletes({
      coachId: COACH,
      rows: [
        { name: "Has Name", parent_email: "a@example.com" },
        { name: "   ", parent_email: "b@example.com" },
        { parent_email: "c@example.com" },
      ],
      options: {},
    });
    assert.strictEqual(res.data.created, 1);
    assert.strictEqual(res.data.errors.length, 2);
    assert.deepStrictEqual(res.data.errors.map((e) => e.row).sort(), [1, 2]);
    assert.strictEqual(res.data.errors[0].reason, "name is required");
  } finally {
    mock.restore();
  }
});

test("dry_run: returns a full plan and writes nothing", async () => {
  const writes = [];
  const mock = installFetchMock([
    dedupeRoute([{ id: crypto.randomUUID(), name: "Existing", parent_email: "dup@example.com" }]),
    { test: (u, m) => m === "POST" || m === "PATCH" || m === "DELETE", reply: (u) => { writes.push(u); return okr([]); } },
  ]);
  try {
    const res = await core.importAthletes({
      coachId: COACH,
      rows: [
        { name: "New One", parent_email: "new@example.com" },
        { name: "Dup One", parent_email: "dup@example.com" },
        { name: "" },
      ],
      options: { dry_run: true },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.batch_id, null);
    assert.strictEqual(res.data.created, 1);
    assert.strictEqual(res.data.skipped, 1);
    assert.strictEqual(res.data.claim_links.length, 0);
    assert.strictEqual(res.data.plan.length, 3, "plan has a row per input row");
    const byRow = Object.fromEntries(res.data.plan.map((p) => [p.row, p.action]));
    assert.strictEqual(byRow[0], "new");
    assert.strictEqual(byRow[1], "duplicate");
    assert.strictEqual(byRow[2], "error");
    assert.strictEqual(writes.length, 0, "dry_run must not write");
  } finally {
    mock.restore();
  }
});

test("claim mint fail-soft: a null token yields url:null, import still succeeds", async () => {
  const mock = installFetchMock([
    dedupeRoute([]),
    batchInsertRoute(BATCH),
    athleteInsertRoute(),
    batchPatchRoute(),
    { test: (u, m) => m === "GET" && u.includes("/athlete_claims"), reply: () => okr([]) },
    { test: (u, m) => m === "POST" && u.includes("/athlete_claims"), reply: () => okr(null, 500) }, // mint fails
  ]);
  try {
    const res = await core.importAthletes({
      coachId: COACH,
      rows: [{ name: "Linkless", parent_email: "x@example.com" }],
      options: {},
    });
    assert.strictEqual(res.data.created, 1);
    assert.strictEqual(res.data.claim_links.length, 1);
    assert.strictEqual(res.data.claim_links[0].url, null, "mint failure -> url null, not a thrown import");
  } finally {
    mock.restore();
  }
});

test("dedupe read is tenant-scoped (coach_id pinned in the query)", async () => {
  const mock = installFetchMock([
    dedupeRoute([]),
    batchInsertRoute(BATCH),
    athleteInsertRoute(),
    batchPatchRoute(),
    ...claimRoutes(),
  ]);
  try {
    await core.importAthletes({
      coachId: COACH,
      rows: [{ name: "T", parent_email: "t@example.com" }],
      options: {},
    });
    const dedupeCall = mock.calls.find((c) => c.u.includes("parent_email=in."));
    assert.ok(dedupeCall, "a dedupe lookup happened");
    assert.ok(dedupeCall.u.includes(`coach_id=eq.${COACH}`), "dedupe read pins coach_id");
  } finally {
    mock.restore();
  }
});

test("batches inserts of 200: 250 new rows -> 2 athlete POSTs", async () => {
  let athletePosts = 0;
  const mock = installFetchMock([
    dedupeRoute([]),
    batchInsertRoute(BATCH),
    {
      test: (u, m) => m === "POST" && u.includes("/athletes"),
      reply: (u, m, opts) => {
        athletePosts += 1;
        const body = JSON.parse(opts.body);
        assert.ok(body.length <= 200, "no chunk exceeds 200");
        return okr(body.map((r) => ({ id: crypto.randomUUID(), name: r.name })));
      },
    },
    batchPatchRoute(),
    ...claimRoutes(),
  ]);
  try {
    const rows = Array.from({ length: 250 }, (_, i) => ({ name: `Athlete ${i}` }));
    const res = await core.importAthletes({ coachId: COACH, rows, options: {} });
    assert.strictEqual(res.data.created, 250);
    assert.strictEqual(athletePosts, 2, "250 rows -> two batches of <=200");
  } finally {
    mock.restore();
  }
});

// ===========================================================================
// undoImport
// ===========================================================================

test("undoImport: deletes unclaimed athletes, skips claimed + paid, flips status", async () => {
  const claimedId = crypto.randomUUID();
  const paidId = crypto.randomUUID();
  const freeId = crypto.randomUUID();
  let statusFlipped = false;
  let deletedIds = [];
  const mock = installFetchMock([
    { // batch lookup
      test: (u, m) => m === "GET" && u.includes("/athlete_imports") && u.includes("id=eq."),
      reply: () => okr([{ id: BATCH, status: "complete" }]),
    },
    { // athletes carrying the batch
      test: (u, m) => m === "GET" && u.includes("/athletes?") && u.includes("import_batch_id=eq."),
      reply: () => okr([
        { id: claimedId, user_id: crypto.randomUUID() }, // claimed -> keep
        { id: paidId, user_id: null }, // has a payment -> keep
        { id: freeId, user_id: null }, // free -> delete
      ]),
    },
    { test: (u, m) => m === "GET" && u.includes("/payments"), reply: () => okr([{ athlete_id: paidId }]) },
    { test: (u, m) => m === "GET" && u.includes("/package_purchases"), reply: () => okr([]) },
    {
      test: (u, m) => m === "DELETE" && u.includes("/athletes"),
      reply: (u) => {
        deletedIds = (u.match(/in\.\(([^)]*)\)/) || [, ""])[1].split(",");
        return okr([{ id: freeId }]);
      },
    },
    {
      test: (u, m) => m === "PATCH" && u.includes("/athlete_imports"),
      reply: () => { statusFlipped = true; return okr([]); },
    },
  ]);
  try {
    const res = await undoImport({ coachId: COACH, batchId: BATCH });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.deleted, 1, "only the free, unclaimed athlete is removed");
    assert.strictEqual(res.data.skipped, 2);
    assert.ok(statusFlipped, "batch flipped to undone");
    assert.ok(deletedIds.includes(freeId) && !deletedIds.includes(claimedId) && !deletedIds.includes(paidId));
  } finally {
    mock.restore();
  }
});

test("undoImport: a foreign / unknown batch id -> 404, no deletes", async () => {
  let deletes = 0;
  const mock = installFetchMock([
    { test: (u, m) => m === "GET" && u.includes("/athlete_imports"), reply: () => okr([]) },
    { test: (u, m) => m === "DELETE", reply: () => { deletes += 1; return okr([]); } },
  ]);
  try {
    const res = await undoImport({ coachId: COACH, batchId: crypto.randomUUID() });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(deletes, 0);
  } finally {
    mock.restore();
  }
});

test("undoImport: already-undone batch is idempotent (0 deleted)", async () => {
  const mock = installFetchMock([
    { test: (u, m) => m === "GET" && u.includes("/athlete_imports"), reply: () => okr([{ id: BATCH, status: "undone" }]) },
  ]);
  try {
    const res = await undoImport({ coachId: COACH, batchId: BATCH });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.deleted, 0);
    assert.strictEqual(res.data.already_undone, true);
  } finally {
    mock.restore();
  }
});

test("undoImport: a malformed batch id -> 404 without a DB call", async () => {
  const mock = installFetchMock([]);
  try {
    const res = await undoImport({ coachId: COACH, batchId: "not-a-uuid" });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("listImports: returns the coach's batches newest-first payload", async () => {
  const mock = installFetchMock([
    {
      test: (u, m) => m === "GET" && u.includes("/athlete_imports"),
      reply: (u) => {
        assert.ok(u.includes(`coach_id=eq.${COACH}`), "list is tenant-scoped");
        assert.ok(u.includes("order=created_at.desc"), "newest first");
        return okr([{ id: BATCH, source: "paste", created_count: 3, status: "complete" }]);
      },
    },
  ]);
  try {
    const res = await listImports({ coachId: COACH });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.imports.length, 1);
    assert.strictEqual(res.data.imports[0].id, BATCH);
  } finally {
    mock.restore();
  }
});
