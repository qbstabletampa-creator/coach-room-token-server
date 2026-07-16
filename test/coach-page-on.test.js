const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "service-key";
delete process.env.COACH_GALLERY_BUCKET;
delete process.env.COACH_GALLERY_SIGN_TTL_S;

const coachPage = require("../lib/coach-page");
const {
  buildCoachPageHandlers, readPublicCoachPage, normalizeProfile, normalizeSections,
  canonicalSocialUrl, detectImage, defaultsSections, mergeSections, galleryTtl,
  parseObjectPath, guardianConsentRecorded,
} = coachPage;

const COACH = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ROW = "33333333-3333-4333-8333-333333333333";
const KEY = "44444444-4444-4444-8444-444444444444";
const OBJECT = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-07-16T12:00:00.000Z");
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const GUARDIAN_RECORDED_AT = "2026-07-15T10:00:00.000Z";

function response(body, status = 200, json = true) {
  return { ok: status >= 200 && status < 300, status,
    json: async () => { if (!json) throw new SyntaxError("bad json"); return body; },
    text: async () => typeof body === "string" ? body : JSON.stringify(body) };
}
function mockFetch(fn) {
  const previous = global.fetch, calls = [];
  global.fetch = async (url, options = {}) => {
    let body = options.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) {} }
    const call = { url: String(url), method: options.method || "GET", headers: options.headers || {}, body, rawBody: options.body };
    calls.push(call); return fn(call, calls);
  };
  return { calls, restore() { global.fetch = previous; } };
}
function req(overrides = {}) { return { query: {}, params: {}, body: {}, headers: { "content-type": "application/json" }, ...overrides }; }
function res() { return { statusCode: 200, body: undefined, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
function auth(role = "coach") { return async () => ({ user: { id: COACH, app_metadata: role === "coach" ? { role } : {}, user_metadata: { role: "coach" } } }); }
function handlers(overrides = {}) { return buildCoachPageHandlers({ requireSupabaseUser: auth(), now: () => new Date(NOW), randomUUID: () => OBJECT, ...overrides }); }
function uploadHeaders(overrides = {}) { return { "content-type": "image/png", "idempotency-key": KEY, "x-coach-page-consent": "confirmed", "x-coach-page-identifiable-minor": "true", "x-coach-page-guardian-consent": "true", ...overrides }; }
function profile(overrides = {}) { return { headline: null, years_experience: null, languages: [], reply_time: null, how_i_work: null, ...overrides }; }
function location(overrides = {}) { return { id: ROW, coach_id: COACH, name: "Gym", address: null, note: null, active: true, sort: 0, ...overrides }; }
function photo(overrides = {}) { return { id: ROW, coach_id: COACH, object_path: `${COACH}/${OBJECT}.png`, upload_key: KEY, sha256: require("node:crypto").createHash("sha256").update(PNG).digest("hex"), caption: null, active: true, sort: 0, consent_attested_at: NOW.toISOString(), identifiable_minor: true, guardian_consent_recorded_at: GUARDIAN_RECORDED_AT, ...overrides }; }

test("factory is inert, has exactly twelve handlers, and forbidden modules are absent", () => {
  let calls = 0;
  const built = buildCoachPageHandlers({ requireSupabaseUser: () => calls++, now: () => calls++, randomUUID: () => calls++ });
  assert.deepEqual(Object.keys(built), ["getCoachPage", "patchProfile", "postLocation", "patchLocation", "deleteLocation", "postPhoto", "patchPhoto", "deletePhoto", "postSocial", "patchSocial", "deleteSocial", "putSections"]);
  assert.equal(calls, 0);
  const source = require("node:fs").readFileSync(require.resolve("../lib/coach-page"), "utf8");
  for (const forbidden of ["./notify", "./storefront", "./scheduling", "./api", "./mcp", "./claims", "./packages"]) assert.equal(source.includes(`require(\"${forbidden}`), false);
});

test("pure validators pin Unicode normalization, duplicate languages and complete sections", () => {
  assert.deepEqual(normalizeProfile({ headline: "  Coach 🚀  ", years_experience: null, languages: ["English", "Español"], how_i_work: " " }), { headline: "Coach 🚀", years_experience: null, languages: ["English", "Español"], how_i_work: null });
  assert.throws(() => normalizeProfile({ languages: ["English", "english"] }));
  assert.throws(() => normalizeProfile({ years_experience: "12" }));
  const sections = defaultsSections().map((s, i) => ({ ...s, visible: i !== 3 }));
  assert.deepEqual(normalizeSections({ sections }), sections);
  assert.throws(() => normalizeSections({ sections: sections.map((s, i) => ({ ...s, sort: i === 6 ? 5 : i })) }));
  assert.deepEqual(mergeSections([]), defaultsSections());
  const adversarial = [
    { id: "99999999-9999-4999-8999-999999999999", section_key: "gallery", visible: false, sort: 0 },
    { id: "11111111-1111-4111-8111-111111111111", section_key: "about", visible: true, sort: 0 },
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", section_key: "gallery", visible: true, sort: 6 },
    { id: "44444444-4444-4444-8444-444444444444", section_key: "socials", visible: false, sort: 4 },
  ];
  const repaired = mergeSections(adversarial);
  assert.deepEqual(mergeSections(adversarial.slice().reverse()), repaired, "repair must not depend on response order");
  assert.deepEqual(repaired.map((s) => s.sort), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(new Set(repaired.map((s) => s.key)), new Set(defaultsSections().map((s) => s.key)));
  assert.deepEqual(repaired.slice(0, 2).map((s) => s.key), ["about", "gallery"]);
  assert.equal(guardianConsentRecorded(photo()), true);
  assert.equal(guardianConsentRecorded(photo({ guardian_consent_recorded_at: null })), false);
});

test("social URL policy rejects lookalikes, suffixes, userinfo and HTTP", () => {
  assert.equal(canonicalSocialUrl("instagram", "https://www.instagram.com/coach"), "https://www.instagram.com/coach");
  for (const url of ["https://instagram.com.evil.test/x", "https://evilinstagram.com/x", "https://user@instagram.com/x", "http://instagram.com/x"]) assert.throws(() => canonicalSocialUrl("instagram", url));
  assert.equal(canonicalSocialUrl("web", "https://example.test/path"), "https://example.test/path");
});

test("media magic, TTL bounds, and object path parser are strict", () => {
  assert.deepEqual(detectImage(PNG, "image/png"), { contentType: "image/png", extension: "png" });
  assert.throws(() => detectImage(Buffer.from("<svg>"), "image/png"));
  assert.deepEqual(detectImage(Buffer.from("GIF89a"), "image/gif"), { unsupported: true });
  assert.equal(galleryTtl("60"), 60); assert.equal(galleryTtl("3600"), 3600); assert.equal(galleryTtl("59"), 900); assert.equal(galleryTtl("no"), 900);
  assert.deepEqual(parseObjectPath(COACH, `${COACH}/${OBJECT}.png`), { path: `${COACH}/${OBJECT}.png`, extension: "png" });
  for (const path of [`${OTHER}/${OBJECT}.png`, `${COACH}/../${OBJECT}.png`, `https://x/${OBJECT}.png`, `${COACH}/${OBJECT}.gif`]) assert.equal(parseObjectPath(COACH, path), null);
});

test("all protected handler shapes fail before authentication", async () => {
  let auths = 0; const h = buildCoachPageHandlers({ requireSupabaseUser: async () => { auths++; return { error: "no" }; } });
  const cases = [
    [h.getCoachPage, req({ query: { extra: "1" } })], [h.patchProfile, req({ body: { coach_id: COACH } })],
    [h.postLocation, req({ body: { name: "" } })], [h.patchLocation, req({ params: { id: "bad" }, body: { name: "x" } })],
    [h.deleteLocation, req({ params: { id: ROW }, body: { x: 1 } })], [h.postPhoto, req({ body: PNG, headers: { "content-type": "image/png" } })],
    [h.patchPhoto, req({ params: { id: ROW }, body: { identifiable_minor: false } })],
    [h.patchPhoto, req({ params: { id: ROW }, body: { guardian_consent: true } })], [h.deletePhoto, req({ params: { id: "bad" } })],
    [h.postSocial, req({ body: { platform: "instagram", url: "http://instagram.com/x" } })], [h.patchSocial, req({ params: { id: ROW }, body: {} })],
    [h.deleteSocial, req({ params: { id: ROW }, query: { x: 1 } })], [h.putSections, req({ body: { sections: [] } })],
  ];
  for (const [fn, request] of cases) { const out = res(); await fn(request, out); assert.equal(out.statusCode, 400); }
  assert.equal(auths, 0);
});

test("identity maps configuration, rejection, and unexpected exceptions exactly", async () => {
  let out = res(); await buildCoachPageHandlers({ requireSupabaseUser: async () => ({ error: "auth not configured", status: 503 }) }).getCoachPage(req(), out);
  assert.deepEqual([out.statusCode, out.body], [503, { error: "auth not configured" }]);
  out = res(); await buildCoachPageHandlers({ requireSupabaseUser: async () => ({ error: "bad token", status: 401 }) }).getCoachPage(req(), out);
  assert.deepEqual([out.statusCode, out.body], [401, { error: "authentication_required" }]);
  out = res(); await buildCoachPageHandlers({ requireSupabaseUser: async () => { throw new Error("auth backend exploded"); } }).getCoachPage(req(), out);
  assert.deepEqual([out.statusCode, out.body], [500, { error: "internal_error" }]);
  out = res(); await buildCoachPageHandlers({ requireSupabaseUser: auth("athlete") }).getCoachPage(req(), out);
  assert.deepEqual([out.statusCode, out.body], [403, { error: "forbidden" }]);
  const oldUrl = process.env.SUPABASE_URL; delete process.env.SUPABASE_URL;
  try { out = res(); await handlers().getCoachPage(req(), out); assert.deepEqual([out.statusCode, out.body], [503, { error: "not_configured" }]); }
  finally { process.env.SUPABASE_URL = oldUrl; }
});

test("editor read double-filters collections, merges defaults and strips internals", async () => {
  const mock = mockFetch(({ url }) => {
    if (url.includes("/coaches?")) { assert.match(url, new RegExp(`id=eq\\.${COACH}`)); return response([profile({ headline: "Hello" })]); }
    assert.match(url, new RegExp(`coach_id=eq\\.${COACH}`));
    if (url.includes("coach_locations")) return response([location()]);
    if (url.includes("coach_photos")) return response([]);
    if (url.includes("coach_socials")) return response([]);
    if (url.includes("coach_page_sections")) return response([]);
    throw new Error(url);
  });
  try { const out = res(); await handlers().getCoachPage(req(), out); assert.equal(out.statusCode, 200); assert.equal(out.body.coach_page.sections.length, 7); assert.equal(JSON.stringify(out.body).includes("coach_id"), false); assert.equal(out.body.coach_page.locations[0].name, "Gym"); }
  finally { mock.restore(); }
});

test("profile patch sends only normalized present values and rejects vanished row", async () => {
  let vanish = false;
  const mock = mockFetch(({ url, method, body }) => { assert.equal(method, "PATCH"); assert.match(url, new RegExp(`coaches\\?id=eq\\.${COACH}`)); if (!vanish) assert.deepEqual(body, { headline: null, languages: ["English"] }); return response(vanish ? [] : [profile(body)]); });
  try {
    let out = res(); await handlers().patchProfile(req({ body: { headline: " ", languages: [" English "] } }), out); assert.deepEqual([out.statusCode, out.body.profile.headline], [200, null]);
    vanish = true; out = res(); await handlers().patchProfile(req({ body: { headline: "x" } }), out); assert.deepEqual([out.statusCode, out.body], [404, { error: "not_found" }]);
  } finally { mock.restore(); }
});

test("foreign IDs are uniform 404 for every row handler and mutation is never attempted", async () => {
  const mock = mockFetch(({ url, method }) => { assert.equal(method, "GET"); assert.match(url, new RegExp(`id=eq\\.${ROW}.*coach_id=eq\\.${COACH}`)); return response([]); });
  const h = handlers();
  const cases = [[h.patchLocation, { name: "x" }], [h.deleteLocation, {}], [h.patchPhoto, { caption: "x" }], [h.deletePhoto, {}], [h.patchSocial, { sort: 2 }], [h.deleteSocial, {}]];
  try { for (const [fn, body] of cases) { const out = res(); await fn(req({ params: { id: ROW }, body }), out); assert.deepEqual([out.statusCode, out.body], [404, { error: "not_found" }]); } assert.equal(mock.calls.some((c) => c.method !== "GET"), false); }
  finally { mock.restore(); }
});

test("named social uniqueness is disambiguated by tenant reread", async () => {
  const detail = { code: "23505", message: "duplicate", details: "constraint coach_socials_platform_unique" };
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("coach_socials?") && url.includes("select=id") && !url.includes("platform=")) return response([]);
    if (method === "POST") return response(detail, 409);
    if (url.includes("platform=eq.instagram")) { assert.match(url, new RegExp(`coach_id=eq\\.${COACH}`)); return response([{ id: ROW }]); }
    throw new Error(`${method} ${url}`);
  });
  try { const out = res(); await handlers().postSocial(req({ body: { platform: "instagram", url: "https://instagram.com/coach" } }), out); assert.deepEqual([out.statusCode, out.body], [409, { error: "social_exists" }]); }
  finally { mock.restore(); }
});

