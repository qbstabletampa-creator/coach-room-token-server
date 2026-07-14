// Source-stamp + fail-soft retry unit tests (dashboard 0016 forward-only decree).
// createAthlete stamps acquisition source on the CREATE path and, when the 0016
// `source` column isn't applied yet (42703 / PGRST204), retries the insert WITHOUT
// source so no live booking/purchase lane can break. A MATCH never re-stamps.
// No network, no live creds — global.fetch is mocked per test.

const test = require("node:test");
const assert = require("node:assert");

const {
  createAthlete,
  matchOrCreateAthlete,
  isMissingSourceError,
} = require("../lib/athlete-match.js");

const S = {
  url: "https://test.supabase.co",
  headers: { apikey: "k", authorization: "Bearer k" },
};
const COACH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// Install a fetch mock that records every call (url, method, parsed body) and
// replies via the supplied handler. Returns { calls, restore }.
function installFetch(handler) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), method, body });
    return handler({ url: String(url), method, body, index: calls.length - 1 });
  };
  return { calls, restore() { global.fetch = realFetch; } };
}

function ok(json, status = 201) {
  return { ok: status < 400, status, json: async () => json, text: async () => "" };
}
function err(status, text) {
  return { ok: false, status, json: async () => [], text: async () => text };
}

test("isMissingSourceError: matches 42703 and PGRST204, nothing else", () => {
  assert.equal(isMissingSourceError('{"code":"42703","message":"column source"}'), true);
  assert.equal(isMissingSourceError('{"code":"PGRST204"}'), true);
  assert.equal(isMissingSourceError('{"code":"23505"}'), false);
  assert.equal(isMissingSourceError(""), false);
  assert.equal(isMissingSourceError(null), false);
});

test("createAthlete: stamps source on the first (and only) insert when the column exists", async () => {
  const mock = installFetch(() => ok([{ id: "new-1", name: "Sam" }]));
  try {
    const out = await createAthlete(S, { coachId: COACH, name: "Sam", email: "sam@x.com", source: "guest" });
    assert.deepEqual(out, { id: "new-1", name: "Sam" });
    assert.equal(mock.calls.length, 1, "exactly one insert, no retry");
    assert.equal(mock.calls[0].body.source, "guest");
    assert.equal(mock.calls[0].body.coach_id, COACH);
    assert.equal(mock.calls[0].body.parent_email, "sam@x.com");
  } finally {
    mock.restore();
  }
});

test("createAthlete: retries WITHOUT source on 42703, still creates the athlete", async () => {
  const mock = installFetch(({ index }) =>
    index === 0 ? err(400, '{"code":"42703","message":"column athletes.source does not exist"}')
                : ok([{ id: "new-2", name: "Ana" }]),
  );
  try {
    const out = await createAthlete(S, { coachId: COACH, name: "Ana", email: "ana@x.com", source: "storefront" });
    assert.deepEqual(out, { id: "new-2", name: "Ana" });
    assert.equal(mock.calls.length, 2, "one stamped attempt + one retry");
    assert.equal(mock.calls[0].body.source, "storefront", "first attempt carried source");
    assert.equal("source" in mock.calls[1].body, false, "retry dropped source");
    assert.equal(mock.calls[1].body.parent_email, "ana@x.com");
  } finally {
    mock.restore();
  }
});

test("createAthlete: retries WITHOUT source on PGRST204 (schema cache)", async () => {
  const mock = installFetch(({ index }) =>
    index === 0 ? err(400, '{"code":"PGRST204","message":"Could not find the \'source\' column"}')
                : ok([{ id: "new-3", name: "Kai" }]),
  );
  try {
    const out = await createAthlete(S, { coachId: COACH, name: "Kai", email: "kai@x.com", source: "guest" });
    assert.deepEqual(out, { id: "new-3", name: "Kai" });
    assert.equal(mock.calls.length, 2);
    assert.equal("source" in mock.calls[1].body, false);
  } finally {
    mock.restore();
  }
});

test("createAthlete: a NON-source error does not retry, returns null", async () => {
  const mock = installFetch(() => err(500, '{"code":"XX000","message":"boom"}'));
  try {
    const out = await createAthlete(S, { coachId: COACH, name: "Jo", email: "jo@x.com", source: "guest" });
    assert.equal(out, null);
    assert.equal(mock.calls.length, 1, "no retry on an unrelated failure");
  } finally {
    mock.restore();
  }
});

test("createAthlete: no source passed → single unstamped insert (manual/default lane)", async () => {
  const mock = installFetch(() => ok([{ id: "new-4", name: "Lee" }]));
  try {
    const out = await createAthlete(S, { coachId: COACH, name: "Lee", email: "lee@x.com" });
    assert.deepEqual(out, { id: "new-4", name: "Lee" });
    assert.equal(mock.calls.length, 1);
    assert.equal("source" in mock.calls[0].body, false, "DB default holds when no source given");
  } finally {
    mock.restore();
  }
});

test("matchOrCreateAthlete: MATCH path never stamps source (no create call)", async () => {
  const mock = installFetch(({ method }) =>
    method === "GET"
      ? ok([{ id: "existing-1", user_id: null }], 200)
      : err(500, "should not POST on a match"),
  );
  try {
    const out = await matchOrCreateAthlete(S, { coachId: COACH, email: "hit@x.com", name: "Match", source: "guest" });
    assert.deepEqual(out, { athleteId: "existing-1", userId: null, created: false });
    assert.equal(mock.calls.filter((c) => c.method === "POST").length, 0, "no insert on a match");
  } finally {
    mock.restore();
  }
});

test("matchOrCreateAthlete: CREATE path passes source through to the insert", async () => {
  const mock = installFetch(({ method }) =>
    method === "GET"
      ? ok([], 200) // no existing athlete
      : ok([{ id: "created-1", name: "New Lead" }]),
  );
  try {
    const out = await matchOrCreateAthlete(S, { coachId: COACH, email: "miss@x.com", name: "New Lead", source: "guest" });
    assert.deepEqual(out, { athleteId: "created-1", userId: null, created: true });
    const post = mock.calls.find((c) => c.method === "POST");
    assert.ok(post, "an insert happened");
    assert.equal(post.body.source, "guest");
  } finally {
    mock.restore();
  }
});
