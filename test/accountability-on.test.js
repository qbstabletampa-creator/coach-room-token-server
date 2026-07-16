const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "service-key";
process.env.ACCOUNTABILITY_PUBLIC_URL = "https://homework.test/";

const { buildAccountabilityHandlers, completionTokenExpiry, validDate } = require("../lib/accountability");

const COACH = "11111111-1111-4111-8111-111111111111";
const ATHLETE = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const HOMEWORK = "44444444-4444-4444-8444-444444444444";
const SESSION = "55555555-5555-4555-8555-555555555555";
const TOKEN = "66666666-6666-4666-8666-666666666666";
const USER = "77777777-7777-4777-8777-777777777777";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const NOW = new Date("2026-07-16T12:00:00.000Z");

function athlete(overrides = {}) {
  return { id: ATHLETE, coach_id: COACH, name: "Avery", parent_email: "parent@example.com", user_id: USER, ...overrides };
}
function row(overrides = {}) {
  return { id: HOMEWORK, coach_id: COACH, athlete_id: ATHLETE, session_id: null,
    title: "Footwork", detail: "Three clean sets", due_date: null, status: "assigned",
    completed_at: null, completed_via: null, created_at: "2026-07-16T12:00:00.000Z",
    complete_token: TOKEN, complete_token_expires_at: "2026-10-14T12:00:00.000Z",
    athletes: { id: ATHLETE, name: "Avery", user_id: USER, parent_email: "parent@example.com" }, ...overrides };
}
function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => typeof body === "string" ? body : JSON.stringify(body) };
}
function mockFetch(fn) {
  const previous = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined, options };
    calls.push(call);
    return fn(call, calls);
  };
  return { calls, restore() { global.fetch = previous; } };
}
function req(overrides = {}) { return { body: {}, query: {}, params: {}, headers: { "content-type": "application/json" }, ...overrides }; }
function res() {
  return { statusCode: 200, body: undefined, headers: {}, contentType: null,
    status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; },
    set(value) { Object.assign(this.headers, value); return this; }, type(value) { this.contentType = value; return this; },
    send(value) { this.body = value; return this; } };
}
async function renderPageData(page, data) {
  const elements = new Map();
  for (const match of page.matchAll(/<(h1|p|button)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const classes = new Set(/\bclass="([^"]*)"/.exec(match[0])?.[1].split(/\s+/).filter(Boolean) || []);
    elements.set(match[2], { tagName: match[1], id: match[2], textContent: "", disabled: false,
      classList: { add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        toggle: (name, force) => force ? classes.add(name) : classes.delete(name) },
      addEventListener() {} });
  }
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1];
  assert.ok(script, "page script parsed");
  vm.runInNewContext(script, {
    document: { getElementById: (id) => elements.get(id) }, location: { pathname: "/hw/token" },
    fetch: async () => ({ ok: true, status: 200, json: async () => data }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const encode = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  const outerHTML = (id) => { const el = elements.get(id); return `<${el.tagName} id="${id}">${encode(el.textContent)}</${el.tagName}>`; };
  return { elements, outerHTML };
}
function coachAuth() { return async () => ({ user: { id: COACH, app_metadata: { role: "coach" }, user_metadata: { role: "athlete" } } }); }
function athleteAuth() { return async () => ({ user: { id: USER, app_metadata: {}, user_metadata: { role: "coach" } } }); }
function handlers(extra = {}) {
  return buildAccountabilityHandlers({ requireSupabaseUser: coachAuth(), now: () => new Date(NOW), randomUUID: () => TOKEN, ...extra });
}

test("factory has exactly six inert handlers and pure helper exports", () => {
  let calls = 0;
  const built = buildAccountabilityHandlers({ requireSupabaseUser: () => { calls++; }, notify: () => { calls++; },
    sendEmail: () => { calls++; }, now: () => { calls++; }, randomUUID: () => { calls++; } });
  assert.deepEqual(Object.keys(built), ["postHomework", "getHomework", "postHomeworkDone", "getPublicPage", "getPublicHomework", "postPublicDone"]);
  assert.equal(calls, 0);
});

test("validation precedes auth and DB for every protected shape", async () => {
  let auths = 0;
  const built = handlers({ requireSupabaseUser: async () => { auths++; return { error: "no", status: 401 }; } });
  const cases = [
    [built.postHomework, req({ body: { athlete_id: ATHLETE, title: "x", coach_id: COACH } }), "invalid_body"],
    [built.getHomework, req({ query: { status: ["done", "assigned"] } }), "invalid_query"],
    [built.postHomeworkDone, req({ params: { id: "bad" }, body: {} }), "invalid_id"],
    [built.postHomeworkDone, req({ params: { id: HOMEWORK }, body: { status: "done" } }), "invalid_body"],
  ];
  for (const [handler, request, code] of cases) {
    const out = res(); await handler(request, out);
    assert.deepEqual([out.statusCode, out.body], [400, { error: code }]);
  }
  assert.equal(auths, 0);
});

test("date and expiry helpers cover leap, past, year boundary, and no due", () => {
  assert.equal(validDate("2028-02-29"), true);
  assert.equal(validDate("2027-02-29"), false);
  assert.equal(validDate("2026-02-30"), false);
  assert.equal(completionTokenExpiry("2026-07-16T12:00:00Z", null), "2026-10-14T12:00:00.000Z");
  assert.equal(completionTokenExpiry("2026-07-16T12:00:00Z", "2026-01-01"), "2026-08-15T12:00:00.000Z");
  assert.equal(completionTokenExpiry("2026-12-20T12:00:00Z", "2027-01-31"), "2027-03-03T00:00:00.000Z");
  assert.equal(completionTokenExpiry("2028-01-01T00:00:00Z", "2028-02-29"), "2028-03-31T00:00:00.000Z");
});

test("assignment double-checks ownership/session, normalizes, rereads, and notifies exactly", async () => {
  const notices = [];
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("/athletes?") && url.includes(`id=eq.${ATHLETE}`)) {
      assert.match(url, new RegExp(`coach_id=eq\\.${COACH}`)); return response([athlete()]);
    }
    if (url.includes("/sessions?")) {
      assert.match(url, new RegExp(`coach_id=eq\\.${COACH}`)); assert.match(url, new RegExp(`athlete_id=eq\\.${ATHLETE}`)); return response([{ id: SESSION }]);
    }
    if (url.endsWith("/homework") && method === "POST") {
      assert.deepEqual(body, { coach_id: COACH, athlete_id: ATHLETE, session_id: SESSION, drill_block_id: null,
        title: "Footwork", detail: null, due_date: "2026-07-20", status: "assigned", complete_token: TOKEN,
        complete_token_expires_at: "2026-08-20T00:00:00.000Z" });
      return response([{ id: HOMEWORK }]);
    }
    if (url.includes("/homework?") && method === "GET") {
      assert.match(url, new RegExp(`id=eq\\.${HOMEWORK}.*coach_id=eq\\.${COACH}`));
      return response([row({ session_id: SESSION, detail: null, due_date: "2026-07-20" })]);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await handlers({ notify: async (event) => notices.push(event) }).postHomework(req({ body: {
      athlete_id: ATHLETE, session_id: SESSION, title: "  Footwork  ", detail: "  ", due_date: " 2026-07-20 ",
    } }), out);
    assert.equal(out.statusCode, 201);
    assert.equal(out.body.complete_url, `https://homework.test/hw/${TOKEN}`);
    assert.equal(JSON.stringify(out.body).includes("complete_token"), false);
    assert.deepEqual(notices, [{ userId: USER, type: "homework.assigned", title: "New homework",
      body: `Footwork\nMark it done: https://homework.test/hw/${TOKEN}`,
      data: { homeworkId: HOMEWORK, href: `https://homework.test/hw/${TOKEN}` },
      dedupeKey: `homework.assigned:${HOMEWORK}`, email: "parent@example.com" }]);
  } finally { mock.restore(); }
});

test("assignment foreign athlete and mismatched session are uniform 404", async () => {
  for (const missSession of [false, true]) {
    const mock = mockFetch(({ url }) => {
      if (url.includes("/athletes?")) return response(missSession ? [athlete()] : []);
      if (url.includes("/sessions?")) return response([]);
      throw new Error("mutation must not run");
    });
    try {
      const out = res(); await handlers().postHomework(req({ body: { athlete_id: ATHLETE, session_id: SESSION, title: "x" } }), out);
      assert.deepEqual([out.statusCode, out.body], [404, { error: "not_found" }]);
      assert.equal(mock.calls.some((c) => c.method === "POST"), false);
    } finally { mock.restore(); }
  }
});

test("assignment conflicts distinguish a vanished FK from a UUID uniqueness failure", async () => {
  for (const [code, expected, expectedAthleteReads] of [["23503", 404, 2], ["23505", 500, 1]]) {
    let athleteReads = 0;
    const mock = mockFetch(({ url, method }) => {
      if (url.includes("/athletes?") && method === "GET") {
        athleteReads++;
        return response(athleteReads === 1 ? [athlete()] : []);
      }
      if (url.endsWith("/homework") && method === "POST") return response({ code }, 409);
      throw new Error(`unexpected ${method} ${url}`);
    });
    try {
      const out = res();
      await handlers().postHomework(req({ body: { athlete_id: ATHLETE, title: "Footwork" } }), out);
      assert.equal(out.statusCode, expected); assert.equal(athleteReads, expectedAthleteReads);
    } finally { mock.restore(); }
  }
});

test("unclaimed assignment emails without fake notify and delivery failure is soft", async () => {
  const notices = [], emails = [];
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("/athletes?")) return response([athlete({ user_id: null })]);
    if (url.endsWith("/homework") && method === "POST") return response([{ id: HOMEWORK }]);
    if (url.includes("/homework?")) return response([row()]);
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res(); await handlers({ notify: async (e) => notices.push(e), sendEmail: async (e) => { emails.push(e); throw new Error("mail down"); } })
      .postHomework(req({ body: { athlete_id: ATHLETE, title: "Footwork" } }), out);
    assert.equal(out.statusCode, 201); assert.equal(notices.length, 0); assert.equal(emails.length, 1);
    assert.equal(emails[0].to, "parent@example.com"); assert.match(emails[0].html, /Footwork/);
  } finally { mock.restore(); }
});

