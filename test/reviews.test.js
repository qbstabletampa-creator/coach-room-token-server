const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "service-key";
process.env.CLIPS_BUCKET = "clips-private";

const { buildVideoReviewHandlers } = require("../lib/video-review");

const COACH = "11111111-1111-4111-8111-111111111111";
const ATHLETE = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const REVIEW = "44444444-4444-4444-8444-444444444444";
const VIDEO = "55555555-5555-4555-8555-555555555555";
const SESSION = "66666666-6666-4666-8666-666666666666";
const ANNOTATION = "77777777-7777-4777-8777-777777777777";
const CREATED = "2026-07-16T12:00:00.000Z";
const SHARED = "2026-07-16T13:00:00.000Z";

function response(body = [], status = 200, detail = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => detail || JSON.stringify(body),
  };
}

function mockFetch(handler) {
  const old = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const call = {
      url: String(url),
      method: String(opts.method || "GET").toUpperCase(),
      headers: opts.headers || {},
      rawBody: opts.body,
      body: typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body,
    };
    calls.push(call);
    return handler(call, calls);
  };
  return { calls, restore: () => { global.fetch = old; } };
}

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function req({ body = {}, params = {}, query = {}, headers = {} } = {}) {
  return { body, params, query, headers };
}

function coachAuth(metadata = { role: "coach" }) {
  return async () => ({ user: { id: COACH, app_metadata: metadata } });
}

function athleteAuth() {
  return async () => ({ user: { id: USER, app_metadata: {}, user_metadata: { role: "athlete" } } });
}

function athleteRow(overrides = {}) {
  return { id: ATHLETE, coach_id: COACH, user_id: USER, name: "Avery", ...overrides };
}

function videoRow(overrides = {}) {
  return {
    id: VIDEO, coach_id: COACH, athlete_id: ATHLETE, session_id: SESSION,
    url: `${ATHLETE}/rep.mp4`, title: "Front squat", duration_s: 30,
    source: "live-clip", kind: "rep", created_at: CREATED, ...overrides,
  };
}

function reviewRow(overrides = {}) {
  return {
    id: REVIEW, coach_id: COACH, athlete_id: ATHLETE, video_id: VIDEO,
    session_id: SESSION, ask: "Check my depth", status: "submitted",
    created_at: CREATED, answered_at: null,
    athletes: athleteRow(), videos: videoRow(), coaches: { full_name: "Coach C" },
    ...overrides,
  };
}

function annotationRow(overrides = {}) {
  return {
    id: ANNOTATION, coach_id: COACH, review_id: REVIEW, reel: [],
    audio_path: null, duration_s: 3, created_at: SHARED, shared_at: SHARED,
    ...overrides,
  };
}

function handlers(overrides = {}) {
  return buildVideoReviewHandlers({
    requireSupabaseUser: overrides.requireSupabaseUser || coachAuth(),
    notify: overrides.notify || (async () => {}),
    signClipUrl: overrides.signClipUrl || (async (path) => `https://signed.test/${path}`),
  });
}

test("factory exports exactly seven inert handlers", () => {
  let effects = 0;
  const built = buildVideoReviewHandlers({
    requireSupabaseUser: async () => { effects++; },
    notify: async () => { effects++; },
    signClipUrl: async () => { effects++; },
  });
  assert.deepEqual(Object.keys(built), [
    "postReview", "getReviews", "getReview", "postAudio", "postAnswer",
    "getAnnotation", "postDecline",
  ]);
  assert.equal(effects, 0);
});

test("submit derives authority, trims ask, copies session, emits exact DTO and notification", async () => {
  const notifications = [];
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("/athletes?")) return response([athleteRow()]);
    if (url.includes("/videos?")) return response([videoRow()]);
    if (url.endsWith("/video_reviews") && method === "POST") {
      assert.deepEqual(body, {
        coach_id: COACH, athlete_id: ATHLETE, video_id: VIDEO, session_id: SESSION,
        ask: "Check my depth", status: "submitted",
      });
      return response([reviewRow({ athletes: undefined, videos: undefined })]);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await handlers({
      requireSupabaseUser: athleteAuth(),
      notify: async (event) => notifications.push(event),
    }).postReview(req({ body: { video_id: VIDEO, ask: "  Check my depth  " } }), out);
    assert.equal(out.statusCode, 201);
    assert.deepEqual(out.body.review, {
      id: REVIEW,
      athlete: { id: ATHLETE, name: "Avery" },
      video: { id: VIDEO, title: "Front squat", duration_s: 30, created_at: CREATED },
      session_id: SESSION, ask: "Check my depth", status: "submitted",
      created_at: CREATED, answered_at: null,
    });
    assert.deepEqual(notifications, [{
      userId: COACH, type: "review.submitted", title: "New film review",
      body: "Avery sent Front squat for review.",
      data: { reviewId: REVIEW, athleteId: ATHLETE, videoId: VIDEO, href: `/reviews/${REVIEW}` },
      dedupeKey: `review.submitted:${REVIEW}`,
    }]);
    assert.match(mock.calls[1].url, new RegExp(`coach_id=eq\\.${COACH}`));
    assert.match(mock.calls[1].url, new RegExp(`athlete_id=eq\\.${ATHLETE}`));
  } finally { mock.restore(); }
});

