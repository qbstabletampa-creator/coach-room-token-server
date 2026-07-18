const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "service-key";
process.env.GROQ_API_KEY = "groq-test-key";
process.env.AI_NOTES_LLM_PROVIDER = "groq";

const { buildAiNotesHandlers } = require("../lib/ai-notes");

const COACH = "11111111-1111-4111-8111-111111111111";
const ATHLETE = "22222222-2222-4222-8222-222222222222";
const SESSION = "44444444-4444-4444-8444-444444444444";
const NOTE = "55555555-5555-4555-8555-555555555555";
const REQUEST = "request_key_000001";
const CREATED = "2026-07-16T12:00:00.000Z";

function response(body = {}, status = 200, headers = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalized.get(String(name).toLowerCase()) || null },
    json: async () => body,
    text: async () => bytes.toString(),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function note(overrides = {}) {
  return {
    id: NOTE, coach_id: COACH, session_id: SESSION, athlete_id: ATHLETE,
    status: "generating", generation_key: REQUEST, generation_started_at: CREATED,
    transcript: null, notes_body: null, suggested_next: null, homework: [], model: null,
    stt_model: null, warning_code: null, error_code: null, audio_object_path: null,
    audio_deleted_at: null, share_key: null, shared_at: null, created_at: CREATED,
    updated_at: CREATED, ...overrides,
  };
}

function m4a() {
  const bytes = Buffer.alloc(16);
  bytes.write("ftyp", 4);
  return bytes;
}

function providerSuccess(notes = "Retry succeeded") {
  return response({ choices: [{ message: { content: JSON.stringify({
    notes_body: notes, suggested_next: "Continue", homework: [],
  }) } }] });
}

async function generate({ replies, useAudio = false }) {
  let state = null;
  const sleeps = [];
  const providerCalls = [];
  const oldFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || "GET").toUpperCase();
    if (target.includes("/rest/v1/sessions?")) return response([{
      id: SESSION, coach_id: COACH, athlete_id: ATHLETE, title: "Film review",
      session_date: "2026-07-16", athletes: { id: ATHLETE, name: "Avery" },
    }]);
    if (target.includes("/rest/v1/ai_session_notes?") && method === "GET") return response(state ? [state] : []);
    if (target.endsWith("/rest/v1/ai_session_notes") && method === "POST") {
      state = note();
      return response([state]);
    }
    if (/\/rest\/v1\/(?:session_notes|clip_markers|drill_blocks|homework)\?/.test(target)) return response([]);
    if (target.includes("/storage/v1/object/") && method === "GET") return response(m4a());
    if (target.includes("/storage/v1/object/") && method === "DELETE") return response({}, 204);
    if (target.includes("/rest/v1/ai_session_notes?") && method === "PATCH") {
      const fields = JSON.parse(options.body);
      state = note({ ...fields, updated_at: "2026-07-16T12:05:00.000Z" });
      return response([state]);
    }
    throw new Error(`unexpected ${method} ${target}`);
  };

  const providerFetch = async (url, options) => {
    providerCalls.push({ url: String(url), options });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (!reply) throw new Error(`missing provider reply for ${url}`);
    return reply;
  };
  const handlers = buildAiNotesHandlers({
    requireSupabaseUser: async () => ({ user: { id: COACH, app_metadata: { role: "coach" } } }),
    notify: async () => {}, sendEmail: async () => {},
    now: () => new Date("2026-07-16T12:05:00.000Z"),
    fetch: providerFetch, sleep: async (ms) => sleeps.push(ms),
  });
  const out = { statusCode: 200, body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; } };
  try {
    await handlers.postGenerate({ params: { sessionId: SESSION }, query: {}, headers: {}, body: {
      request_id: REQUEST, use_audio: useAudio, typed_recap: useAudio ? undefined : "typed source",
    } }, out);
    return { out, sleeps, providerCalls };
  } finally {
    global.fetch = oldFetch;
  }
}

test("429 then 200 retries once and succeeds", async () => {
  const run = await generate({ replies: [response({}, 429), providerSuccess()] });
  assert.equal(run.out.statusCode, 200);
  assert.equal(run.out.body.note.notes_body, "Retry succeeded");
  assert.equal(run.providerCalls.length, 2);
  assert.deepEqual(run.sleeps, [1000]);
});

test("persistent 429 stops after three attempts with the existing failure shape", async () => {
  const run = await generate({ replies: [response({}, 429), response({}, 429), response({}, 429)] });
  assert.equal(run.out.statusCode, 200);
  assert.equal(run.out.body.note.status, "failed");
  assert.equal(run.out.body.note.failure, "generation_failed");
  assert.equal(run.providerCalls.length, 3);
  assert.deepEqual(run.sleeps, [1000, 2000]);
});

test("400 fails immediately without sleeping", async () => {
  const run = await generate({ replies: [response({}, 400)] });
  assert.equal(run.out.statusCode, 200);
  assert.equal(run.out.body.note.failure, "generation_failed");
  assert.equal(run.providerCalls.length, 1);
  assert.deepEqual(run.sleeps, []);
});

test("retry-after seconds are honored and capped at 20 seconds", async () => {
  for (const [header, expected] of [["3", 3000], ["30", 20000]]) {
    const run = await generate({ replies: [response({}, 429, { "retry-after": header }), providerSuccess()] });
    assert.equal(run.out.body.note.status, "ready");
    assert.deepEqual(run.sleeps, [expected]);
  }
});

test("transcription uses the shared retry path", async () => {
  const run = await generate({ useAudio: true, replies: [
    response({}, 503), response({ text: "spoken source" }), providerSuccess("Audio retry succeeded"),
  ] });
  const transcriptionCalls = run.providerCalls.filter((call) => call.url.includes("/audio/transcriptions"));
  assert.equal(transcriptionCalls.length, 2);
  assert.deepEqual(run.sleeps, [1000]);
  assert.equal(run.out.body.note.transcript, undefined);
  assert.equal(run.out.body.note.notes_body, "Audio retry succeeded");
});
