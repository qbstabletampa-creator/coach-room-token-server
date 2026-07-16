const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "service-key";
delete process.env.GROQ_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const { buildAiNotesHandlers } = require("../lib/ai-notes");

const COACH = "11111111-1111-4111-8111-111111111111";
const ATHLETE = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const NOTE = "55555555-5555-4555-8555-555555555555";
const REQUEST = "request_key_000001";
const SHARE = "share_key_00000001";
const CREATED = "2026-07-16T12:00:00.000Z";
const UPDATED = "2026-07-16T12:01:00.000Z";

function response(body = [], status = 200, detail) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return { ok: status >= 200 && status < 300, status,
    json: async () => { if (body instanceof Error) throw body; return body; },
    text: async () => detail === undefined ? bytes.toString() : detail,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}
function mockFetch(handler) {
  const old = global.fetch, calls = [];
  global.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: String(options.method || "GET").toUpperCase(),
      headers: options.headers || {}, rawBody: options.body };
    if (typeof options.body === "string") call.body = JSON.parse(options.body);
    calls.push(call); return handler(call, calls);
  };
  return { calls, restore() { global.fetch = old; } };
}
function res() { return { statusCode: 200, body: null, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } }; }
function req({ params = {}, query = {}, headers = {}, body } = {}) { return { params, query, headers, body }; }
function coachAuth() { return async () => ({ user: { id: COACH, app_metadata: { role: "coach" } } }); }
function session(overrides = {}) { return { id: SESSION, coach_id: COACH, athlete_id: ATHLETE,
  title: "Film review", session_date: "2026-07-16",
  athletes: { id: ATHLETE, name: "Avery", user_id: USER, parent_email: "parent@example.test" }, ...overrides }; }
function note(overrides = {}) { return { id: NOTE, coach_id: COACH, session_id: SESSION, athlete_id: ATHLETE,
  status: "ready", generation_key: REQUEST, generation_started_at: CREATED, transcript: "SECRET",
  notes_body: "Strong base", suggested_next: "Work on balance", homework: [], model: "fake-model",
  stt_model: null, warning_code: null, error_code: null, audio_object_path: null, audio_deleted_at: null,
  share_key: null, shared_at: null, created_at: CREATED, updated_at: UPDATED, ...overrides }; }
function m4a(payload = "memo") { const out = Buffer.alloc(12 + Buffer.byteLength(payload)); out.write("ftyp", 4); out.write(payload, 12); return out; }
function objectPath(requestId = REQUEST) { const hash = require("node:crypto").createHash("sha256").update(requestId).digest("hex");
  return `ai-notes/${COACH}/${SESSION}/${hash}.m4a`; }
function built(overrides = {}) { return buildAiNotesHandlers({ requireSupabaseUser: coachAuth(), notify: async () => {},
  sendEmail: async () => {}, now: () => new Date("2026-07-16T12:05:00.000Z"),
  generateSessionNote: async () => ({ transcript: null, notes_body: "Strong base", suggested_next: "Work on balance",
    homework: [], model: "fake-model", stt_model: null, warning: null }), ...overrides }); }

test("factory exports exactly five handlers and build is inert", () => {
  let effects = 0;
  const handlers = buildAiNotesHandlers({ requireSupabaseUser: async () => { effects++; }, notify: async () => { effects++; },
    sendEmail: async () => { effects++; }, generateSessionNote: async () => { effects++; }, now: () => { effects++; } });
  assert.deepEqual(Object.keys(handlers), ["postAudio", "deleteAudio", "postGenerate", "getNote", "postShare"]);
  assert.equal(effects, 0);
});

test("all handler-visible malformed input wins before auth or fetch", async () => {
  let auth = 0; const old = global.fetch; global.fetch = async () => { throw new Error("fetch forbidden"); };
  const handlers = built({ requireSupabaseUser: async () => { auth++; return coachAuth()(); } });
  const cases = [
    [handlers.postAudio, req({ params: { sessionId: "bad" }, headers: { "content-type": "audio/mp4", "idempotency-key": REQUEST }, body: m4a() })],
    [handlers.deleteAudio, req({ params: { sessionId: SESSION, requestId: "short" } })],
    [handlers.postGenerate, req({ params: { sessionId: SESSION }, body: { request_id: REQUEST, use_audio: "yes", transcript: "attack" } })],
    [handlers.getNote, req({ params: { sessionId: SESSION }, query: { transcript: "1" } })],
    [handlers.postShare, req({ params: { sessionId: SESSION }, body: { share_id: SHARE, note_id: NOTE, expected_updated_at: UPDATED, notes_body: "x", suggested_next: "y", homework: [], coach_id: COACH } })],
  ];
  try { for (const [handler, request] of cases) { const out = res(); await handler(request, out); assert.equal(out.statusCode, 400); } }
  finally { global.fetch = old; }
  assert.equal(auth, 0);
});

test("audio MIME, magic and size checks precede identity", async () => {
  let auth = 0; const handler = built({ requireSupabaseUser: async () => { auth++; return coachAuth()(); } }).postAudio;
  for (const [body, type, status] of [[Buffer.from("not an m4a"), "audio/mp4", 415], [m4a(), "text/plain", 415], [Buffer.alloc(25 * 1024 * 1024 + 1), "audio/mp4", 413]]) {
    const out = res(); await handler(req({ params: { sessionId: SESSION }, headers: { "idempotency-key": REQUEST, "content-type": type }, body }), out); assert.equal(out.statusCode, status);
  }
  assert.equal(auth, 0);
});