test("board begins with coach filter, validates foreign filter, strips secrets, and preserves empty", async () => {
  let mode = "rows";
  const mock = mockFetch(({ url }) => {
    if (url.includes("/athletes?")) return response(mode === "foreign" ? [] : [{ id: ATHLETE }]);
    assert.match(url, new RegExp(`/homework\\?coach_id=eq\\.${COACH}`));
    assert.match(url, /athlete_id=eq\./); assert.match(url, /status=eq.done/); assert.match(url, /order=created_at.desc/);
    return response(mode === "empty" ? [] : [row({ status: "done", completed_at: NOW.toISOString(), completed_via: "coach" })]);
  });
  try {
    let out = res(); await handlers().getHomework(req({ query: { athlete_id: ATHLETE, status: "done" } }), out);
    assert.equal(out.statusCode, 200); assert.equal(out.body.homework.length, 1);
    for (const secret of ["coach_id", "athlete_id", "complete_token", "parent_email", "user_id", "complete_url"]) assert.equal(JSON.stringify(out.body).includes(`\"${secret}\"`), false);
    mode = "empty"; out = res(); await handlers().getHomework(req({ query: { athlete_id: ATHLETE, status: "done" } }), out); assert.deepEqual(out.body, { homework: [] });
    mode = "foreign"; out = res(); await handlers().getHomework(req({ query: { athlete_id: OTHER } }), out); assert.deepEqual([out.statusCode, out.body], [404, { error: "not_found" }]);
  } finally { mock.restore(); }
});