test("submit rejects tenant overrides before insert and foreign or unsafe videos as 404", async () => {
  let mock = mockFetch(({ url }) => {
    if (url.includes("/athletes?")) return response([athleteRow()]);
    throw new Error(`unexpected ${url}`);
  });
  try {
    const out = res();
    await handlers({ requireSupabaseUser: athleteAuth() }).postReview(
      req({ body: { video_id: VIDEO, coach_id: "attacker" } }), out);
    assert.deepEqual([out.statusCode, out.body], [400, { error: "invalid_body" }]);
    assert.equal(mock.calls.filter((c) => c.method === "POST").length, 0);
  } finally { mock.restore(); }

  const forged = `https://evil.test/storage/v1/object/sign/clips-private/${ATHLETE}/rep.mp4?token=forged`;
  for (const unsafe of [null, videoRow({ url: "https://evil.test/clip.mp4" }),
    videoRow({ url: forged }),
    videoRow({ url: "99999999-9999-4999-8999-999999999999/clip.mp4" })]) {
    mock = mockFetch(({ url }) => {
      if (url.includes("/athletes?")) return response([athleteRow()]);
      if (url.includes("/videos?")) return response(unsafe ? [unsafe] : []);
      throw new Error(`unexpected ${url}`);
    });
    try {
      const out = res();
      await handlers({ requireSupabaseUser: athleteAuth() }).postReview(
        req({ body: { video_id: VIDEO } }), out);
      assert.deepEqual([out.statusCode, out.body], [404, { error: "not_found" }]);
    } finally { mock.restore(); }
  }
});

test("submit validates every request field before DB access and counts ask Unicode code points", async () => {
  let authCalls = 0;
  let mock = mockFetch(() => { throw new Error("no fetch expected"); });
  try {
    const out = res();
    await handlers({
      requireSupabaseUser: async () => { authCalls++; return athleteAuth()(); },
    }).postReview(req({ body: { video_id: "malformed", session_id: "also-malformed" } }), out);
    assert.deepEqual([out.statusCode, out.body], [400, { error: "invalid_body" }]);
    assert.equal(authCalls, 0);
    assert.equal(mock.calls.length, 0);
  } finally { mock.restore(); }

  const ask = "🥋".repeat(500);
  mock = mockFetch(({ url, method, body }) => {
    if (url.includes("/athletes?")) return response([athleteRow()]);
    if (url.includes("/videos?")) return response([videoRow()]);
    if (url.endsWith("/video_reviews") && method === "POST") {
      assert.equal(Array.from(body.ask).length, 500);
      return response([reviewRow({ ask, athletes: undefined, videos: undefined })]);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await handlers({ requireSupabaseUser: athleteAuth() }).postReview(
      req({ body: { video_id: VIDEO, ask } }), out);
    assert.equal(out.statusCode, 201);
  } finally { mock.restore(); }
});

test("coach role comes only from app_metadata; writable metadata cannot enter coach routes", async () => {
  const mock = mockFetch(({ url }) => {
    if (url.includes("/athletes?")) return response([]);
    throw new Error(`unexpected ${url}`);
  });
  try {
    const out = res();
    await handlers({
      requireSupabaseUser: async () => ({
        user: { id: USER, app_metadata: {}, user_metadata: { role: "coach" } },
      }),
    }).postDecline(req({ params: { id: REVIEW }, body: {} }), out);
    assert.deepEqual([out.statusCode, out.body], [403, { error: "forbidden" }]);
  } finally { mock.restore(); }
});

test("queue applies coach pending/oldest and athlete pair/newest filters without media leaks", async () => {
  let mock = mockFetch(({ url }) => {
    assert.match(url, /status=in\.\(submitted,in_review\)/);
    assert.match(url, /order=created_at\.asc/);
    return response([reviewRow()]);
  });
  try {
    const out = res();
    await handlers().getReviews(req(), out);
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.reviews[0].source_url, undefined);
    assert.equal(JSON.stringify(out.body).includes("coach_id"), false);
    assert.equal(JSON.stringify(out.body).includes("rep.mp4"), false);
  } finally { mock.restore(); }

  mock = mockFetch(({ url }) => {
    if (url.includes("/athletes?")) return response([athleteRow()]);
    assert.match(url, new RegExp(`coach_id=eq\\.${COACH}`));
    assert.match(url, new RegExp(`athlete_id=eq\\.${ATHLETE}`));
    assert.match(url, /order=created_at\.desc/);
    return response([]);
  });
  try {
    const out = res();
    await handlers({ requireSupabaseUser: athleteAuth() }).getReviews(req(), out);
    assert.deepEqual(out.body, { reviews: [] });
  } finally { mock.restore(); }
});

test("queue rejects repeated, CSV, and unknown statuses before review reads", async () => {
  for (const status of [["submitted", "answered"], "submitted,answered", "paid"]) {
    const mock = mockFetch(() => { throw new Error("no fetch expected"); });
    try {
      const out = res();
      await handlers().getReviews(req({ query: { status } }), out);
      assert.deepEqual([out.statusCode, out.body], [400, { error: "invalid_status" }]);
    } finally { mock.restore(); }
  }
});

test("invalid athlete status is 400 before a failing athlete identity lookup", async () => {
  const mock = mockFetch(() => { throw new Error("athlete lookup must not run"); });
  try {
    const out = res();
    await handlers({ requireSupabaseUser: athleteAuth() }).getReviews(
      req({ query: { status: "bogus" } }), out);
    assert.deepEqual([out.statusCode, out.body], [400, { error: "invalid_status" }]);
    assert.equal(mock.calls.length, 0);
  } finally { mock.restore(); }
});

test("detail double-scopes athlete ownership and signs athlete/session rooms only", async () => {
  const signed = [];
  const mock = mockFetch(({ url }) => {
    if (url.includes("/athletes?")) return response([athleteRow()]);
    assert.match(url, new RegExp(`coach_id=eq\\.${COACH}`));
    assert.match(url, new RegExp(`athlete_id=eq\\.${ATHLETE}`));
    return response([reviewRow({ videos: videoRow({ url: `${SESSION}/old.mp4` }) })]);
  });
  try {
    const out = res();
    await handlers({
      requireSupabaseUser: athleteAuth(),
      signClipUrl: async (path) => { signed.push(path); return "https://signed.test/source"; },
    }).getReview(req({ params: { id: REVIEW } }), out);
    assert.deepEqual(signed, [`${SESSION}/old.mp4`]);
    assert.equal(out.body.source_url, "https://signed.test/source");
  } finally { mock.restore(); }
});

test("foreign detail is 404 and declined detail never signs", async () => {
  for (const row of [null, reviewRow({ status: "declined" })]) {
    let signs = 0;
    const mock = mockFetch(() => response(row ? [row] : []));
    try {
      const out = res();
      await handlers({ signClipUrl: async () => { signs++; } }).getReview(
        req({ params: { id: REVIEW } }), out);
      if (!row) assert.deepEqual([out.statusCode, out.body], [404, { error: "not_found" }]);
      else assert.equal(out.body.source_url, null);
      assert.equal(signs, 0);
    } finally { mock.restore(); }
  }
});

test("forged external-origin storage URLs are never signed by detail or annotation", async () => {
  const forged = `https://evil.test/storage/v1/object/sign/clips-private/${ATHLETE}/rep.mp4?token=forged`;
  for (const endpoint of ["getReview", "getAnnotation"]) {
    let signs = 0;
    const mock = mockFetch(({ url }) => {
      if (url.includes("video_reviews")) {
        return response([reviewRow({
          status: endpoint === "getAnnotation" ? "answered" : "submitted",
          videos: videoRow({ url: forged }),
        })]);
      }
      if (url.includes("review_annotations")) return response([annotationRow()]);
      throw new Error(`unexpected ${url}`);
    });
    try {
      const out = res();
      await handlers({ signClipUrl: async () => { signs++; return "signed"; } })[endpoint](
        req({ params: { id: REVIEW } }), out);
      assert.deepEqual([out.statusCode, out.body], [404, { error: "not_found" }]);
      assert.equal(signs, 0);
    } finally { mock.restore(); }
  }
});

test("audio validates ftyp bytes and uploads privately without upsert", async () => {
  const bytes = Buffer.from("0000ftypisom", "ascii");
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("/video_reviews?")) return response([reviewRow()]);
    if (url.includes("/storage/v1/object/") && method === "POST") return response({});
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await handlers().postAudio(req({
      params: { id: REVIEW }, body: bytes, headers: { "content-type": "audio/mp4" },
    }), out);
    assert.equal(out.statusCode, 201);
    assert.match(out.body.audio_path,
      new RegExp(`^reviews/${COACH}/${REVIEW}/[0-9a-f-]{36}\\.m4a$`));
    const upload = mock.calls.find((c) => c.url.includes("/storage/v1/object/"));
    assert.equal(upload.headers["x-upsert"], "false");
    assert.equal(upload.headers["content-type"], "audio/mp4");
    assert.equal(out.body.url, undefined);
  } finally { mock.restore(); }
});