test("coach authority comes only from app_metadata and session lookup is tenant-scoped", async () => {
  const old = global.fetch; global.fetch = async () => { throw new Error("fetch forbidden"); };
  try {
    for (const authResult of [{ error: "unauthorized", status: 401 }, { user: { id: USER, app_metadata: {}, user_metadata: { role: "coach" } } }]) {
      const out = res(); await built({ requireSupabaseUser: async () => authResult }).getNote(req({ params: { sessionId: SESSION } }), out);
      assert.equal(out.statusCode, authResult.error ? 401 : 403);
    }
  } finally { global.fetch = old; }
  const mock = mockFetch(({ url }) => { assert.match(url, new RegExp(`sessions\\?id=eq\\.${SESSION}&coach_id=eq\\.${COACH}`)); return response([]); });
  try { const out = res(); await built().getNote(req({ params: { sessionId: SESSION } }), out); assert.deepEqual([out.statusCode, out.body], [404, { error: "not_found" }]); }
  finally { mock.restore(); }
});

test("fresh private audio upload uses the exact hashed tenant path and whitelisted response", async () => {
  const bytes = m4a("same"); const hash = require("node:crypto").createHash("sha256").update(REQUEST).digest("hex");
  const placeholder = note({ status: "generating", generation_started_at: "1970-01-01T00:00:00.000Z",
    transcript: null, notes_body: null, suggested_next: null, homework: [], model: null, audio_object_path: objectPath() });
  let noteReads = 0; const order = [];
  const mock = mockFetch(({ url, method, headers, rawBody, body }) => {
    if (url.includes("/rest/v1/sessions?")) return response([session()]);
    if (url.includes("/rest/v1/ai_session_notes?") && method === "GET") return response(++noteReads === 1 ? [] : [placeholder]);
    if (url.endsWith("/rest/v1/ai_session_notes") && method === "POST") {
      order.push("reserve");
      assert.equal(body.audio_object_path, objectPath()); assert.equal(body.generation_started_at, "1970-01-01T00:00:00.000Z");
      return response([placeholder]);
    }
    if (url.includes("/storage/") && method === "POST") {
      order.push("upload"); assert.match(url, new RegExp(`/storage/v1/object/session-audio/ai-notes/${COACH}/${SESSION}/${hash}\\.m4a$`));
      assert.equal(headers["content-type"], "audio/mp4"); assert.equal(headers["x-upsert"], "false"); assert.equal(rawBody, bytes); return response({ Key: "private" });
    }
    order.push("verify"); assert.equal(method, "PATCH"); assert.match(url, /audio_object_path=eq\.ai-notes%2F/);
    assert.deepEqual(body, { audio_object_path: objectPath() }); return response([placeholder]);
  });
  try { const out = res(); await built().postAudio(req({ params: { sessionId: SESSION }, headers: { "idempotency-key": REQUEST, "content-type": "audio/m4a" }, body: bytes }), out);
    assert.deepEqual([out.statusCode, out.body], [201, { audio: { request_id: REQUEST } }]);
    assert.deepEqual(order, ["reserve", "upload", "verify"]); assert.doesNotMatch(JSON.stringify(out.body), /path|bucket|url|hash/i); }
  finally { mock.restore(); }
});

test("existing pending row reserves with a status and generation CAS before upload", async () => {
  const pending = note({ status: "generating", generation_started_at: "1970-01-01T00:00:00.000Z",
    transcript: null, notes_body: null, suggested_next: null, homework: [], model: null });
  const reserved = { ...pending, audio_object_path: objectPath() };
  let state = pending; const order = [];
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("/sessions?")) return response([session()]);
    if (url.includes("/ai_session_notes?") && method === "GET") return response([state]);
    if (url.includes("/ai_session_notes?") && method === "PATCH") {
      const step = url.includes("audio_object_path=is.null") ? "reserve" : "verify";
      order.push(step); assert.match(url, /status=eq\.generating/);
      assert.match(url, new RegExp(`generation_key=eq\\.${REQUEST}`));
      assert.match(url, /generation_started_at=eq\.1970-01-01T00%3A00%3A00\.000Z/);
      assert.match(url, step === "reserve" ? /audio_object_path=is\.null/ : /audio_object_path=eq\.ai-notes%2F/);
      assert.deepEqual(body, { audio_object_path: objectPath() });
      state = reserved; return response([state]);
    }
    if (url.includes("/storage/") && method === "POST") { order.push("upload"); return response({ Key: "private" }); }
    throw new Error(`${method} ${url}`);
  });
  try {
    const out = res(); await built().postAudio(req({ params: { sessionId: SESSION }, headers: {
      "idempotency-key": REQUEST, "content-type": "audio/mp4" }, body: m4a() }), out);
    assert.deepEqual([out.statusCode, out.body], [201, { audio: { request_id: REQUEST } }]);
    assert.deepEqual(order, ["reserve", "upload", "verify"]);
  } finally { mock.restore(); }
});

test("audio 409 accepts equal bytes only and maps unequal bytes to pinned conflict", async () => {
  for (const [stored, status, code] of [[m4a("same"), 200, undefined], [m4a("other"), 409, "audio_request_conflict"]]) {
    const input = m4a("same");
    const placeholder = note({ status: "generating", generation_started_at: "1970-01-01T00:00:00.000Z",
      transcript: null, notes_body: null, suggested_next: null, homework: [], model: null, audio_object_path: objectPath() });
    let noteReads = 0;
    const mock = mockFetch(({ url, method, body }) => { if (url.includes("/sessions?")) return response([session()]);
      if (method === "POST" && url.includes("/storage/")) return response({}, 409, JSON.stringify({ code: "Duplicate" }));
      if (method === "GET" && url.includes("/storage/")) return response(stored);
      if (method === "GET" && url.includes("/ai_session_notes?")) return response(++noteReads === 1 ? [] : [placeholder]);
      if (method === "POST" && url.endsWith("/ai_session_notes")) return response([placeholder]);
      if (method === "PATCH" && url.includes("/ai_session_notes?")) {
        assert.match(url, /audio_object_path=eq\.ai-notes%2F/); assert.deepEqual(body, { audio_object_path: objectPath() });
        return response([placeholder]);
      }
      throw new Error(`unexpected ${method} ${url}`); });
    try { const out = res(); await built().postAudio(req({ params: { sessionId: SESSION }, headers: { "idempotency-key": REQUEST, "content-type": "audio/mp4" }, body: input }), out);
      assert.equal(out.statusCode, status); assert.equal(out.body.error, code); }
    finally { mock.restore(); }
  }
});