test("new photo upload pins insert-only minor consent columns, private path, attestation and default-unpublished", async () => {
  const mock = mockFetch(({ url, method, headers, body }) => {
    if (url.includes("coach_photos?") && method === "GET" && !url.includes("coach_photos?id=eq.")) return response([]);
    if (url.includes("/storage/v1/object/coach-gallery-private/") && method === "POST" && !url.includes("/sign/")) { assert.equal(headers["x-upsert"], "false"); assert.equal(headers["content-type"], "image/png"); return response({ Key: `${COACH}/${OBJECT}.png` }); }
    if (url.endsWith("/rest/v1/coach_photos") && method === "POST") { assert.equal(body.coach_id, COACH); assert.equal(body.object_path, `${COACH}/${OBJECT}.png`); assert.equal(body.upload_key, KEY); assert.match(body.sha256, /^[a-f0-9]{64}$/); assert.equal(body.consent_attested_at, NOW.toISOString()); assert.equal(body.active, false); assert.equal(body.identifiable_minor, true); assert.equal(body.guardian_consent_recorded_at, NOW.toISOString()); assert.equal(Object.hasOwn(body, "metadata"), false); return response([photo(body)]); }
    if (url.includes("/object/sign/")) { assert.deepEqual(body, { expiresIn: 900 }); return response({ signedURL: "/storage/v1/object/sign/private?token=secret" }); }
    if (url.includes("coach_photos?id=eq.")) return response([photo({ active: false })]);
    throw new Error(`${method} ${url}`);
  });
  try { const out = res(); await handlers().postPhoto(req({ body: PNG, headers: uploadHeaders({ "x-coach-page-caption": encodeURIComponent(" Team ") }) }), out); assert.equal(out.statusCode, 201); assert.equal(out.body.photo.url.startsWith("https://test.supabase.co/"), true); for (const secret of ["object_path", "upload_key", "sha256", "coach_id"]) assert.equal(JSON.stringify(out.body).includes(secret), false); }
  finally { mock.restore(); }
});