test("claimed-athlete identity uses exactly one server row and completion double-filters", async () => {
  const notices = [];
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("athletes?user_id=")) { assert.match(url, /limit=2/); return response([athlete()]); }
    if (url.includes("/homework?") && method === "GET") {
      assert.match(url, new RegExp(`coach_id=eq\\.${COACH}`)); assert.match(url, new RegExp(`athlete_id=eq\\.${ATHLETE}`)); return response([row({ status: body ? "done" : "assigned" })]);
    }
    if (method === "PATCH") {
      assert.match(url, new RegExp(`id=eq\\.${HOMEWORK}.*coach_id=eq\\.${COACH}.*athlete_id=eq\\.${ATHLETE}.*status=eq.assigned`));
      assert.deepEqual(body, { status: "done", completed_at: NOW.toISOString(), completed_via: "athlete_app" }); return response([{ id: HOMEWORK }]);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res(); const built = handlers({ requireSupabaseUser: athleteAuth(), notify: async (e) => notices.push(e) });
    await built.postHomeworkDone(req({ params: { id: HOMEWORK }, body: {} }), out);
    assert.equal(out.statusCode, 200); assert.equal(notices.length, 1);
    assert.deepEqual(notices[0], { userId: COACH, type: "homework.completed", title: "Homework completed",
      body: "Avery completed Footwork.", data: { homeworkId: HOMEWORK, athleteId: ATHLETE, href: "/homework" }, dedupeKey: `homework.completed:${HOMEWORK}` });
  } finally { mock.restore(); }
});