test("audio rejects empty/wrong magic and terminal states before storage", async () => {
  const cases = [
    { row: reviewRow(), body: Buffer.alloc(0), code: "invalid_audio" },
    { row: reviewRow(), body: Buffer.from("not-an-mp4"), code: "invalid_audio" },
    { row: reviewRow({ status: "declined" }), body: Buffer.from("0000ftyp"), code: "review_declined" },
    { row: reviewRow({ status: "answered" }), body: Buffer.from("0000ftyp"), code: "already_answered" },
  ];
  for (const item of cases) {
    const mock = mockFetch(({ url }) => url.includes("video_reviews") ? response([item.row]) : response({}));
    try {
      const out = res();
      await handlers().postAudio(req({ params: { id: REVIEW }, body: item.body,
        headers: { "content-type": "audio/mp4" } }), out);
      assert.equal(out.body.error, item.code);
      assert.equal(mock.calls.some((c) => c.url.includes("/storage/")), false);
    } finally { mock.restore(); }
  }
});

test("foreign audio, answer, and annotation IDs are uniform 404s", async () => {
  const cases = [
    ["postAudio", req({ params: { id: REVIEW }, body: Buffer.from("0000ftyp"),
      headers: { "content-type": "audio/mp4" } })],
    ["postAnswer", req({ params: { id: REVIEW }, body: { reel: [], duration_s: 3 } })],
    ["getAnnotation", req({ params: { id: REVIEW } })],
  ];
  for (const [method, request] of cases) {
    const mock = mockFetch(({ url }) => {
      assert.match(url, new RegExp(`coach_id=eq\\.${COACH}`));
      return response([]);
    });
    try {
      const out = res();
      await handlers()[method](request, out);
      assert.deepEqual([out.statusCode, out.body], [404, { error: "not_found" }]);
      assert.equal(out.statusCode === 402 || out.statusCode === 403, false);
      assert.equal(mock.calls.some((call) => call.method !== "GET"), false);
    } finally { mock.restore(); }
  }
});

test("decline winning during audio upload rejects and deletes the orphan object", async () => {
  let reviewReads = 0;
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("/video_reviews?") && method === "GET") {
      reviewReads++;
      if (reviewReads === 1) return response([reviewRow()]);
      if (url.includes("status=in.(submitted,in_review)")) return response([]);
      return response([reviewRow({ status: "declined" })]);
    }
    if (url.includes("/storage/v1/object/") && method === "POST") return response({});
    if (url.includes("/storage/v1/object/") && method === "DELETE") return response({});
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await handlers().postAudio(req({
      params: { id: REVIEW }, body: Buffer.from("0000ftypisom"),
      headers: { "content-type": "audio/mp4" },
    }), out);
    assert.deepEqual([out.statusCode, out.body], [409, { error: "review_declined" }]);
    const cleanup = mock.calls.find((call) => call.method === "DELETE");
    assert.match(cleanup.url, new RegExp(`/reviews/${COACH}/${REVIEW}/[0-9a-f-]{36}\\.m4a$`));
  } finally { mock.restore(); }
});

