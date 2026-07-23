// User-config editor OFF test (USER_CONFIG_ENABLED unset). Proves the Lane A
// coach-JWT config routes are completely absent (ordinary Express 404s, not
// authed 401s) when the flag is unset, the module adds no route-scoped body
// parser, and buildUserConfigHandlers is inert (constructs without env/auth/
// fetch). Its own file because index.js reads the flag once at module load and
// node --test runs each file in a fresh process, so the flag here is genuinely OFF.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const child = String.raw`
const http = require("node:http");
const { app } = require("./index.js");
function hit(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname:"127.0.0.1", port, method, path:pathname,
      headers: body ? {"content-type":"application/json", "content-length":Buffer.byteLength(body)} : {} }, (res) => {
      let text=""; res.on("data", c => text += c); res.on("end", () => resolve({status:res.statusCode,type:res.headers["content-type"]||"",text}));
    });
    req.on("error", reject); if (body) req.write(body); req.end();
  });
}
(async () => {
  const server = app.listen(0,"127.0.0.1"); await new Promise(r => server.once("listening",r));
  const port=server.address().port;
  const shapes=[["GET","/config"],["GET","/config/labels"],["PUT","/config/labels/tab.you","{\"value\":{\"text\":\"You\"}}"],["DELETE","/config/labels/tab.you"]];
  const editor=[]; for (const [m,p,b] of shapes) editor.push(await hit(port,m,p,b));
  const health=await hit(port,"GET","/health");
  server.close(); console.log(JSON.stringify({editor,health}));
})().catch(e => { console.error(e); process.exit(1); });`;

function run(flags = {}) {
  const env = { ...process.env, LIVEKIT_URL:"wss://test.livekit.cloud", LIVEKIT_API_KEY:"test-key", LIVEKIT_API_SECRET:"test-secret", ...flags };
  delete env.USER_CONFIG_ENABLED;
  const out = spawnSync(process.execPath, ["-e", child], { cwd:path.join(__dirname,".."), env, encoding:"utf8" });
  assert.equal(out.status, 0, out.stderr); return JSON.parse(out.stdout.trim().split(/\r?\n/).at(-1));
}

test("USER_CONFIG_ENABLED unset leaves every config route an ordinary Express 404", () => {
  const result = run();
  assert.equal(result.editor.length, 4);
  for (const response of result.editor) {
    assert.equal(response.status, 404);
    assert.match(response.type, /^text\/html/);
  }
  assert.deepEqual(JSON.parse(result.health.text), { ok:true });
});

test("the config editor adds no route-scoped parser and keeps the global parser posture", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.doesNotMatch(source, /app\.use\(\s*["']\/config[^\n]*express\.json/);
  assert.match(source, /app\.use\(express\.json\(\)\)/);
});

test("buildUserConfigHandlers is inert: it constructs its handler set without env, auth, or fetch", () => {
  const { buildUserConfigHandlers } = require("../lib/user-config");
  const realFetch = global.fetch;
  global.fetch = () => { throw new Error("no network at construction time"); };
  try {
    assert.deepEqual(Object.keys(buildUserConfigHandlers({})), ["getConfig", "getNamespace", "putKey", "deleteKey"]);
  } finally { global.fetch = realFetch; }
});