test("upload consent request fields require exact serialized booleans before authentication", async () => {
  let auths = 0;
  const handler = buildCoachPageHandlers({ requireSupabaseUser: async () => { auths++; return { error: "no" }; } }).postPhoto;
  for (const headers of [
    uploadHeaders({ "x-coach-page-identifiable-minor": "yes" }),
    uploadHeaders({ "x-coach-page-guardian-consent": "1" }),
    (() => { const value = uploadHeaders(); delete value["x-coach-page-identifiable-minor"]; return value; })(),
    (() => { const value = uploadHeaders(); delete value["x-coach-page-guardian-consent"]; return value; })(),
  ]) {
    const out = res(); await handler(req({ body: PNG, headers }), out);
    assert.deepEqual([out.statusCode, out.body], [400, { error: "invalid_body" }]);
  }
  assert.equal(auths, 0);
});

test("minor publishing requires guardian consent while non-minor needs attestation alone", async () => {
  let current = photo({ active: false, guardian_consent_recorded_at: null }), patched = false, signs = 0;
  const mock = mockFetch(({ url, method, body }) => {
    if (method === "GET" && url.includes(`coach_photos?id=eq.${ROW}`)) return response([{ ...current, active: patched || current.active }]);
    if (method === "PATCH") { patched = true; current = { ...current, active: true }; assert.equal(body.active, true); assert.match(url, /consent_attested_at=not\.is\.null/); assert.match(url, /or=\(identifiable_minor\.eq\.false,guardian_consent_recorded_at\.not\.is\.null\)/); return response([current]); }
    if (url.includes("/object/sign/")) { signs++; return response({ signedURL: "https://test.supabase.co/signed" }); }
    throw new Error(`${method} ${url}`);
  });
  try {
    let out = res(); await handlers().patchPhoto(req({ params: { id: ROW }, body: { active: true } }), out);
    assert.deepEqual([out.statusCode, out.body], [400, { error: "guardian_consent_required" }]); assert.equal(patched, false); assert.equal(signs, 0);
    current = { ...current, guardian_consent_recorded_at: GUARDIAN_RECORDED_AT }; out = res(); await handlers().patchPhoto(req({ params: { id: ROW }, body: { active: true } }), out);
    assert.equal(out.statusCode, 200); assert.equal(out.body.photo.active, true); assert.equal(signs, 1);
    current = photo({ active: false, identifiable_minor: false, guardian_consent_recorded_at: null }); patched = false;
    out = res(); await handlers().patchPhoto(req({ params: { id: ROW }, body: { active: true } }), out);
    assert.equal(out.statusCode, 200); assert.equal(signs, 2);
  } finally { mock.restore(); }
});