test("delete targets one derived object, never lists, and storage rejection is 502", async () => {
  for (const storageStatus of [404, 503]) {
    const mock = mockFetch(({ url, method }) => { if (url.includes("/sessions?")) return response([session()]);
      if (url.includes("/ai_session_notes?") && method === "GET") return response([]);
      assert.equal(method, "DELETE"); assert.doesNotMatch(url, /list|sign|public/); return response({}, storageStatus,
        storageStatus === 404 ? JSON.stringify({ message: "Object not found" }) : undefined); });
    try { const out = res(); await built().deleteAudio(req({ params: { sessionId: SESSION, requestId: REQUEST } }), out);
      assert.deepEqual([out.statusCode, out.body], storageStatus === 404 ? [200, { deleted: true }] : [502, { error: "storage_failed" }]); }
    finally { mock.restore(); }
  }
});

test("same terminal generation retry returns stored DTO, strips secrets, and repairs ready notify", async () => {
  const notifications = [], row = note({ transcript: "never return", audio_object_path: null, parent_email: "bad" });
  const mock = mockFetch(({ url }) => { if (url.includes("/sessions?")) return response([session()]); if (url.includes("/ai_session_notes?")) return response([row]); throw new Error(url); });
  try { const out = res(); await built({ notify: async (event) => notifications.push(event), generateSessionNote: async () => { throw new Error("must not call"); } }).postGenerate(
      req({ params: { sessionId: SESSION }, body: { request_id: REQUEST, use_audio: false, typed_recap: "unused" } }), out);
    assert.equal(out.statusCode, 200); assert.deepEqual(Object.keys(out.body.note), ["id", "session_id", "athlete", "status", "notes_body", "suggested_next", "homework", "model", "warning", "failure", "created_at", "updated_at", "shared_at"]);
    assert.doesNotMatch(JSON.stringify(out.body), /transcript|coach_id|generation_key|audio_object_path|parent_email/);
    assert.deepEqual(notifications, [{ userId: COACH, type: "ai_notes.ready", title: "AI session notes ready", body: "Avery's draft is ready to review.",
      data: { noteId: NOTE, sessionId: SESSION, href: `/sessions/${SESSION}/wrap-up` }, dedupeKey: `ai_notes.ready:${NOTE}:${REQUEST}` }]);
  } finally { mock.restore(); }
});

test("terminal row rejects marker reservation with 409 before any storage upload", async () => {
  let storageCalls = 0, patchCalls = 0;
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("/sessions?")) return response([session()]);
    if (url.includes("/ai_session_notes?") && method === "GET") return response([note()]);
    if (url.includes("/storage/")) { storageCalls++; throw new Error("storage must not be called"); }
    if (method === "PATCH") { patchCalls++; throw new Error("terminal marker must not be patched"); }
    throw new Error(`${method} ${url}`);
  });
  try {
    const out = res();
    await built().postAudio(req({ params: { sessionId: SESSION }, headers: {
      "idempotency-key": REQUEST, "content-type": "audio/mp4" }, body: m4a() }), out);
    assert.deepEqual([out.statusCode, out.body], [409, { error: "audio_request_conflict" }]);
    assert.equal(storageCalls, 0); assert.equal(patchCalls, 0);
  } finally { mock.restore(); }
});

test("upload post-check deletes bytes when a terminal transition consumes its reservation", async () => {
  const reserved = note({ status: "generating", generation_started_at: "1970-01-01T00:00:00.000Z",
    notes_body: null, suggested_next: null, homework: [], model: null, transcript: null,
    audio_object_path: objectPath() });
  let state = reserved, objectPresent = false, deletes = 0;
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("/sessions?")) return response([session()]);
    if (url.includes("/ai_session_notes?") && method === "GET") return response([state]);
    if (url.includes("/storage/") && method === "POST") {
      objectPresent = true; state = note({ audio_object_path: null }); return response({ Key: "private" });
    }
    if (url.includes("/storage/") && method === "DELETE") { deletes++; objectPresent = false; return response({}, 204); }
    throw new Error(`${method} ${url}`);
  });
  try {
    const out = res(); await built().postAudio(req({ params: { sessionId: SESSION }, headers: {
      "idempotency-key": REQUEST, "content-type": "audio/mp4" }, body: m4a() }), out);
    assert.deepEqual([out.statusCode, out.body], [409, { error: "audio_request_conflict" }]);
    assert.equal(deletes, 1); assert.equal(objectPresent, false); assert.equal(state.audio_object_path, null);
  } finally { mock.restore(); }
});

test("lost upload ownership re-reserves its exact marker when self-delete fails", async () => {
  const reserved = note({ status: "generating", generation_started_at: "1970-01-01T00:00:00.000Z",
    notes_body: null, suggested_next: null, homework: [], model: null, transcript: null,
    audio_object_path: objectPath() });
  let state = reserved, objectPresent = false, deletes = 0, reReservations = 0;
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("/sessions?")) return response([session()]);
    if (url.includes("/ai_session_notes?") && method === "GET") return response([state]);
    if (url.includes("/storage/") && method === "POST") {
      objectPresent = true; state = { ...reserved, audio_object_path: null }; return response({ Key: "private" });
    }
    if (url.includes("/storage/") && method === "DELETE") { deletes++; return response({}, 503); }
    if (url.includes("/ai_session_notes?") && method === "PATCH") {
      reReservations++;
      assert.match(url, new RegExp(`id=eq\\.${NOTE}&coach_id=eq\\.${COACH}&session_id=eq\\.${SESSION}`));
      assert.match(url, /status=eq\.generating/);
      assert.match(url, new RegExp(`generation_key=eq\\.${REQUEST}`));
      assert.match(url, /audio_object_path=is\.null/);
      assert.deepEqual(body, { audio_object_path: objectPath() });
      state = { ...state, audio_object_path: objectPath() };
      return response([state]);
    }
    throw new Error(`${method} ${url}`);
  });
  try {
    const out = res(); await built().postAudio(req({ params: { sessionId: SESSION }, headers: {
      "idempotency-key": REQUEST, "content-type": "audio/mp4" }, body: m4a() }), out);
    assert.deepEqual([out.statusCode, out.body], [502, { error: "storage_failed" }]);
    assert.equal(deletes, 1); assert.equal(reReservations, 1); assert.equal(objectPresent, true);
    assert.equal(state.audio_object_path, objectPath(), "failed self-delete remains tracked for retry cleanup");
  } finally { mock.restore(); }
});