test("ambiguous claimed-athlete identity is forbidden before homework access", async () => {
  const mock = mockFetch(({ url }) => {
    assert.match(url, /athletes\?user_id=.*limit=2/);
    return response([athlete(), athlete({ id: OTHER })]);
  });
  try {
    const out = res();
    await handlers({ requireSupabaseUser: athleteAuth() }).postHomeworkDone(req({ params: { id: HOMEWORK }, body: {} }), out);
    assert.deepEqual([out.statusCode, out.body], [403, { error: "forbidden" }]);
    assert.equal(mock.calls.length, 1);
  } finally { mock.restore(); }
});

test("coach completion wins without emitting a completion notification", async () => {
  let reads = 0, notices = 0;
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("/homework?") && method === "GET") {
      reads++;
      return response([row({ status: reads === 1 ? "assigned" : "done", completed_at: reads === 1 ? null : NOW.toISOString(), completed_via: reads === 1 ? null : "coach" })]);
    }
    if (method === "PATCH") return response([{ id: HOMEWORK }]);
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await handlers({ notify: async () => { notices++; } }).postHomeworkDone(req({ params: { id: HOMEWORK }, body: {} }), out);
    assert.equal(out.statusCode, 200); assert.equal(out.body.homework.completed_via, "coach"); assert.equal(notices, 0);
  } finally { mock.restore(); }
});

test("completion PATCH conflicts remain internal errors for either database code", async () => {
  for (const code of ["23503", "23505"]) {
    const mock = mockFetch(({ url, method }) => {
      if (url.includes("/homework?") && method === "GET") return response([row()]);
      if (method === "PATCH") return response({ code }, 409);
      throw new Error(`unexpected ${method} ${url}`);
    });
    try {
      const out = res();
      await handlers().postHomeworkDone(req({ params: { id: HOMEWORK }, body: {} }), out);
      assert.deepEqual([out.statusCode, out.body], [500, { error: "internal_error" }]);
    } finally { mock.restore(); }
  }
});

test("completion PATCH loser rereads honestly; vanished is 404 and done is idempotent", async () => {
  for (const vanished of [false, true]) {
    let reads = 0; const notices = [];
    const mock = mockFetch(({ url, method }) => {
      if (url.includes("athletes?user_id=")) return response([athlete()]);
      if (url.includes("/homework?") && method === "GET") {
        reads++; if (reads === 1) return response([row()]);
        return response(vanished ? [] : [row({ status: "done", completed_at: NOW.toISOString(), completed_via: "athlete_app" })]);
      }
      if (method === "PATCH") return response([]);
      throw new Error(`unexpected ${method} ${url}`);
    });
    try {
      const out = res(); await handlers({ requireSupabaseUser: athleteAuth(), notify: async (e) => notices.push(e) })
        .postHomeworkDone(req({ params: { id: HOMEWORK }, body: {} }), out);
      assert.equal(out.statusCode, vanished ? 404 : 200); assert.equal(notices.length, 0);
    } finally { mock.restore(); }
  }
});