test("audio upload maps network rejection to storage_failed and a vanished row to not_found", async () => {
  let mock = mockFetch(({ url, method }) => {
    if (url.includes("/video_reviews?") && method === "GET") return response([reviewRow()]);
    if (url.includes("/storage/v1/object/") && method === "POST") {
      throw new TypeError("network down");
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await handlers().postAudio(req({ params: { id: REVIEW }, body: Buffer.from("0000ftypisom"),
      headers: { "content-type": "audio/mp4" } }), out);
    assert.deepEqual([out.statusCode, out.body], [502, { error: "storage_failed" }]);
  } finally { mock.restore(); }

  let reads = 0;
  mock = mockFetch(({ url, method }) => {
    if (url.includes("/video_reviews?") && method === "GET") {
      reads++;
      return response(reads === 1 ? [reviewRow()] : []);
    }
    if (url.includes("/storage/v1/object/") && method === "POST") return response({});
    if (url.includes("/storage/v1/object/") && method === "DELETE") return response({});
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await handlers().postAudio(req({ params: { id: REVIEW }, body: Buffer.from("0000ftypisom"),
      headers: { "content-type": "audio/mp4" } }), out);
    assert.deepEqual([out.statusCode, out.body], [404, { error: "not_found" }]);
  } finally { mock.restore(); }
});

test("silent answer inserts once, tenant-patches status, and emits exact answered notification", async () => {
  const notifications = [];
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("/video_reviews?") && method === "GET") return response([reviewRow()]);
    if (url.includes("/review_annotations?") && method === "GET") return response([]);
    if (url.endsWith("/review_annotations") && method === "POST") {
      assert.equal(body.coach_id, COACH);
      assert.equal(body.audio_path, null);
      return response([annotationRow({ reel: body.reel, duration_s: body.duration_s,
        shared_at: body.shared_at.replace("Z", "+00:00") })]);
    }
    if (url.includes("/video_reviews?") && method === "PATCH") {
      assert.match(url, new RegExp(`coach_id=eq\\.${COACH}`));
      assert.match(url, /status=in\.\(submitted,in_review\)/);
      return response([{ status: "answered", answered_at: body.answered_at }]);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await handlers({ notify: async (event) => notifications.push(event) }).postAnswer(
      req({ params: { id: REVIEW }, body: { reel: [], duration_s: 3 } }), out);
    assert.equal(out.statusCode, 201);
    assert.equal(out.body.annotation.has_audio, false);
    assert.equal(out.body.review.status, "answered");
    assert.deepEqual(notifications[0], {
      userId: USER, type: "review.answered", title: "Your film review is ready",
      body: "Coach C sent your annotated review.",
      data: { reviewId: REVIEW, href: `/reviews/${REVIEW}/watch` },
      dedupeKey: `review.answered:${REVIEW}`,
    });
  } finally { mock.restore(); }
});

test("decline winning the conditional answer transition leaves no annotation", async () => {
  let reviewReads = 0;
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("/video_reviews?") && method === "GET") {
      reviewReads++;
      return response([reviewRow({ status: reviewReads === 1 ? "submitted" : "declined" })]);
    }
    if (url.endsWith("/review_annotations") && method === "POST") return response([annotationRow()]);
    if (url.includes("/review_annotations?") && method === "DELETE") return response([]);
    if (url.includes("/video_reviews?") && method === "PATCH") {
      assert.match(url, /status=in\.\(submitted,in_review\)/);
      return response([]);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await handlers().postAnswer(req({ params: { id: REVIEW },
      body: { reel: [], duration_s: 3 } }), out);
    assert.deepEqual([out.statusCode, out.body], [409, { error: "review_declined" }]);
    assert.equal(mock.calls.some((call) =>
      call.method === "POST" && call.url.endsWith("/review_annotations")), true);
    assert.equal(mock.calls.some((call) =>
      call.method === "DELETE" && call.url.includes("/review_annotations?")), true);
  } finally { mock.restore(); }
});

test("failed decline cleanup still returns 409 and declined annotation reads never serve the orphan", async () => {
  let reviewReads = 0;
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("/video_reviews?") && method === "GET") {
      reviewReads++;
      return response([reviewRow({ status: reviewReads === 1 ? "submitted" : "declined" })]);
    }
    if (url.endsWith("/review_annotations") && method === "POST") return response([annotationRow()]);
    if (url.includes("/video_reviews?") && method === "PATCH") return response([]);
    if (url.includes("/review_annotations?") && method === "DELETE") {
      return response({}, 500, "cleanup denied");
    }
    if (url.includes("/review_annotations?") && method === "GET") return response([annotationRow()]);
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    let out = res();
    await handlers().postAnswer(req({ params: { id: REVIEW },
      body: { reel: [], duration_s: 3 } }), out);
    assert.deepEqual([out.statusCode, out.body], [409, { error: "review_declined" }]);

    out = res();
    await handlers().getAnnotation(req({ params: { id: REVIEW } }), out);
    // Contract §1.7: owned declined review reads as 409, orphan never served.
    assert.deepEqual([out.statusCode, out.body], [409, { error: "review_declined" }]);
    assert.equal(mock.calls.filter((call) => call.method === "DELETE").length, 2);
    assert.equal(mock.calls.some((call) => call.method === "GET" &&
      call.url.includes("/review_annotations?")), false);
  } finally { mock.restore(); }
});