test("delete clears a not-yet-present reservation before upload and POST self-deletes the orphan", async () => {
  const pending = note({ status: "generating", generation_started_at: "1970-01-01T00:00:00.000Z",
    notes_body: null, suggested_next: null, homework: [], model: null, transcript: null });
  const reserved = { ...pending, audio_object_path: objectPath() };
  const cleared = { ...reserved, audio_object_path: null, audio_deleted_at: "2026-07-16T12:05:00.000Z" };
  let state = pending, objectPresent = false, releaseUpload, uploadStartedResolve;
  const uploadStarted = new Promise((resolve) => { uploadStartedResolve = resolve; });
  const uploadRelease = new Promise((resolve) => { releaseUpload = resolve; });
  let storageDeletes = 0, markerClears = 0;
  const mock = mockFetch(async ({ url, method, body }) => {
    if (url.includes("/sessions?")) return response([session()]);
    if (url.includes("/ai_session_notes?") && method === "GET") return response([state]);
    if (url.includes("/ai_session_notes?") && method === "PATCH") {
      if (body.audio_object_path === objectPath()) {
        assert.match(url, /audio_object_path=is\.null/); state = reserved; return response([state]);
      }
      markerClears++; assert.match(url, /audio_object_path=eq\.ai-notes%2F/);
      assert.deepEqual(body, { audio_object_path: null, audio_deleted_at: "2026-07-16T12:05:00.000Z" });
      state = cleared; return response([state]);
    }
    if (url.includes("/storage/") && method === "POST") {
      uploadStartedResolve(); await uploadRelease; objectPresent = true; return response({ Key: "private" });
    }
    if (url.includes("/storage/") && method === "DELETE") {
      storageDeletes++;
      if (!objectPresent) return response({}, 404, JSON.stringify({ message: "Object not found" }));
      objectPresent = false; return response({}, 204);
    }
    throw new Error(`${method} ${url}`);
  });
  try {
    const postOut = res();
    const posting = built().postAudio(req({ params: { sessionId: SESSION }, headers: {
      "idempotency-key": REQUEST, "content-type": "audio/mp4" }, body: m4a() }), postOut);
    await uploadStarted;
    const deleteOut = res();
    await built().deleteAudio(req({ params: { sessionId: SESSION, requestId: REQUEST } }), deleteOut);
    assert.deepEqual([deleteOut.statusCode, deleteOut.body], [200, { deleted: true }]);
    assert.equal(state.audio_object_path, null);
    releaseUpload(); await posting;
    assert.deepEqual([postOut.statusCode, postOut.body], [409, { error: "audio_request_conflict" }]);
    assert.equal(markerClears, 1); assert.equal(storageDeletes, 3);
    assert.equal(objectPresent, false); assert.equal(state.audio_object_path, null);
  } finally { mock.restore(); }
});

test("upload commit before delete leaves neither exact-path object nor marker", async () => {
  const pending = note({ status: "generating", generation_started_at: "1970-01-01T00:00:00.000Z",
    notes_body: null, suggested_next: null, homework: [], model: null, transcript: null });
  const reserved = { ...pending, audio_object_path: objectPath() };
  const cleared = { ...reserved, audio_object_path: null, audio_deleted_at: "2026-07-16T12:05:00.000Z" };
  let state = pending, objectPresent = false, verifyCas = 0, storageDeletes = 0;
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("/sessions?")) return response([session()]);
    if (url.includes("/ai_session_notes?") && method === "GET") return response([state]);
    if (url.includes("/ai_session_notes?") && method === "PATCH") {
      if (body.audio_object_path === objectPath()) {
        if (url.includes("audio_object_path=is.null")) state = reserved;
        else { verifyCas++; assert.match(url, /audio_object_path=eq\.ai-notes%2F/); }
        return response([state]);
      }
      assert.match(url, /audio_object_path=eq\.ai-notes%2F/); state = cleared; return response([state]);
    }
    if (url.includes("/storage/") && method === "POST") { objectPresent = true; return response({ Key: "private" }); }
    if (url.includes("/storage/") && method === "DELETE") {
      storageDeletes++;
      if (!objectPresent) return response({}, 404, JSON.stringify({ message: "Object not found" }));
      objectPresent = false; return response({}, 204);
    }
    throw new Error(`${method} ${url}`);
  });
  try {
    const postOut = res(); await built().postAudio(req({ params: { sessionId: SESSION }, headers: {
      "idempotency-key": REQUEST, "content-type": "audio/mp4" }, body: m4a() }), postOut);
    assert.deepEqual([postOut.statusCode, postOut.body], [201, { audio: { request_id: REQUEST } }]);
    const deleteOut = res(); await built().deleteAudio(req({ params: { sessionId: SESSION, requestId: REQUEST } }), deleteOut);
    assert.deepEqual([deleteOut.statusCode, deleteOut.body], [200, { deleted: true }]);
    assert.equal(verifyCas, 1); assert.equal(storageDeletes, 2);
    assert.equal(objectPresent, false); assert.equal(state.audio_object_path, null);
  } finally { mock.restore(); }
});