test("a delete/sign race never returns a freshly signed capability", async () => {
  let ownedReads = 0, signs = 0;
  const mock = mockFetch(({ url, method }) => {
    if (method === "GET" && url.includes(`id=eq.${ROW}`)) { ownedReads++; return response(ownedReads === 1 ? [photo()] : []); }
    if (method === "PATCH") return response([photo({ caption: "new" })]);
    if (url.includes("/object/sign/")) { signs++; return response({ signedURL: "https://test.supabase.co/fresh-secret" }); }
    throw new Error(`${method} ${url}`);
  });
  try {
    const out = res(); await handlers().patchPhoto(req({ params: { id: ROW }, body: { caption: "new" } }), out);
    assert.deepEqual([out.statusCode, out.body], [404, { error: "not_found" }]); assert.equal(signs, 0); assert.equal(JSON.stringify(out.body).includes("fresh-secret"), false);
  } finally { mock.restore(); }
});

test("malformed successful upload response triggers best-effort object cleanup", async () => {
  let deleted = 0;
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("coach_photos?") && method === "GET") return response([]);
    if (url.includes("/storage/v1/object/") && method === "POST") return response("malformed", 200, false);
    if (url.includes("/storage/v1/object/") && method === "DELETE") { deleted++; return response({}, 200); }
    throw new Error(`${method} ${url}`);
  });
  try {
    const out = res(); await handlers().postPhoto(req({ body: PNG, headers: uploadHeaders() }), out);
    assert.deepEqual([out.statusCode, out.body], [502, { error: "storage_unavailable" }]); assert.equal(deleted, 1);
  } finally { mock.restore(); }
});