test("answer transition race returns not_found when the owned row vanished", async () => {
  let reviewReads = 0;
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("/video_reviews?") && method === "GET") {
      reviewReads++;
      return response(reviewReads === 1 ? [reviewRow()] : []);
    }
    if (url.endsWith("/review_annotations") && method === "POST") return response([annotationRow()]);
    if (url.includes("/video_reviews?") && method === "PATCH") return response([]);
    if (url.includes("/review_annotations?") && method === "DELETE") return response([]);
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await handlers().postAnswer(req({ params: { id: REVIEW },
      body: { reel: [], duration_s: 3 } }), out);
    assert.deepEqual([out.statusCode, out.body], [404, { error: "not_found" }]);
    assert.equal(mock.calls.some((call) => call.method === "DELETE"), true);
  } finally { mock.restore(); }
});

test("annotation insert failure leaves review pending and an equal retry succeeds", async () => {
  let insertAttempts = 0;
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("/video_reviews?") && method === "GET") return response([reviewRow()]);
    if (url.endsWith("/review_annotations") && method === "POST") {
      insertAttempts++;
      if (insertAttempts === 1) return response({}, 500, "db down");
      return response([annotationRow({ shared_at: body.shared_at })]);
    }
    if (url.includes("/video_reviews?") && method === "PATCH") {
      return response([{ status: "answered", answered_at: body.answered_at }]);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    let out = res();
    await handlers().postAnswer(req({ params: { id: REVIEW },
      body: { reel: [], duration_s: 3 } }), out);
    assert.deepEqual([out.statusCode, out.body], [500, { error: "internal_error" }]);
    assert.equal(mock.calls.some((call) => call.method === "PATCH"), false);

    out = res();
    await handlers().postAnswer(req({ params: { id: REVIEW },
      body: { reel: [], duration_s: 3 } }), out);
    assert.equal(out.statusCode, 201);
    assert.equal(insertAttempts, 2);
  } finally { mock.restore(); }
});

test("answer reel validation rejects malformed kinds, keys, times, geometry, rates, and bounds", async () => {
  const goodShape = {
    id: "shape-1", tool: "line", cs: 1, color: "#abcdef", width: 2,
    from: { x: 0, y: 0 }, to: { x: 1, y: 1 },
  };
  const badReels = [
    [{ t: 0, kind: "wat" }],
    [{ t: 0, kind: "undo", extra: true }],
    [{ t: 2, kind: "undo" }, { t: 1, kind: "clear" }],
    [{ t: 4, kind: "clear" }],
    [{ t: 0, kind: "shape", shape: { ...goodShape, cs: 0 } }],
    [{ t: 0, kind: "shape", shape: { ...goodShape, from: { x: Infinity, y: 0 } } }],
    [{ t: 0, kind: "rate", rate: 0.75 }],
    [{ t: 0, kind: "seek", pos: 32 }],
    [{ t: NaN, kind: "clear" }],
    Array.from({ length: 5001 }, () => ({ t: 0, kind: "clear" })),
  ];
  for (const reel of badReels) {
    const mock = mockFetch(() => response([reviewRow()]));
    try {
      const out = res();
      await handlers().postAnswer(req({ params: { id: REVIEW },
        body: { reel, duration_s: 3 } }), out);
      assert.deepEqual([out.statusCode, out.body], [400, { error: "invalid_reel" }]);
      assert.equal(mock.calls.some((c) => c.method === "POST"), false);
    } finally { mock.restore(); }
  }

  const mock = mockFetch(() => response([reviewRow()]));
  try {
    const out = res();
    await handlers().postAnswer(req({ params: { id: REVIEW },
      body: { reel: [], duration_s: 901 } }), out);
    assert.deepEqual([out.statusCode, out.body], [400, { error: "invalid_reel" }]);
  } finally { mock.restore(); }
});