test("use_audio:false terminal CAS cannot commit over a concurrent marker reservation", async () => {
  const pending = note({ status: "generating", generation_started_at: "2026-07-16T12:05:00.000Z",
    notes_body: null, suggested_next: null, homework: [], model: null, transcript: null });
  let state = pending, noteReads = 0, blockedCas = 0, deletes = 0; const order = [];
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("/sessions?")) return response([session()]);
    if (url.includes("/ai_session_notes?") && method === "GET") {
      noteReads++;
      if (noteReads === 1) return response([]);
      if (noteReads === 3) {
        state = { ...pending, audio_object_path: objectPath() };
        return response([pending]);
      }
      return response([state]);
    }
    if (/\/(?:session_notes|clip_markers|drill_blocks|homework)\?/.test(url)) return response([]);
    if (url.includes("/storage/") && method === "DELETE") { deletes++; order.push("delete"); return response({}, 204); }
    if (url.endsWith("/ai_session_notes") && method === "POST") return response([pending]);
    if (url.includes("/ai_session_notes?") && method === "PATCH") {
      if (body.status === "ready" && url.includes("audio_object_path=is.null")) {
        blockedCas++; order.push("blocked-null-cas"); return response([]);
      }
      assert.equal(body.status, "ready"); assert.match(url, /audio_object_path=eq\.ai-notes%2F/);
      assert.equal(body.audio_object_path, null); order.push("terminal-null");
      state = note({ audio_object_path: null, audio_deleted_at: body.audio_deleted_at });
      return response([state]);
    }
    throw new Error(`${method} ${url}`);
  });
  try {
    const generated = res(); await built().postGenerate(req({ params: { sessionId: SESSION }, body: {
      request_id: REQUEST, use_audio: false, typed_recap: "typed" } }), generated);
    assert.equal(generated.statusCode, 200); assert.equal(state.status, "ready");
    assert.equal(blockedCas, 1); assert.equal(deletes, 1); assert.equal(state.audio_object_path, null);
    assert.deepEqual(order, ["blocked-null-cas", "delete", "terminal-null"]);
  } finally { mock.restore(); }
});

test("failed upload rolls back the reserved marker best-effort and returns 502", async () => {
  const reserved = note({ status: "generating", generation_started_at: "1970-01-01T00:00:00.000Z",
    notes_body: null, suggested_next: null, homework: [], model: null, transcript: null,
    audio_object_path: objectPath() });
  const cleared = { ...reserved, audio_object_path: null };
  let state = reserved, deletes = 0;
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("/sessions?")) return response([session()]);
    if (url.includes("/ai_session_notes?") && method === "GET") return response([state]);
    if (url.includes("/storage/") && method === "POST") return response({}, 503);
    if (url.includes("/storage/") && method === "DELETE") { deletes++; return response({}, 204); }
    if (url.includes("/ai_session_notes?") && method === "PATCH") {
      assert.deepEqual(body, { audio_object_path: null, audio_deleted_at: null }); state = cleared; return response([state]);
    }
    throw new Error(`${method} ${url}`);
  });
  try {
    const out = res(); await built().postAudio(req({ params: { sessionId: SESSION }, headers: {
      "idempotency-key": REQUEST, "content-type": "audio/mp4" }, body: m4a() }), out);
    assert.deepEqual([out.statusCode, out.body], [502, { error: "storage_failed" }]);
    assert.equal(deletes, 1); assert.equal(state.audio_object_path, null);
  } finally { mock.restore(); }
});

test("winning typed generation reads bounded tenant sources, claims and terminal-patches atomically", async () => {
  let generated = 0; const notifications = [];
  const generating = note({ status: "generating", notes_body: null, suggested_next: null, homework: [], model: null, transcript: null, updated_at: CREATED });
  const ready = note(); let state = null;
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("/sessions?")) return response([session()]);
    if (url.includes("/ai_session_notes?") && method === "GET") return response(state ? [state] : []);
    if (url.endsWith("/rest/v1/ai_session_notes") && method === "POST") { state = generating; return response([state]); }
    if (/\/rest\/v1\/(?:session_notes|clip_markers|drill_blocks|homework)\?/.test(url)) {
      assert.match(url, new RegExp(`coach_id=eq\\.${COACH}&session_id=eq\\.${SESSION}`));
      assert.doesNotMatch(url, /complete_token|parent_email|audio|transcript/); return response([]);
    }
    if (url.includes("/ai_session_notes?") && method === "PATCH") { assert.match(url, /status=eq\.generating/); assert.match(url, new RegExp(`generation_key=eq\\.${REQUEST}`));
      assert.equal(body.transcript, null); assert.equal(body.audio_object_path, null); state = ready; return response([state]); }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try { const out = res(); await built({ notify: async (x) => notifications.push(x), generateSessionNote: async (input) => { generated++; assert.equal(input.typed_recap, "typed context"); return { transcript: null,
      notes_body: "Strong base", suggested_next: "Work on balance", homework: [], model: "fake-model", stt_model: null, warning: null }; } }).postGenerate(
      req({ params: { sessionId: SESSION }, body: { request_id: REQUEST, use_audio: false, typed_recap: " typed context " } }), out);
    assert.equal(out.statusCode, 200); assert.equal(generated, 1); assert.equal(notifications.length, 1); }
  finally { mock.restore(); }
});

test("insert 23505 race loser re-reads the same generating request and never charges provider", async () => {
  let noteReads = 0, generated = 0;
  const generating = note({ status: "generating", notes_body: null, suggested_next: null, homework: [], model: null, transcript: null });
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("/sessions?")) return response([session()]);
    if (url.includes("/ai_session_notes?") && method === "GET") return response(++noteReads === 1 ? [] : [generating]);
    if (url.endsWith("/ai_session_notes") && method === "POST") return response({}, 409, JSON.stringify({ code: "23505" }));
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await built({ generateSessionNote: async () => { generated++; } }).postGenerate(
      req({ params: { sessionId: SESSION }, body: { request_id: REQUEST, use_audio: false, typed_recap: "source" } }), out);
    assert.equal(out.statusCode, 202); assert.equal(generated, 0); assert.equal(noteReads, 2);
  } finally { mock.restore(); }
});