test("same-key retry returns 200 without upload while changed bytes conflict", async () => {
  let changed = false;
  const mock = mockFetch(({ url, method, body }) => {
    if (url.includes("coach_photos?") && method === "GET") return response([photo({ sha256: changed ? "0".repeat(64) : photo().sha256 })]);
    if (url.includes("/object/sign/")) return response({ signedURL: "https://test.supabase.co/signed" });
    throw new Error(`${method} ${url} ${body}`);
  });
  try {
    const request = req({ body: PNG, headers: uploadHeaders() });
    let out = res(); await handlers().postPhoto(request, out); assert.equal(out.statusCode, 200); assert.equal(mock.calls.some((c) => c.url.includes("/storage/v1/object/coach-gallery-private/") && !c.url.includes("/sign/")), false);
    changed = true; out = res(); await handlers().postPhoto(request, out); assert.deepEqual([out.statusCode, out.body], [409, { error: "idempotency_conflict" }]);
  } finally { mock.restore(); }
});

test("storage rejection maps to 502 while PostgREST invalid 2xx JSON maps to 500", async () => {
  let mode = "storage";
  const mock = mockFetch(({ url }) => {
    if (mode === "db") return response("no", 200, false);
    if (url.includes("coach_photos?") && !url.includes("select=id")) return response([photo()]);
    if (url.includes("coach_photos?") && url.includes("select=id")) return response([photo()]);
    if (url.includes("/rest/v1/coach_photos") && !url.includes("?")) return response([photo({ caption: "x" })]);
    if (url.includes("/object/sign/")) throw new TypeError("offline");
    throw new Error(url);
  });
  try {
    let out = res(); await handlers().patchPhoto(req({ params: { id: ROW }, body: { caption: "x" } }), out); assert.deepEqual([out.statusCode, out.body], [502, { error: "storage_unavailable" }]);
    mode = "db"; out = res(); await handlers().getCoachPage(req(), out); assert.deepEqual([out.statusCode, out.body], [500, { error: "internal_error" }]);
  } finally { mock.restore(); }
});