test("reel positions use known video duration plus one and unknown duration uses 3600", async () => {
  const cases = [
    { videoDuration: 4000, pos: 4001, status: 201 },
    { videoDuration: 4000, pos: 4002, status: 400 },
    { videoDuration: null, pos: 3600, status: 201 },
    { videoDuration: null, pos: 3600.01, status: 400 },
  ];
  for (const item of cases) {
    const mock = mockFetch(({ url, method, body }) => {
      if (url.includes("video_reviews") && method === "GET") {
        return response([reviewRow({ videos: videoRow({ duration_s: item.videoDuration }) })]);
      }
      if (url.endsWith("review_annotations") && method === "POST") {
        return response([annotationRow({ reel: body.reel, shared_at: body.shared_at })]);
      }
      if (url.includes("video_reviews") && method === "PATCH") {
        return response([{ status: "answered", answered_at: body.answered_at }]);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    try {
      const out = res();
      await handlers().postAnswer(req({ params: { id: REVIEW }, body: {
        reel: [{ t: 0, kind: "seek", pos: item.pos }], duration_s: 3,
      } }), out);
      assert.equal(out.statusCode, item.status, JSON.stringify(item));
      if (item.status === 400) assert.deepEqual(out.body, { error: "invalid_reel" });
    } finally { mock.restore(); }
  }
});

test("annotation insert 409 distinguishes vanished FK from review_id uniqueness", async () => {
  let reviewReads = 0;
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("video_reviews") && method === "GET") {
      reviewReads++;
      return response(reviewReads === 1 ? [reviewRow()] : []);
    }
    if (url.endsWith("review_annotations") && method === "POST") {
      return response({
        code: "23503",
        details: `Key (review_id)=(${REVIEW}) is not present in table \"video_reviews\".`,
        message: "insert or update violates foreign key constraint",
      }, 409);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await handlers().postAnswer(req({ params: { id: REVIEW },
      body: { reel: [], duration_s: 3 } }), out);
    assert.deepEqual([out.statusCode, out.body], [404, { error: "not_found" }]);
    assert.equal(reviewReads, 2);
    assert.equal(mock.calls.some((call) => call.url.includes("review_annotations?")), false);
  } finally { mock.restore(); }
});

test("answer rejects arbitrary audio paths and verifies an exact owned path exists", async () => {
  const paths = [
    `${ATHLETE}/voice.m4a`,
    `reviews/${COACH}/99999999-9999-4999-8999-999999999999/${ANNOTATION}.m4a`,
  ];
  for (const audio_path of paths) {
    const mock = mockFetch(() => response([reviewRow()]));
    try {
      const out = res();
      await handlers().postAnswer(req({ params: { id: REVIEW },
        body: { reel: [], audio_path, duration_s: 3 } }), out);
      assert.deepEqual([out.statusCode, out.body], [400, { error: "invalid_audio_path" }]);
      assert.equal(mock.calls.some((c) => c.url.includes("/storage/")), false);
    } finally { mock.restore(); }
  }

  const exact = `reviews/${COACH}/${REVIEW}/${ANNOTATION}.m4a`;
  const mock = mockFetch(({ url }) => {
    if (url.includes("video_reviews")) return response([reviewRow()]);
    if (url.includes("/storage/v1/object/list/")) return response([]);
    throw new Error(`unexpected ${url}`);
  });
  try {
    const out = res();
    await handlers().postAnswer(req({ params: { id: REVIEW },
      body: { reel: [], audio_path: exact, duration_s: 3 } }), out);
    assert.deepEqual([out.statusCode, out.body], [400, { error: "invalid_audio_path" }]);
    const list = mock.calls.find((c) => c.url.includes("/storage/v1/object/list/"));
    assert.deepEqual(list.body, {
      prefix: `reviews/${COACH}/${REVIEW}/`, limit: 100, offset: 0,
      search: `${ANNOTATION}.m4a`,
    });
  } finally { mock.restore(); }
});

test("audio-object verification network rejection maps to storage_failed", async () => {
  const audio = `reviews/${COACH}/${REVIEW}/${ANNOTATION}.m4a`;
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("video_reviews") && method === "GET") return response([reviewRow()]);
    if (url.includes("/storage/v1/object/list/")) throw new TypeError("network down");
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await handlers().postAnswer(req({ params: { id: REVIEW },
      body: { reel: [], audio_path: audio, duration_s: 3 } }), out);
    assert.deepEqual([out.statusCode, out.body], [502, { error: "storage_failed" }]);
  } finally { mock.restore(); }
});

test("voice answer verifies the exact object then stores only its private path", async () => {
  const audio = `reviews/${COACH}/${REVIEW}/${ANNOTATION}.m4a`;
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("video_reviews") && method === "GET") return response([reviewRow()]);
    if (url.includes("/storage/v1/object/list/")) return response([{ name: `${ANNOTATION}.m4a` }]);
    if (url.includes("review_annotations?") && method === "GET") return response([]);
    if (url.endsWith("review_annotations") && method === "POST") {
      assert.equal(body.audio_path, audio);
      return response([annotationRow({ audio_path: audio, shared_at: body.shared_at })]);
    }
    if (url.includes("video_reviews") && method === "PATCH") {
      return response([{ status: "answered", answered_at: body.answered_at }]);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await handlers().postAnswer(req({ params: { id: REVIEW },
      body: { reel: [], audio_path: audio, duration_s: 3 } }), out);
    assert.equal(out.statusCode, 201);
    assert.equal(out.body.annotation.has_audio, true);
    assert.equal(out.body.annotation.audio_path, undefined);
  } finally { mock.restore(); }
});

test("two instances interleave through the real insert-first unique-conflict path", async () => {
  let status = "submitted";
  let stored = null;
  const initialReads = [];
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("video_reviews") && method === "GET") {
      if (initialReads.length < 2) {
        return new Promise((resolve) => {
          initialReads.push(resolve);
          if (initialReads.length === 2) {
            for (const release of initialReads) release(response([reviewRow()]));
          }
        });
      }
      return response([reviewRow({ status, answered_at: status === "answered" ? SHARED : null })]);
    }
    if (url.includes("review_annotations?") && method === "GET") return response(stored ? [stored] : []);
    if (url.endsWith("review_annotations") && method === "POST") {
      if (!stored) {
        stored = annotationRow({ reel: body.reel, audio_path: body.audio_path,
          duration_s: body.duration_s, shared_at: body.shared_at });
        return response([stored]);
      }
      return response({
        code: "23505",
        details: `Key (review_id)=(${REVIEW}) already exists.`,
        message: "duplicate key value violates unique constraint",
      }, 409);
    }
    if (url.includes("video_reviews") && method === "PATCH") {
      if (status !== "submitted") return response([]);
      status = "answered";
      return response([{ status, answered_at: body.answered_at }]);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const first = res();
    const second = res();
    await Promise.all([
      handlers().postAnswer(req({ params: { id: REVIEW }, body: { reel: [], duration_s: 3 } }), first),
      handlers().postAnswer(req({ params: { id: REVIEW }, body: { reel: [], duration_s: 3 } }), second),
    ]);
    assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 201]);
    assert.equal(first.body.review.status, "answered");
    assert.equal(second.body.review.status, "answered");
    assert.equal(mock.calls.filter((call) => call.method === "POST" &&
      call.url.endsWith("/review_annotations")).length, 2);
    assert.equal(mock.calls.filter((call) => call.url.includes("review_annotations?") &&
      call.method === "GET").length, 1);
  } finally { mock.restore(); }
});