test("authenticated lost PATCH response retry is idempotent without a second notify", async () => {
  let state = "assigned", notices = 0;
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("athletes?user_id=")) return response([athlete()]);
    if (url.includes("/homework?") && method === "GET") return response([row({ status: state,
      completed_at: state === "done" ? NOW.toISOString() : null, completed_via: state === "done" ? "athlete_app" : null })]);
    if (method === "PATCH") { state = "done"; throw new TypeError("response dropped after commit"); }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const built = handlers({ requireSupabaseUser: athleteAuth(), notify: async () => { notices++; } });
    let out = res(); await built.postHomeworkDone(req({ params: { id: HOMEWORK }, body: {} }), out);
    assert.deepEqual([out.statusCode, out.body], [500, { error: "internal_error" }]); assert.equal(notices, 0);
    out = res(); await built.postHomeworkDone(req({ params: { id: HOMEWORK }, body: {} }), out);
    assert.equal(out.statusCode, 200); assert.equal(notices, 0);
  } finally { mock.restore(); }
});

test("malformed/unknown/expired public tokens are identical one-lookup 404s", async () => {
  for (const [token, stored] of [["bad", null], [OTHER, null], [TOKEN, row({ complete_token_expires_at: "2020-01-01T00:00:00Z" })]]) {
    const mock = mockFetch(({ url }) => { assert.match(url, /homework\?complete_token=eq\./); return response(stored ? [stored] : []); });
    try {
      const out = res(); await handlers().getPublicHomework(req({ params: { completeToken: token } }), out);
      assert.deepEqual([out.statusCode, out.body], [404, { error: "not_found" }]); assert.equal(mock.calls.length, 1);
      if (token === "bad") assert.match(mock.calls[0].url, new RegExp(ZERO_UUID));
    } finally { mock.restore(); }
  }
});

test("public completion requires JSON and validates its exact body before lookup", async () => {
  let calls = 0;
  const mock = mockFetch(() => { calls++; return response([]); });
  try {
    let out = res(); await handlers().postPublicDone(req({ headers: {}, params: { completeToken: TOKEN }, body: {} }), out);
    assert.deepEqual([out.statusCode, out.body], [400, { error: "invalid_body" }]);
    out = res(); await handlers().postPublicDone(req({ params: { completeToken: TOKEN }, body: { coach_id: COACH } }), out);
    assert.deepEqual([out.statusCode, out.body], [400, { error: "invalid_body" }]); assert.equal(calls, 0);
  } finally { mock.restore(); }
});

test("public DTO is whitelisted and done consumes all text", async () => {
  for (const status of ["assigned", "done"]) {
    const mock = mockFetch(() => response([row({ status })]));
    try {
      const out = res(); await handlers().getPublicHomework(req({ params: { completeToken: TOKEN } }), out);
      assert.deepEqual(out.body, status === "done" ? { state: "completed" } : { state: "assigned", homework: { title: "Footwork", detail: "Three clean sets" } });
      for (const leak of [COACH, ATHLETE, HOMEWORK, "due_date", "completed_at"]) assert.equal(JSON.stringify(out.body).includes(leak), false);
      assert.equal(out.headers["Cache-Control"], "no-store, max-age=0");
    } finally { mock.restore(); }
  }
});