test("audio generation revalidates and deletes private bytes before provider, then stamps deletion", async () => {
  const bytes = m4a("voice"), order = []; let providerBytes;
  const generating = note({ status: "generating", notes_body: null, suggested_next: null, homework: [], model: null, transcript: null });
  const ready = note({ transcript: "spoken words", stt_model: "fake-stt", audio_deleted_at: "2026-07-16T12:05:00.000Z" }); let state = null;
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("/sessions?")) return response([session()]);
    if (url.includes("/ai_session_notes?") && method === "GET") return response(state ? [state] : []);
    if (url.endsWith("/ai_session_notes") && method === "POST") { state = generating; return response([state]); }
    if (/\/rest\/v1\/(?:session_notes|clip_markers|drill_blocks|homework)\?/.test(url)) return response([]);
    if (url.includes("/storage/") && method === "GET") { order.push("download"); return response(bytes); }
    if (url.includes("/storage/") && method === "DELETE") { order.push("delete"); return response({}, 204); }
    if (url.includes("/ai_session_notes?") && method === "PATCH") {
      order.push("patch"); assert.equal(body.audio_deleted_at, "2026-07-16T12:05:00.000Z"); assert.equal(body.transcript, "spoken words");
      assert.equal(body.audio_object_path, null); state = ready; return response([state]);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await built({ generateSessionNote: async (input) => { order.push("provider"); providerBytes = input.audio.bytes; assert.deepEqual(providerBytes, bytes); return {
      transcript: "spoken words", notes_body: "Strong base", suggested_next: "Work on balance", homework: [],
      model: "fake-model", stt_model: "fake-stt", warning: null,
    }; } }).postGenerate(req({ params: { sessionId: SESSION }, body: { request_id: REQUEST, use_audio: true } }), out);
    assert.equal(out.statusCode, 200); assert.deepEqual(order, ["download", "delete", "provider", "patch"]);
    assert.equal(providerBytes.every((value) => value === 0), true, "audio buffer is cleared after generation");
  } finally { mock.restore(); }
});

test("production transport path pins provider env/models, degrades STT, and bounds transcript before LLM", async () => {
  const prior = { groq: process.env.GROQ_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY,
    stt: process.env.AI_NOTES_STT_MODEL, llm: process.env.AI_NOTES_LLM_MODEL };
  process.env.GROQ_API_KEY = "groq-test-key"; process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
  process.env.AI_NOTES_STT_MODEL = "pinned-stt-test"; process.env.AI_NOTES_LLM_MODEL = "pinned-llm-test";
  try {
    for (const oversize of [false, true]) {
      const generating = note({ status: "generating", notes_body: null, suggested_next: null, homework: [], model: null, transcript: null });
      const ready = note({ model: "pinned-llm-test", warning_code: oversize ? null : "audio_not_used", transcript: null });
      const failed = note({ status: "failed", notes_body: null, suggested_next: null, homework: [], model: null,
        transcript: null, error_code: "generation_failed", audio_deleted_at: "2026-07-16T12:05:00.000Z" });
      let llmCalls = 0, deleteCalls = 0, state = null;
      const mock = mockFetch(({ url, method, headers, rawBody, body }) => {
        if (url.includes("/rest/v1/sessions?")) return response([session()]);
        if (url.includes("/ai_session_notes?") && method === "GET") return response(state ? [state] : []);
        if (url.endsWith("/rest/v1/ai_session_notes") && method === "POST") { state = generating; return response([state]); }
        if (/\/rest\/v1\/(?:session_notes|clip_markers|drill_blocks|homework)\?/.test(url)) return response([]);
        if (url.includes("/storage/") && method === "GET") return response(m4a("production-shape"));
        if (url.includes("/storage/") && method === "DELETE") { deleteCalls++; return response({}, 204); }
        if (url.includes("api.groq.com")) {
          assert.equal(headers.authorization, "Bearer groq-test-key"); assert.equal(rawBody.get("model"), "pinned-stt-test");
          const boundaryTranscript = "é".repeat(65_536);
          assert.equal(Buffer.byteLength(boundaryTranscript, "utf8"), 128 * 1024);
          return oversize ? response({ text: boundaryTranscript }) : response({}, 503);
        }
        if (url.includes("api.anthropic.com")) {
          llmCalls++; assert.equal(headers["x-api-key"], "anthropic-test-key"); assert.equal(body.model, "pinned-llm-test");
          assert.equal(headers["anthropic-version"], "2023-06-01");
          return response({ content: [{ text: JSON.stringify({ notes_body: "Typed source survived STT",
            suggested_next: "Keep working", homework: [] }) }] });
        }
        if (url.includes("/ai_session_notes?") && method === "PATCH") {
          if (oversize) { assert.equal(body.error_code, "generation_failed"); state = failed; return response([state]); }
          assert.equal(body.warning_code, "audio_not_used"); assert.equal(body.model, "pinned-llm-test"); state = ready; return response([state]);
        }
        throw new Error(`${method} ${url}`);
      });
      try {
        const handlers = buildAiNotesHandlers({ requireSupabaseUser: coachAuth(), notify: async () => {},
          sendEmail: async () => {}, now: () => new Date("2026-07-16T12:05:00.000Z") });
        const out = res(); await handlers.postGenerate(req({ params: { sessionId: SESSION }, body: {
          request_id: REQUEST, use_audio: true, typed_recap: "typed fallback" } }), out);
        assert.equal(deleteCalls, 1, "persistent audio is deleted before either provider outcome");
        assert.equal(llmCalls, oversize ? 0 : 1, "oversize STT text is rejected before an LLM bill");
        assert.deepEqual([out.statusCode, oversize ? out.body : out.body.note.warning],
          oversize ? [413, { error: "source_too_large" }] : [200, "audio_not_used"]);
      } finally { mock.restore(); }
    }
  } finally {
    for (const [key, value] of [["GROQ_API_KEY", prior.groq], ["ANTHROPIC_API_KEY", prior.anthropic],
      ["AI_NOTES_STT_MODEL", prior.stt], ["AI_NOTES_LLM_MODEL", prior.llm]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("pre-STT oversize delete failure is retryable 502, then successful cleanup permits terminal 413", async () => {
  const retryable = note({ status: "generating", generation_started_at: "1970-01-01T00:00:00.000Z",
    notes_body: null, suggested_next: null, homework: [], model: null, transcript: null, audio_object_path: objectPath() });
  const generating = note({ ...retryable, generation_started_at: "2026-07-16T12:05:00.000Z" });
  const failed = note({ status: "failed", transcript: null, notes_body: null, suggested_next: null, homework: [],
    model: null, error_code: "generation_failed", audio_deleted_at: "2026-07-16T12:05:00.000Z" });
  const tooMany = Array.from({ length: 201 }, (_, i) => ({ timestamp_seconds: i, body: "x", tag: null }));
  let deleteCalls = 0, state = retryable;
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("/sessions?")) return response([session()]);
    if (url.includes("/ai_session_notes?") && method === "GET") return response([state]);
    if (url.includes("/session_notes?")) return response(tooMany);
    if (url.includes("/storage/") && method === "DELETE") {
      deleteCalls++; return response({}, deleteCalls === 1 ? 503 : 204);
    }
    if (url.includes("/ai_session_notes?") && method === "PATCH") {
      if (body.generation_started_at === "2026-07-16T12:05:00.000Z") state = generating;
      else if (body.generation_started_at === "1970-01-01T00:00:00.000Z") state = retryable;
      else if (body.status === "failed") state = failed;
      else throw new Error(`unexpected patch ${JSON.stringify(body)}`);
      return response([state]);
    }
    throw new Error(`${method} ${url}`);
  });
  try {
    const first = res(); await built().postGenerate(req({ params: { sessionId: SESSION }, body: {
      request_id: REQUEST, use_audio: true } }), first);
    assert.deepEqual([first.statusCode, first.body], [502, { error: "storage_failed" }]);
    assert.equal(state.status, "generating"); assert.equal(state.audio_object_path, objectPath());

    const second = res(); await built().postGenerate(req({ params: { sessionId: SESSION }, body: {
      request_id: REQUEST, use_audio: true } }), second);
    assert.deepEqual([second.statusCode, second.body], [413, { error: "source_too_large" }]);
    assert.equal(deleteCalls, 2); assert.equal(state.status, "failed"); assert.equal(state.audio_object_path, null);
  } finally { mock.restore(); }
});

test("terminal retry re-deletes an independently marked-present object", async () => {
  const terminal = note({ audio_object_path: objectPath(), audio_deleted_at: null });
  const cleared = note({ audio_object_path: null, audio_deleted_at: "2026-07-16T12:05:00.000Z" });
  let deletes = 0, reads = 0;
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("/sessions?")) return response([session()]);
    if (url.includes("/ai_session_notes?") && method === "GET") return response([++reads < 3 ? terminal : cleared]);
    if (url.includes("/storage/") && method === "DELETE") { deletes++; return response({}, 204); }
    if (url.includes("/ai_session_notes?") && method === "PATCH") {
      assert.deepEqual(body, { audio_object_path: null, audio_deleted_at: "2026-07-16T12:05:00.000Z" });
      return response([cleared]);
    }
    throw new Error(`${method} ${url}`);
  });
  try {
    const out = res(); await built().postGenerate(req({ params: { sessionId: SESSION }, body: {
      request_id: REQUEST, use_audio: false } }), out);
    assert.equal(out.statusCode, 200); assert.equal(deletes, 1); assert.equal(out.body.note.status, "ready");
  } finally { mock.restore(); }
});