test("editor required photo live-recheck DbError fails the whole request", async () => {
  const mock = mockFetch(({ url }) => {
    if (url.includes("/coaches?")) return response([profile()]);
    if (url.includes("coach_photos?id=eq.")) return response("bad", 200, false);
    if (url.includes("coach_photos")) return response([photo()]);
    return response([]);
  });
  try {
    const out = res(); await handlers().getCoachPage(req(), out);
    assert.deepEqual([out.statusCode, out.body], [500, { error: "internal_error" }]);
    assert.equal(mock.calls.some((call) => call.url.includes("/object/sign/")), false);
  } finally { mock.restore(); }
});

test("public reader tenant-filters every query, requires attestation, signs valid paths and whitelists output", async () => {
  const mock = mockFetch(({ url, method }) => {
    if (url.includes("/object/sign/")) return response({ signedURL: "https://test.supabase.co/signed?token=x" });
    assert.equal(method, "GET");
    if (url.includes("/coaches?")) return response([profile({ headline: "Coach" })]);
    assert.match(url, new RegExp(`coach_id=eq\\.${COACH}`));
    if (url.includes("coach_locations")) { assert.match(url, /active=eq.true/); return response([location()]); }
    if (url.includes("coach_photos")) { assert.match(url, /consent_attested_at=not.is.null/); assert.match(url, /or=\(identifiable_minor.eq.false,guardian_consent_recorded_at.not.is.null\)/); assert.doesNotMatch(url, /metadata/); return response([photo()]); }
    if (url.includes("coach_socials")) return response([{ id: ROW, coach_id: COACH, platform: "web", url: "https://example.test/", sort: 0 }]);
    if (url.includes("coach_page_sections")) return response([]);
    throw new Error(url);
  });
  try { const value = await readPublicCoachPage({ coachId: COACH }); assert.equal(value.gallery.length, 1); assert.equal(value.sections.length, 7); for (const secret of ["id", "active", "coach_id", "object_path", "consent_attested_at"] ) assert.equal(JSON.stringify(value).includes(`\"${secret}\"`), false); }
  finally { mock.restore(); }
});

test("public reader defensively refuses to sign an unconsented row", async () => {
  let signs = 0;
  const mock = mockFetch(({ url }) => {
    if (url.includes("/object/sign/")) { signs++; return response({ signedURL: "https://test.supabase.co/forbidden" }); }
    if (url.includes("/coaches?")) return response([profile()]);
    if (url.includes("coach_photos")) return response([photo({ guardian_consent_recorded_at: null })]);
    return response([]);
  });
  try { const value = await readPublicCoachPage({ coachId: COACH }); assert.deepEqual(value.gallery, []); assert.equal(signs, 0); }
  finally { mock.restore(); }
});

test("public reader rechecks deletion before signing", async () => {
  let signs = 0;
  const mock = mockFetch(({ url }) => {
    if (url.includes("/object/sign/")) { signs++; return response({ signedURL: "https://test.supabase.co/raced-secret" }); }
    if (url.includes("/coaches?")) return response([profile()]);
    if (url.includes("coach_photos?id=eq.")) return response([]);
    if (url.includes("coach_photos")) return response([photo()]);
    return response([]);
  });
  try { const value = await readPublicCoachPage({ coachId: COACH }); assert.deepEqual(value.gallery, []); assert.equal(signs, 0); assert.equal(JSON.stringify(value).includes("raced-secret"), false); }
  finally { mock.restore(); }
});

test("public required photo live-recheck DbError rejects instead of returning a partial DTO", async () => {
  const mock = mockFetch(({ url }) => {
    if (url.includes("/coaches?")) return response([profile()]);
    if (url.includes("coach_photos?id=eq.")) return response("bad", 200, false);
    if (url.includes("coach_photos")) return response([photo()]);
    return response([]);
  });
  try {
    await assert.rejects(readPublicCoachPage({ coachId: COACH }), (err) => err && err.name === "DbError");
    assert.equal(mock.calls.some((call) => call.url.includes("/object/sign/")), false);
  } finally { mock.restore(); }
});

test("production random UUID seam yields unique v4 object identifiers", () => {
  const values = new Set(Array.from({ length: 128 }, () => require("node:crypto").randomUUID()));
  assert.equal(values.size, 128); for (const value of values) assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