test("public completion repeats all authority filters and notifies fail-soft", async () => {
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("complete_token=eq") && method === "GET") return response([row()]);
    if (method === "PATCH") {
      for (const fragment of [`id=eq.${HOMEWORK}`, `coach_id=eq.${COACH}`, `complete_token=eq.${TOKEN}`, "status=eq.assigned", "complete_token_expires_at=gt."]) assert.ok(url.includes(fragment), fragment);
      assert.deepEqual(body, { status: "done", completed_at: NOW.toISOString(), completed_via: "tap" }); return response([{ id: HOMEWORK }]);
    }
    if (url.includes(`id=eq.${HOMEWORK}`) && method === "GET") {
      assert.match(url, /select=id%2Ccoach_id%2Cathlete_id%2Ctitle|select=id,coach_id,athlete_id,title/);
      assert.doesNotMatch(url, /athletes\(/);
      return response([row({ status: "done", athletes: undefined })]);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res(); await handlers({ notify: async () => { throw new Error("push down"); } }).postPublicDone(req({ params: { completeToken: TOKEN }, body: {} }), out);
    assert.deepEqual([out.statusCode, out.body], [200, { state: "completed" }]);
  } finally { mock.restore(); }
});

test("winning public PATCH stays completed when notification enrichment fails", async () => {
  let notices = 0;
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("complete_token=eq") && method === "GET") return response([row()]);
    if (method === "PATCH") return response([{ id: HOMEWORK }]);
    if (url.includes(`id=eq.${HOMEWORK}`) && method === "GET") return response({ message: "read down" }, 500);
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await handlers({ notify: async () => { notices++; } }).postPublicDone(req({ params: { completeToken: TOKEN }, body: {} }), out);
    assert.deepEqual([out.statusCode, out.body], [200, { state: "completed" }]); assert.equal(notices, 0);
  } finally { mock.restore(); }
});

test("public concurrent completion elects one PATCH winner and both return completed", async () => {
  let state = "assigned", patchCalls = 0, notices = 0;
  const initial = [];
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("complete_token=eq") && method === "GET") {
      if (initial.length < 2) return new Promise((resolve) => { initial.push(resolve); if (initial.length === 2) for (const done of initial) done(response([row({ status: "assigned" })])); });
      return response([row({ status: state, completed_at: state === "done" ? NOW.toISOString() : null })]);
    }
    if (method === "PATCH") { patchCalls++; if (state === "done") return response([]); state = "done"; return response([{ id: HOMEWORK }]); }
    if (url.includes(`id=eq.${HOMEWORK}`)) return response([row({ status: "done" })]);
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const built = handlers({ notify: async () => { notices++; } }); const a = res(), b = res();
    await Promise.all([built.postPublicDone(req({ params: { completeToken: TOKEN }, body: {} }), a), built.postPublicDone(req({ params: { completeToken: TOKEN }, body: {} }), b)]);
    assert.deepEqual([a.statusCode, b.statusCode], [200, 200]); assert.equal(patchCalls, 2);
    assert.equal(notices, 1);
  } finally { mock.restore(); }
});

test("public lost PATCH response retry is idempotent without a second notify", async () => {
  let state = "assigned", notices = 0;
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("complete_token=eq") && method === "GET") return response([row({ status: state,
      completed_at: state === "done" ? NOW.toISOString() : null })]);
    if (method === "PATCH") { state = "done"; throw new TypeError("response dropped after commit"); }
    if (url.includes(`id=eq.${HOMEWORK}`)) return response([row({ status: "done" })]);
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const built = handlers({ notify: async () => { notices++; } });
    let out = res(); await built.postPublicDone(req({ params: { completeToken: TOKEN }, body: {} }), out);
    assert.deepEqual([out.statusCode, out.body], [500, { error: "internal_error" }]); assert.equal(notices, 0);
    out = res(); await built.postPublicDone(req({ params: { completeToken: TOKEN }, body: {} }), out);
    assert.deepEqual([out.statusCode, out.body], [200, { state: "completed" }]); assert.equal(notices, 0);
  } finally { mock.restore(); }
});