test("PATCH failure retains the inserted annotation so an equal retry repairs status", async () => {
  let stored = null;
  let patchAttempts = 0;
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("video_reviews") && method === "GET") return response([reviewRow()]);
    if (url.endsWith("review_annotations") && method === "POST") {
      if (!stored) {
        stored = annotationRow({ shared_at: body.shared_at });
        return response([stored]);
      }
      return response({
        code: "23505",
        details: `Key (review_id)=(${REVIEW}) already exists.`,
        message: "duplicate key value violates unique constraint",
      }, 409);
    }
    if (url.includes("review_annotations?") && method === "GET") return response([stored]);
    if (url.includes("video_reviews") && method === "PATCH") {
      patchAttempts++;
      if (patchAttempts === 1) return response({}, 500, "db down");
      return response([{ status: "answered", answered_at: body.answered_at }]);
    }
    if (url.includes("review_annotations?") && method === "DELETE") {
      throw new Error("contract repair row must not be deleted");
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    let out = res();
    await handlers().postAnswer(req({ params: { id: REVIEW },
      body: { reel: [], duration_s: 3 } }), out);
    assert.deepEqual([out.statusCode, out.body], [500, { error: "internal_error" }]);

    out = res();
    await handlers().postAnswer(req({ params: { id: REVIEW },
      body: { reel: [], duration_s: 3 } }), out);
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.review.status, "answered");
    assert.equal(mock.calls.some((call) => call.method === "DELETE"), false);
  } finally { mock.restore(); }
});

test("answered identical replay is 200 and a different replay is 409", async () => {
  for (const different of [false, true]) {
    const stored = annotationRow({ reel: [], duration_s: 3 });
    const mock = mockFetch(({ url, method }) => {
      if (url.includes("video_reviews") && method === "GET") {
        return response([reviewRow({ status: "answered", answered_at: SHARED })]);
      }
      if (url.includes("review_annotations") && method === "GET") return response([stored]);
      throw new Error(`unexpected ${method} ${url}`);
    });
    try {
      const out = res();
      await handlers().postAnswer(req({ params: { id: REVIEW },
        body: { reel: different ? [{ t: 0, kind: "clear" }] : [], duration_s: 3 } }), out);
      if (different) assert.deepEqual([out.statusCode, out.body], [409, { error: "already_answered" }]);
      else {
        assert.equal(out.statusCode, 200);
        assert.equal(mock.calls.some((c) => c.method === "PATCH"), false);
      }
    } finally { mock.restore(); }
  }
});

test("lost PATCH response is recovered by identical retry notification", async () => {
  let status = "submitted";
  let stored;
  const notifications = [];
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("video_reviews") && method === "GET") {
      return response([reviewRow({ status, answered_at: status === "answered" ? SHARED : null })]);
    }
    if (url.endsWith("review_annotations") && method === "POST") {
      stored = annotationRow({ shared_at: body.shared_at });
      return response([stored]);
    }
    if (url.includes("video_reviews") && method === "PATCH") {
      status = "answered";
      throw new TypeError("response dropped after commit");
    }
    if (url.includes("review_annotations?") && method === "GET") return response([stored]);
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    let out = res();
    const built = handlers({ notify: async (event) => notifications.push(event) });
    await built.postAnswer(req({ params: { id: REVIEW },
      body: { reel: [], duration_s: 3 } }), out);
    assert.deepEqual([out.statusCode, out.body], [500, { error: "internal_error" }]);
    assert.equal(notifications.length, 0);

    out = res();
    await built.postAnswer(req({ params: { id: REVIEW },
      body: { reel: [], duration_s: 3 } }), out);
    assert.equal(out.statusCode, 200);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].dedupeKey, `review.answered:${REVIEW}`);
  } finally { mock.restore(); }
});

test("answered annotation signs verified source/audio and emits no private paths", async () => {
  const audio = `reviews/${COACH}/${REVIEW}/${ANNOTATION}.m4a`;
  const signed = [];
  const mock = mockFetch(({ url }) => {
    if (url.includes("video_reviews")) return response([reviewRow({
      status: "answered", answered_at: SHARED,
    })]);
    if (url.includes("review_annotations")) return response([annotationRow({ audio_path: audio })]);
    throw new Error(`unexpected ${url}`);
  });
  try {
    const out = res();
    await handlers({ signClipUrl: async (path) => {
      signed.push(path); return `https://signed.test/${signed.length}`;
    } }).getAnnotation(req({ params: { id: REVIEW } }), out);
    assert.deepEqual(signed, [`${ATHLETE}/rep.mp4`, audio]);
    assert.equal(out.body.source_url, "https://signed.test/1");
    assert.equal(out.body.audio_url, "https://signed.test/2");
    assert.equal(out.body.annotation.audio_path, undefined);
    assert.equal(JSON.stringify(out.body).includes(audio), false);
  } finally { mock.restore(); }
});

test("annotation state failures happen before signing", async () => {
  const cases = [
    [reviewRow(), 409, "review_not_answered"],
    [reviewRow({ status: "declined" }), 409, "review_declined"],
    [reviewRow({ status: "answered" }), 500, "annotation_missing"],
  ];
  for (const [row, status, code] of cases) {
    let signs = 0;
    const mock = mockFetch(({ url }) => {
      if (url.includes("video_reviews")) return response([row]);
      return response([]);
    });
    try {
      const out = res();
      await handlers({ signClipUrl: async () => { signs++; } }).getAnnotation(
        req({ params: { id: REVIEW } }), out);
      assert.deepEqual([out.statusCode, out.body], [status, { error: code }]);
      assert.equal(signs, 0);
    } finally { mock.restore(); }
  }
});