test("invalid generator output becomes sanitized durable generation_failed", async () => {
  const generating = note({ status: "generating", notes_body: null, suggested_next: null, homework: [], model: null, transcript: null });
  const failed = note({ status: "failed", notes_body: null, suggested_next: null, homework: [], model: null, transcript: null, error_code: "generation_failed" }); let state = null;
  const mock = mockFetch(({ url, method, body }) => { if (url.includes("/sessions?")) return response([session()]);
    if (url.includes("/ai_session_notes?") && method === "GET") return response(state ? [state] : []);
    if (url.endsWith("/ai_session_notes") && method === "POST") { state = generating; return response([state]); }
    if (/\/rest\/v1\/(?:session_notes|clip_markers|drill_blocks|homework)\?/.test(url)) return response([]);
    if (method === "PATCH") { assert.equal(body.error_code, "generation_failed"); assert.equal(body.notes_body, null); state = failed; return response([state]); }
    throw new Error(url); });
  try { const out = res(); await built({ generateSessionNote: async () => ({ transcript: "provider secret", notes_body: "", error: "raw" }) }).postGenerate(
      req({ params: { sessionId: SESSION }, body: { request_id: REQUEST, use_audio: false, typed_recap: "source" } }), out);
    assert.equal(out.statusCode, 200); assert.equal(out.body.note.failure, "generation_failed"); assert.doesNotMatch(JSON.stringify(out.body), /provider secret|raw/); }
  finally { mock.restore(); }
});

test("delete distinguishes PostgREST 500 from storage 502 and validates exact-path 404", async () => {
  const db = mockFetch(() => response({}, 500));
  try { const out = res(); await built().deleteAudio(req({ params: { sessionId: SESSION, requestId: REQUEST } }), out);
    assert.deepEqual([out.statusCode, out.body], [500, { error: "internal_error" }]); }
  finally { db.restore(); }
  const wrong = mockFetch(({ url }) => url.includes("/sessions?") ? response([session()]) :
    url.includes("/ai_session_notes?") ? response([]) :
      response({}, 404, JSON.stringify({ message: "Object not found", path: "ai-notes/other/object.m4a" })));
  try { const out = res(); await built().deleteAudio(req({ params: { sessionId: SESSION, requestId: REQUEST } }), out);
    assert.deepEqual([out.statusCode, out.body], [502, { error: "storage_failed" }]); }
  finally { wrong.restore(); }
});

