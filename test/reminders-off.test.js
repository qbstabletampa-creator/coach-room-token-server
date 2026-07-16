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
  const shapes=[["GET","/reminders/rules"],["POST","/reminders/rules","{\"title\":\"x\"}"],["PATCH","/reminders/rules/11111111-1111-4111-8111-111111111111","{}"],["DELETE","/reminders/rules/11111111-1111-4111-8111-111111111111"],["GET","/reminders/settings"],["PATCH","/reminders/settings","{\"timezone\":\"UTC\"}"]];
  const editor=[]; for (const [m,p,b] of shapes) editor.push(await hit(port,m,p,b));
  const cron=await hit(port,"GET","/cron/reminders"); const health=await hit(port,"GET","/health");
  server.close(); console.log(JSON.stringify({editor,cron,health}));
})().catch(e => { console.error(e); process.exit(1); });`;

function run(flags = {}) {
  const env = { ...process.env, LIVEKIT_URL:"wss://test.livekit.cloud", LIVEKIT_API_KEY:"test-key", LIVEKIT_API_SECRET:"test-secret", ...flags };
  delete env.REMINDERS_EDITOR_ENABLED;
  if (!Object.prototype.hasOwnProperty.call(flags, "SCHEDULING_ENABLED")) delete env.SCHEDULING_ENABLED;
  const out = spawnSync(process.execPath, ["-e", child], { cwd:path.join(__dirname,".."), env, encoding:"utf8" });
  assert.equal(out.status, 0, out.stderr); return JSON.parse(out.stdout.trim().split(/\r?\n/).at(-1));
}

function assertEditorAbsent(result) {
  assert.equal(result.editor.length, 6);
  for (const response of result.editor) {
    assert.equal(response.status, 404);
    assert.match(response.type, /^text\/html/);
  }
  assert.deepEqual(JSON.parse(result.health.text), { ok:true });
}

test("both flags absent leave all editor shapes and cron as ordinary Express 404s", () => {
  const result=run(); assertEditorAbsent(result); assert.equal(result.cron.status,404); assert.match(result.cron.type,/^text\/html/);
});

test("scheduling ON keeps the legacy cron while the editor remains absent", () => {
  const result=run({SCHEDULING_ENABLED:"1"}); assertEditorAbsent(result); assert.equal(result.cron.status,401); assert.deepEqual(JSON.parse(result.cron.text),{error:"unauthorized"});
});

test("reminders add no route-scoped parser and retain the global parser posture", () => {
  const source=fs.readFileSync(path.join(__dirname,"..","index.js"),"utf8");
  assert.doesNotMatch(source,/app\.use\(\s*["']\/reminders[^\n]*express\.json/);
  assert.match(source,/app\.use\(express\.json\(\)\)/);
});