test("annotation rejects an invalid source path as not_found before signing", async () => {
  let signs = 0;
  const mock = mockFetch(({ url }) => {
    if (url.includes("video_reviews")) return response([reviewRow({
      status: "answered", answered_at: SHARED,
      videos: videoRow({ url: "https://evil.test/source.mp4" }),
    })]);
    if (url.includes("review_annotations")) return response([annotationRow()]);
    throw new Error(`unexpected ${url}`);
  });
  try {
    const out = res();
    await handlers({ signClipUrl: async () => { signs++; } }).getAnnotation(
      req({ params: { id: REVIEW } }), out);
    assert.deepEqual([out.statusCode, out.body], [404, { error: "not_found" }]);
    assert.equal(signs, 0);
  } finally { mock.restore(); }
});

test("decline is tenant-filtered, idempotent, notifies exactly, and never touches media", async () => {
  const notifications = [];
  for (const initial of ["submitted", "declined"]) {
    const mock = mockFetch(({ url, method }) => {
      if (url.includes("video_reviews") && method === "GET") return response([reviewRow({ status: initial })]);
      if (url.includes("video_reviews") && method === "PATCH") {
        assert.match(url, new RegExp(`coach_id=eq\\.${COACH}`));
        assert.match(url, /status=in\.\(submitted,in_review\)/);
        return response([{ status: "declined" }]);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    try {
      const out = res();
      await handlers({ notify: async (event) => notifications.push(event) }).postDecline(
        req({ params: { id: REVIEW }, body: {} }), out);
      assert.equal(out.statusCode, 200);
      assert.equal(out.body.review.status, "declined");
      assert.equal(mock.calls.some((c) => c.url.includes("/storage/") || c.method === "DELETE"), false);
    } finally { mock.restore(); }
  }
  assert.deepEqual(notifications[0], {
    userId: USER, type: "review.declined", title: "Film review declined",
    body: "Your coach couldn't review this clip. Choose another clip and try again.",
    data: { reviewId: REVIEW, href: "/athlete/film" },
    dedupeKey: `review.declined:${REVIEW}`,
  });
  assert.deepEqual(notifications[1], notifications[0]);
});

test("foreign decline is 404, answered decline is 409, and body override is 400", async () => {
  const cases = [
    [null, {}, 404, "not_found"],
    [reviewRow({ status: "answered" }), {}, 409, "already_answered"],
    [null, { coach_id: COACH }, 400, "invalid_body"],
  ];
  for (const [row, body, status, code] of cases) {
    const mock = mockFetch(({ method }) => method === "GET" ? response(row ? [row] : []) : response([]));
    try {
      const out = res();
      await handlers().postDecline(req({ params: { id: REVIEW }, body }), out);
      assert.deepEqual([out.statusCode, out.body], [status, { error: code }]);
      assert.equal(out.statusCode === 402 || out.statusCode === 403, false);
      assert.equal(mock.calls.some((c) => c.method === "PATCH"), false);
    } finally { mock.restore(); }
  }
});

test("configuration/read/storage/sign failures map to 503/500/502 and notify throws fail soft", async () => {
  const oldUrl = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  let out = res();
  await handlers().getReviews(req(), out);
  assert.deepEqual([out.statusCode, out.body], [503, { error: "not_configured" }]);
  process.env.SUPABASE_URL = oldUrl;

  let mock = mockFetch(() => response({}, 500, "db down"));
  try {
    out = res();
    await handlers().getReviews(req(), out);
    assert.deepEqual([out.statusCode, out.body], [500, { error: "internal_error" }]);
  } finally { mock.restore(); }

  mock = mockFetch(() => response([reviewRow()]));
  try {
    out = res();
    await handlers({ signClipUrl: async () => { throw new Error("sign down"); } }).getReview(
      req({ params: { id: REVIEW } }), out);
    assert.deepEqual([out.statusCode, out.body], [502, { error: "signing_failed" }]);
  } finally { mock.restore(); }

  mock = mockFetch(({ url, method, body }) => {
    if (url.includes("video_reviews") && method === "GET") return response([reviewRow()]);
    if (url.includes("review_annotations") && method === "GET") return response([]);
    if (url.endsWith("review_annotations") && method === "POST") {
      return response([annotationRow({ shared_at: body.shared_at })]);
    }
    if (method === "PATCH") return response([{ status: "answered", answered_at: body.answered_at }]);
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    out = res();
    await handlers({ notify: async () => { throw new Error("push down"); } }).postAnswer(
      req({ params: { id: REVIEW }, body: { reel: [], duration_s: 3 } }), out);
    assert.equal(out.statusCode, 201);
  } finally { mock.restore(); }
});

test("auth failures preserve the shared primitive's status and error string", async () => {
  const oldUrl = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  try {
    const out = res();
    await handlers({
      requireSupabaseUser: async () => ({ status: 503, error: "auth not configured" }),
    }).getReviews(req(), out);
    assert.deepEqual([out.statusCode, out.body], [503, { error: "auth not configured" }]);
  } finally { process.env.SUPABASE_URL = oldUrl; }
});

test("deleted-athlete lifecycle emits the amended nullable athlete DTO", async () => {
  // PM amendment 2026-07-16 (contract §0.3): after a coach hard-deletes an
  // athlete, 0027's ON DELETE SET NULL leaves athlete_id null; the DTO shape
  // is athlete: { id: null, name: "" }, never a missing/undefined field.
  const orphan = reviewRow({ athlete_id: null, athletes: null });
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("/video_reviews?") && method === "GET") return response([orphan]);
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const out = res();
    await handlers().getReviews(req(), out);
    assert.equal(out.statusCode, 200);
    assert.deepEqual(out.body.reviews[0].athlete, { id: null, name: "" });
  } finally { mock.restore(); }
});
