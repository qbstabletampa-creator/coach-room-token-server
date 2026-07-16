// Fresh-process flag-dark proof. Each child loads index.js once with a distinct
// flag combination, uses an ephemeral loopback listener, and closes it before
// returning results to this test process.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const child = String.raw`
const http = require("node:http");
const { app } = require("./index.js");
const routes = [
  ["GET", "/calendar/connection"],
  ["POST", "/calendar/feed/reset", "{}"],
  ["DELETE", "/calendar/feed"],
  ["POST", "/calendar/google/connect", "{}"],
  ["GET", "/calendar/google/callback?code=x&state=y"],
  ["DELETE", "/calendar/google"],
  ["GET", "/calendar/11111111-1111-4111-8111-111111111111/feed.ics?token=cal_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  ["GET", "/cron/calendar-sync"],
  ["GET", "/health"],
];
function request(port, route) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, method: route[0], path: route[1],
      headers: route[2] ? { "content-type": "application/json", "content-length": Buffer.byteLength(route[2]) } : {} },
    (response) => { let text = ""; response.on("data", (part) => text += part);
      response.on("end", () => resolve({ status: response.statusCode, type: response.headers["content-type"], text })); });
    request.on("error", reject); if (route[2]) request.write(route[2]); request.end();
  });
}
const server = app.listen(0, "127.0.0.1", async () => {
  try {
    const results = [];
    for (const route of routes) results.push(await request(server.address().port, route));
    process.stdout.write(JSON.stringify(results));
  } finally { server.close(); }
});
`;

function runFlags(scheduling, calendar) {
  const env = { ...process.env,
    LIVEKIT_URL: "wss://test.livekit.cloud", LIVEKIT_API_KEY: "test-key",
    LIVEKIT_API_SECRET: "test-secret", PORT: "0" };
  if (scheduling) env.SCHEDULING_ENABLED = "1"; else delete env.SCHEDULING_ENABLED;
  if (calendar) env.CALENDAR_SYNC_ENABLED = "1"; else delete env.CALENDAR_SYNC_ENABLED;
  const result = spawnSync(process.execPath, ["-e", child], {
    cwd: require("node:path").resolve(__dirname, ".."), env, encoding: "utf8", timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const [name, scheduling, calendar] of [
  ["calendar flag absent", true, false],
  ["scheduling flag absent", false, true],
  ["both flags absent", false, false],
]) {
  test(`all calendar route shapes are ordinary Express 404 when ${name}`, () => {
    const results = runFlags(scheduling, calendar);
    for (const route of results.slice(0, 8)) {
      assert.equal(route.status, 404);
      assert.match(route.type, /^text\/html/);
      assert.match(route.text, /Cannot (GET|POST|DELETE) \/calendar|Cannot GET \/cron\/calendar-sync/);
      assert.doesNotMatch(route.text, /invalid_request|not_configured|unauthorized|VCALENDAR|Google Calendar connected/);
    }
    assert.deepEqual(results[8], {
      status: 200, type: "application/json; charset=utf-8", text: '{"ok":true}',
    });
  });
}