test("HTML shell is token-invariant, private, accessible, and textContent-only", () => {
  const built = handlers(); const a = res(), b = res();
  built.getPublicPage(req({ params: { completeToken: TOKEN } }), a); built.getPublicPage(req({ params: { completeToken: "evil<script>" } }), b);
  assert.equal(a.body, b.body); assert.equal(a.contentType, "html"); assert.equal(a.headers["Referrer-Policy"], "no-referrer");
  assert.equal(a.headers["X-Robots-Tag"], "noindex, nofollow, noarchive"); assert.match(a.body, /aria-live/); assert.match(a.body, /textContent/);
  assert.doesNotMatch(a.body, /innerHTML|https?:\/\//); assert.doesNotMatch(a.body, new RegExp(TOKEN));
});

test("public page DOM renders malicious title and detail as encoded inert text", async () => {
  const out = res(); handlers().getPublicPage(req({ params: { completeToken: TOKEN } }), out);
  const title = '"><img src=x onerror="globalThis.pwned=1">';
  const detail = "<script>globalThis.pwned=2</script><a href='javascript:pwned()'>x</a>";
  const dom = await renderPageData(out.body, { state: "assigned", homework: { title, detail } });
  const rendered = `${dom.outerHTML("title")} ${dom.outerHTML("detail")}`;
  assert.match(rendered, /&quot;&gt;&lt;img src=x onerror=&quot;globalThis\.pwned=1&quot;&gt;/);
  assert.match(rendered, /&lt;script&gt;globalThis\.pwned=2&lt;\/script&gt;/);
  assert.match(rendered, /&lt;a href=&#39;javascript:pwned\(\)&#39;&gt;x&lt;\/a&gt;/);
  assert.doesNotMatch(rendered, /<img|<script|javascript:pwned\(\)'/);
});

test("configuration/auth/PostgREST/network failures use frozen envelopes", async () => {
  const old = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  let out = res(); await handlers().getHomework(req(), out); assert.deepEqual([out.statusCode, out.body], [503, { error: "not_configured" }]);
  process.env.SUPABASE_URL = old;
  out = res(); await handlers({ requireSupabaseUser: async () => ({ status: 401, error: "bad_token" }) }).getHomework(req(), out); assert.deepEqual([out.statusCode, out.body], [401, { error: "bad_token" }]);
  let mock = mockFetch(() => response({ message: "down" }, 500));
  try { out = res(); await handlers().getHomework(req(), out); assert.deepEqual([out.statusCode, out.body], [500, { error: "internal_error" }]); } finally { mock.restore(); }
  mock = mockFetch(() => { throw new TypeError("fetch failed"); });
  try { out = res(); await handlers().getHomework(req(), out); assert.deepEqual([out.statusCode, out.body], [500, { error: "internal_error" }]); } finally { mock.restore(); }
  mock = mockFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("truncated JSON"); }, text: async () => "" }));
  try { out = res(); await handlers().getHomework(req(), out); assert.deepEqual([out.statusCode, out.body], [500, { error: "internal_error" }]); } finally { mock.restore(); }
});

test("128 real assignments use unique production UUID-v4 capabilities", async () => {
  const seen = new Set(); let sequence = 0;
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("/athletes?")) return response([athlete({ parent_email: null, user_id: null })]);
    if (url.endsWith("/homework") && method === "POST") {
      assert.match(body.complete_token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      seen.add(body.complete_token); sequence++; return response([{ id: `${String(sequence).padStart(8, "0")}-0000-4000-8000-000000000000` }]);
    }
    if (url.includes("/homework?") && method === "GET") {
      const id = /id=eq\.([^&]+)/.exec(url)[1]; return response([row({ id, complete_token: [...seen][seen.size - 1] })]);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const built = buildAccountabilityHandlers({ requireSupabaseUser: coachAuth(), now: () => new Date(NOW) });
    for (let i = 0; i < 128; i++) {
      const out = res(); await built.postHomework(req({ body: { athlete_id: ATHLETE, title: "x" } }), out); assert.equal(out.statusCode, 201);
    }
    assert.equal(seen.size, 128); assert.equal(mock.calls.filter((call) => call.method === "POST").length, 128);
  } finally { mock.restore(); }
});