test("GET is tenant-filtered, read-only, and rejects malformed 2xx JSON", async () => {
  for (const malformed of [false, true]) {
    const mock = mockFetch(({ url }) => { if (url.includes("/sessions?")) return response([session()]);
      assert.match(url, new RegExp(`ai_session_notes\\?coach_id=eq\\.${COACH}&session_id=eq\\.${SESSION}`)); return malformed ? response(new Error("bad json")) : response([note()]); });
    try { const out = res(); await built().getNote(req({ params: { sessionId: SESSION } }), out); assert.equal(out.statusCode, malformed ? 500 : 200); assert.equal(mock.calls.every((c) => c.method === "GET"), true); }
    finally { mock.restore(); }
  }
});

test("share calls the exact transaction, formats recap, sends whitelisted delivery fail-soft", async () => {
  const notifications = [], emails = [], shared = note({ share_key: SHARE, shared_at: "2026-07-16T12:05:00.000Z" });
  const homework = [{ title: "Footwork", detail: "Ten reps", due_date: "2026-07-20" }];
  const mock = mockFetch(({ url, method, body }) => { if (url.includes("/sessions?")) return response([session()]);
    if (url.includes("/ai_session_notes?")) return response([note()]);
    assert.equal(method, "POST"); assert.match(url, /rpc\/publish_ai_session_note$/);
    assert.deepEqual(Object.keys(body), ["p_note_id", "p_coach_id", "p_session_id", "p_expected_updated_at", "p_share_key", "p_notes_body", "p_suggested_next", "p_homework", "p_recap_body", "p_shared_at"]);
    assert.equal(body.p_coach_id, COACH); assert.equal(body.p_session_id, SESSION);
    assert.equal(body.p_expected_updated_at, "2026-07-16T12:01:00+00:00");
    assert.equal(body.p_recap_body, "Reviewed <recap>\n\nNEXT SESSION\nNext & better\n\nHOMEWORK\n- Footwork — Ten reps (Due 2026-07-20)"); return response([shared]); });
  try { const out = res(); await built({ notify: async (x) => { notifications.push(x); throw new Error("push down"); }, sendEmail: async (x) => { emails.push(x); throw new Error("mail down"); } }).postShare(
      req({ params: { sessionId: SESSION }, body: { share_id: SHARE, note_id: NOTE, expected_updated_at: "2026-07-16T12:01:00+00:00",
        notes_body: "Reviewed <recap>", suggested_next: "Next & better", homework } }), out);
    assert.equal(out.statusCode, 200); assert.equal(out.body.delivery, "in_app_and_email");
    assert.deepEqual(notifications[0], { userId: USER, type: "ai_notes.shared", title: "Session recap ready", body: "Your coach shared a session recap.",
      data: { sessionId: SESSION, href: "/athlete" }, dedupeKey: `ai_notes.shared:${NOTE}:${SHARE}` });
    assert.match(emails[0].html, /Reviewed &lt;recap&gt;/); assert.doesNotMatch(emails[0].html, /SECRET|transcript|generation_key/);
  } finally { mock.restore(); }
});

test("share refuses a marked ready row without calling the publish RPC", async () => {
  let rpcCalls = 0;
  const marked = note({ audio_object_path: objectPath() });
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("/sessions?")) return response([session()]);
    if (url.includes("/ai_session_notes?") && method === "GET") return response([marked]);
    if (url.includes("/rpc/publish_ai_session_note")) { rpcCalls++; throw new Error("publish must not run"); }
    throw new Error(`${method} ${url}`);
  });
  try {
    const out = res(); await built().postShare(req({ params: { sessionId: SESSION }, body: {
      share_id: SHARE, note_id: NOTE, expected_updated_at: UPDATED,
      notes_body: "Reviewed", suggested_next: "Next", homework: [],
    } }), out);
    assert.deepEqual([out.statusCode, out.body], [409, { error: "note_not_ready" }]);
    assert.equal(rpcCalls, 0);
  } finally { mock.restore(); }
});

test("same-share retry re-emits notify but not email; different key conflicts", async () => {
  for (const key of [SHARE, "different_key_0001"]) {
    const notifications = [], emails = [], shared = note({ share_key: SHARE, shared_at: CREATED });
    const mock = mockFetch(({ url }) => url.includes("/sessions?") ? response([session()]) : response([shared]));
    try { const out = res(); await built({ notify: async (x) => notifications.push(x), sendEmail: async (x) => emails.push(x) }).postShare(
        req({ params: { sessionId: SESSION }, body: { share_id: key, note_id: NOTE, expected_updated_at: UPDATED, notes_body: "Strong base", suggested_next: "Work on balance", homework: [] } }), out);
      assert.equal(out.statusCode, key === SHARE ? 200 : 409); assert.equal(notifications.length, key === SHARE ? 1 : 0); assert.equal(emails.length, 0); }
    finally { mock.restore(); }
  }
});

test("delivery enum covers in-app, email, both and manual", async () => {
  const combinations = [[USER, null, "in_app"], [null, "p@example.test", "email"], [USER, "p@example.test", "in_app_and_email"], [null, null, "manual"]];
  for (const [user_id, parent_email, expected] of combinations) {
    const mock = mockFetch(({ url }) => url.includes("/sessions?") ? response([session({ athletes: { id: ATHLETE, name: "Avery", user_id, parent_email } })]) : response([note({ share_key: SHARE, shared_at: CREATED })]));
    try { const out = res(); await built().postShare(req({ params: { sessionId: SESSION }, body: { share_id: SHARE, note_id: NOTE, expected_updated_at: UPDATED, notes_body: "Strong base", suggested_next: "Work on balance", homework: [] } }), out); assert.equal(out.body.delivery, expected); }
    finally { mock.restore(); }
  }
});
