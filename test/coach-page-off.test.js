const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
process.env.SCHEDULING_ENABLED = "1";
delete process.env.COACH_PAGE_ENABLED;
const { app } = require("../index.js");

function startServer() {
  return new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })); });
}
function request(port, method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const call = http.request({ hostname: "127.0.0.1", port, method, path: url,
      headers: { ...headers, ...(bytes ? { "content-length": bytes.length } : {}) } }, (response) => {
      const chunks = []; response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, contentType: response.headers["content-type"], body: Buffer.concat(chunks) }));
    });
    call.on("error", reject); if (bytes) call.write(bytes); call.end();
  });
}

test("factory remains inert in a fresh flag-off process", () => {
  const env = { ...process.env }; delete env.COACH_PAGE_ENABLED; delete env.SUPABASE_URL; delete env.SUPABASE_SERVICE_KEY;
  const script = `
    let reads = 0;
    const old = process.env;
    process.env = new Proxy(old, { get(target, key) { if (String(key).startsWith('SUPABASE') || String(key).startsWith('COACH_GALLERY')) reads++; return target[key]; } });
    const m = require('./lib/coach-page');
    const h = m.buildCoachPageHandlers({ requireSupabaseUser() { throw new Error('must not run'); }, now() { throw new Error('must not run'); }, randomUUID() { throw new Error('must not run'); } });
    process.stdout.write(JSON.stringify({ reads, handlers: Object.keys(h).length }));
  `;
  const child = spawnSync(process.execPath, ["-e", script], { cwd: path.join(__dirname, ".."), env, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), { reads: 0, handlers: 12 });
});

test("W1 leaves flag registration hot zones and static public directory untouched", () => {
  const root = path.join(__dirname, "..");
  const index = fs.readFileSync(path.join(root, "index.js"), "utf8");
  assert.equal(index.includes('require("./lib/coach-page")'), false, "editor route registration is PM-MERGE owned");
  assert.equal(fs.existsSync(path.join(root, "public", "coach-page.html")), false);
  // views/coach-page.html IS a granted W1 deliverable (contract §3.1) — it is the
  // PM-selected renderer, mounted only when COACH_PAGE_ENABLED. Its mere presence
  // outside public/ does not register a static route; the flag-off route tests
  // below prove the surface stays inert.
  assert.equal(fs.existsSync(path.join(root, "views", "coach-page.html")), true, "renderer template is a W1 deliverable");
});

test("all twelve coach-page routes and the upload parser are absent while flag-off", async () => {
  const { server, port } = await startServer();
  const id = "33333333-3333-4333-8333-333333333333";
  const routes = [
    ["GET", "/coach-page", null, {}], ["PATCH", "/coach-page", "{}", { "content-type": "application/json" }],
    ["POST", "/coach-page/locations", "{}", { "content-type": "application/json" }], ["PATCH", `/coach-page/locations/${id}`, "{}", { "content-type": "application/json" }],
    ["DELETE", `/coach-page/locations/${id}`, null, {}], ["POST", "/coach-page/gallery", Buffer.from("GIF89a"), { "content-type": "image/gif" }],
    ["PATCH", `/coach-page/gallery/${id}`, "{}", { "content-type": "application/json" }], ["DELETE", `/coach-page/gallery/${id}`, null, {}],
    ["POST", "/coach-page/socials", "{}", { "content-type": "application/json" }], ["PATCH", `/coach-page/socials/${id}`, "{}", { "content-type": "application/json" }],
    ["DELETE", `/coach-page/socials/${id}`, null, {}], ["PUT", "/coach-page/sections", "{}", { "content-type": "application/json" }],
  ];
  try {
    for (const [method, url, body, headers] of routes) {
      const out = await request(port, method, url, body, headers);
      assert.equal(out.status, 404, `${method} ${url}`); assert.match(out.body.toString(), /Cannot (GET|POST|PATCH|DELETE|PUT)/); assert.doesNotMatch(out.body.toString(), /"error"|unsupported_media_type|too_many_requests/);
    }
    const oversized = Buffer.alloc(9 * 1024 * 1024, 0x41);
    const feature = await request(port, "POST", "/coach-page/gallery", oversized, { "content-type": "image/png" });
    const baseline = await request(port, "POST", "/definitely-absent", oversized, { "content-type": "image/png" });
    assert.deepEqual({ status: feature.status, contentType: feature.contentType }, { status: baseline.status, contentType: baseline.contentType });
    assert.match(feature.body.toString(), /Cannot POST \/coach-page\/gallery/); assert.doesNotMatch(feature.body.toString(), /413|415|unsupported_media_type/);
  } finally { server.close(); }
});

test("flag-off storefront HTML bytes, data DTO, and query set remain baseline", async () => {
  const realFetch = global.fetch, calls = [];
  const coachId = "33333333-3333-4333-8333-333333333333", slug = "baseline-coach";
  const coach = { id: coachId, slug, full_name: "Baseline Coach", business: "Baseline Training", disciplines: ["Speed"], bio: "Baseline bio", city: "Tampa" };
  const type = { id: "44444444-4444-4444-8444-444444444444", name: "Private", duration_min: 60, price_cents: 5000, description: "One on one" };
  global.fetch = async (url) => {
    const value = String(url); calls.push(value);
    let rows = [];
    if (value.includes("/coaches?")) rows = [coach];
    else if (value.includes("/session_types?")) rows = [type];
    return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) };
  };
  const { server, port } = await startServer();
  try {
    const page = await request(port, "GET", `/coach/${slug}`);
    assert.equal(page.status, 200); assert.deepEqual(page.body, fs.readFileSync(path.join(__dirname, "..", "public", "coach.html")));
    const data = await request(port, "GET", `/coach/${slug}/data`); assert.equal(data.status, 200);
    const dto = JSON.parse(data.body.toString());
    assert.deepEqual(dto.coach, { name: coach.full_name, business: coach.business, disciplines: coach.disciplines, bio: coach.bio, city: coach.city });
    assert.deepEqual(dto.session_types, [type]); assert.deepEqual(dto.open_slots, []);
    assert.equal(calls.filter((url) => url.includes("coach_locations") || url.includes("coach_photos") || url.includes("coach_socials") || url.includes("coach_page_sections")).length, 0);
    assert.ok(calls.every((url) => !url.includes("metadata") && !url.includes("guardian_consent")));
  } finally { global.fetch = realFetch; server.close(); }
});
