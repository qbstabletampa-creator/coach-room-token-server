const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const TOKEN = "11111111-1111-4111-8111-111111111111";
const OFF_ROUTE_HASH = "037ae17512d31bb9833ff22a26b4d56106d7e024cbeedd53a1e0685b36ae3264";

function routeList(app) {
  const routes = [];
  for (const layer of app._router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods).filter((key) => layer.route.methods[key]).sort()) {
      routes.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return routes;
}

function get(server, pathname) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const request = http.get({ host: "127.0.0.1", port: address.port, path: pathname }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        contentType: response.headers["content-type"] || null,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
  });
}

async function probe() {
  const Module = require("node:module");
  const originalLoad = Module._load;
  const capture = {
    waitlistBuilds: 0,
    formsBuilds: 0,
    schedulingBuilds: 0,
    protectionBuilds: 0,
    remindersBuilds: 0,
    schedulingDeps: null,
    protectionDeps: null,
    reminderDeps: null,
    waitlistPrimitiveCalls: [],
    formsPrimitiveCalls: [],
    formsInstance: null,
    waitlistInstance: null,
  };

  Module._load = function instrument(request, parent, isMain) {
    const loaded = originalLoad.call(this, request, parent, isMain);
    const fromIndex = parent && path.basename(parent.filename || "") === "index.js";
    if (!fromIndex) return loaded;
    if (request === "./lib/waitlist") {
      return {
        ...loaded,
        buildWaitlistHandlers(deps) {
          capture.waitlistBuilds++;
          const handlers = loaded.buildWaitlistHandlers(deps);
          const wrapped = {
            ...handlers,
            tryFillFromWaitlist: async (args) => {
              capture.waitlistPrimitiveCalls.push(args);
              return { fill_round: 1, mode: "first_in_line", matched: 0, offered: 0, disposition: "no_match" };
            },
            expireWaitlistOffers: async () => ({ examined: 0, expired: 0, rolled: 0 }),
          };
          capture.waitlistInstance = wrapped;
          return wrapped;
        },
      };
    }
    if (request === "./lib/forms") {
      return {
        ...loaded,
        buildFormsHandlers(deps) {
          capture.formsBuilds++;
          const handlers = loaded.buildFormsHandlers(deps);
          const wrapped = {
            ...handlers,
            assertRequiredFormsSigned: async (args) => {
              capture.formsPrimitiveCalls.push({ primitive: "required", args });
              return { allowed: true };
            },
            notifyPendingWaiver: async (args) => {
              capture.formsPrimitiveCalls.push({ primitive: "pending", args });
              return { pending: 0, notified: false };
            },
          };
          capture.formsInstance = wrapped;
          return wrapped;
        },
      };
    }
    if (request === "./lib/scheduling") {
      return {
        ...loaded,
        buildSchedulingHandlers(deps) {
          capture.schedulingBuilds++;
          capture.schedulingDeps = deps;
          return loaded.buildSchedulingHandlers(deps);
        },
      };
    }
    if (request === "./lib/protection") {
      return {
        ...loaded,
        buildProtectionHandlers(deps) {
          capture.protectionBuilds++;
          capture.protectionDeps = deps;
          return loaded.buildProtectionHandlers(deps);
        },
      };
    }
    if (request === "./lib/reminders") {
      return {
        ...loaded,
        buildRemindersHandler(deps) {
          capture.remindersBuilds++;
          capture.reminderDeps = deps;
          return loaded.buildRemindersHandler(deps);
        },
      };
    }
    return loaded;
  };

  const { app } = require("../index");
  Module._load = originalLoad;
  const routes = routeList(app);
  const schedulingDeps = capture.schedulingDeps || {};
  const protectionDeps = capture.protectionDeps || {};
  const reminderDeps = capture.reminderDeps || {};

  if (typeof schedulingDeps.formsPendingWaiver === "function") {
    await schedulingDeps.formsPendingWaiver({
      coachId: TOKEN,
      athleteId: TOKEN,
      slot: { id: TOKEN, coach_id: TOKEN, status: "booked", session_type_id: TOKEN, starts_at: "x" },
    });
  }
  if (typeof schedulingDeps.waitlistFill === "function") {
    await schedulingDeps.waitlistFill({
      coachId: TOKEN,
      slot: { id: TOKEN, coach_id: TOKEN, status: "open", session_type_id: TOKEN, starts_at: "x" },
    });
  }

  let httpProof = null;
  const allOff = !process.env.SCHEDULING_ENABLED && !process.env.WAITLIST_ENABLED && !process.env.FORMS_ENABLED;
  const schedulingOnly = process.env.SCHEDULING_ENABLED === "1" && !process.env.WAITLIST_ENABLED && !process.env.FORMS_ENABLED;
  if (allOff || schedulingOnly) {
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      httpProof = allOff
        ? {
            book: await get(server, `/book/${TOKEN}`),
            waitlist: await get(server, `/schedule/${TOKEN}/waitlist`),
            forms: await get(server, `/forms/invite/${TOKEN}`),
          }
        : { book: await get(server, `/book/${TOKEN}`) };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  const result = {
    counts: {
      waitlist: capture.waitlistBuilds,
      forms: capture.formsBuilds,
      scheduling: capture.schedulingBuilds,
      protection: capture.protectionBuilds,
      reminders: capture.remindersBuilds,
    },
    routes,
    routeHash: crypto.createHash("sha256").update(JSON.stringify(routes)).digest("hex"),
    hooks: {
      formsRequired: typeof schedulingDeps.formsRequiredPrecheck === "function",
      formsRequiredShared: Boolean(capture.formsInstance && schedulingDeps.formsRequiredPrecheck === capture.formsInstance.assertRequiredFormsSigned),
      formsPending: typeof schedulingDeps.formsPendingWaiver === "function",
      waitlistFill: typeof schedulingDeps.waitlistFill === "function",
      noShowFill: typeof protectionDeps.waitlistFill === "function",
      noShowFillShared: Boolean(protectionDeps.waitlistFill && protectionDeps.waitlistFill === schedulingDeps.waitlistFill),
      expiry: typeof reminderDeps.waitlistExpire === "function",
      expiryShared: Boolean(capture.waitlistInstance && reminderDeps.waitlistExpire === capture.waitlistInstance.expireWaitlistOffers),
    },
    projections: {
      forms: capture.formsPrimitiveCalls,
      waitlist: capture.waitlistPrimitiveCalls,
    },
    httpProof,
  };
  process.stdout.write(`INTEGRATOR_PROBE:${JSON.stringify(result)}\n`);
}

if (process.env.INTEGRATOR_PROBE === "1") {
  probe().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
} else {
  const test = require("node:test");

  function runProbe({ scheduling, waitlist, forms, protection = 0 }) {
    const env = { ...process.env };
    for (const key of ["SCHEDULING_ENABLED", "WAITLIST_ENABLED", "FORMS_ENABLED", "PROTECTION_ENABLED", "REMINDERS_EDITOR_ENABLED"]) delete env[key];
    if (scheduling) env.SCHEDULING_ENABLED = "1";
    if (waitlist) env.WAITLIST_ENABLED = "1";
    if (forms) env.FORMS_ENABLED = "1";
    if (protection) env.PROTECTION_ENABLED = "1";
    Object.assign(env, {
      INTEGRATOR_PROBE: "1",
      LIVEKIT_URL: "wss://test.invalid",
      LIVEKIT_API_KEY: "test-key",
      LIVEKIT_API_SECRET: "test-secret",
    });
    delete env.SUPABASE_URL;
    delete env.SUPABASE_SERVICE_KEY;
    const child = spawnSync(process.execPath, [__filename], { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const line = child.stdout.split(/\r?\n/).find((value) => value.startsWith("INTEGRATOR_PROBE:"));
    assert.ok(line, `probe output missing: ${child.stdout}`);
    return JSON.parse(line.slice("INTEGRATOR_PROBE:".length));
  }

  test("fresh-process S/W/F matrix constructs one shared factory and only decreed hooks", () => {
    const rows = [
      [0, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 1, 1, 0],
      [1, 0, 0, 0], [1, 1, 0, 0], [1, 1, 0, 1], [1, 0, 1, 0], [1, 1, 1, 0], [1, 1, 1, 1],
    ];
    const failures = [];
    for (const [s, w, f, p] of rows) {
      const probeResult = runProbe({ scheduling: s, waitlist: w, forms: f, protection: p });
      const expectedWaitlist = s && w ? 1 : 0;
      const expectedForms = f ? 1 : 0;
      const expected = {
        waitlist: expectedWaitlist,
        forms: expectedForms,
        formsRequired: Boolean(s && f),
        formsPending: Boolean(s && f),
        waitlistFill: Boolean(s && w),
        noShowFill: Boolean(p && s && w),
        expiry: Boolean(s && w),
      };
      const actual = {
        waitlist: probeResult.counts.waitlist,
        forms: probeResult.counts.forms,
        formsRequired: probeResult.hooks.formsRequired,
        formsPending: probeResult.hooks.formsPending,
        waitlistFill: probeResult.hooks.waitlistFill,
        noShowFill: probeResult.hooks.noShowFill,
        expiry: probeResult.hooks.expiry,
      };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push({ row: { s, w, f, p }, expected, actual });
      if (s && f) {
        if (!probeResult.hooks.formsRequiredShared) failures.push({ row: { s, w, f, p }, error: "forms precheck is not from the shared factory" });
        const pending = probeResult.projections.forms.find((call) => call.primitive === "pending");
        if (!pending || JSON.stringify(pending.args.slot) !== JSON.stringify({ id: TOKEN })) failures.push({ row: { s, w, f, p }, error: "forms adapter did not project slot to {id}", pending });
      }
      if (s && w) {
        if (!probeResult.hooks.expiryShared) failures.push({ row: { s, w, f, p }, error: "expiry is not from the shared waitlist factory" });
        const fill = probeResult.projections.waitlist[0];
        if (!fill || JSON.stringify(fill.slot) !== JSON.stringify({ id: TOKEN })) failures.push({ row: { s, w, f, p }, error: "waitlist adapter did not project slot to {id}", fill });
      }
      if (p && s && w && !probeResult.hooks.noShowFillShared) failures.push({ row: { s, w, f, p }, error: "no-show and scheduling do not share the fill adapter" });

      assert.equal(probeResult.routes.includes("POST /schedule/:inviteToken/book"), Boolean(s));
      assert.equal(probeResult.routes.includes("GET /schedule/:inviteToken/waitlist"), Boolean(s && w));
      assert.equal(probeResult.routes.includes("GET /forms/invite/:token"), Boolean(f));
      assert.equal(probeResult.routes.includes("POST /coach/bookings/no-show"), Boolean(p));
      assert.equal(probeResult.routes.includes("GET /cron/reminders"), Boolean(s));
    }
    assert.deepEqual(failures, []);
  });

  test("all-off route stack and feature 404 bodies remain byte-identical", () => {
    const result = runProbe({ scheduling: 0, waitlist: 0, forms: 0 });
    assert.equal(result.routeHash, OFF_ROUTE_HASH);
    assert.deepEqual(result.counts.waitlist, 0);
    assert.deepEqual(result.counts.forms, 0);
    assert.equal(result.counts.reminders, 0);
    for (const response of Object.values(result.httpProof)) {
      assert.equal(response.status, 404);
      assert.match(response.contentType, /^text\/html/);
      assert.match(response.body, /^<!DOCTYPE html>/);
      assert.doesNotMatch(response.body, /^\s*\{/);
    }
  });

  test("scheduling-on with both lane flags off serves the exact existing book bytes", () => {
    const result = runProbe({ scheduling: 1, waitlist: 0, forms: 0 });
    const expected = fs.readFileSync(path.join(ROOT, "public", "book.html"), "utf8");
    assert.equal(result.httpProof.book.status, 200);
    assert.equal(result.httpProof.book.body, expected);
    assert.deepEqual(result.counts.waitlist, 0);
    assert.deepEqual(result.counts.forms, 0);
    assert.deepEqual(result.hooks, {
      formsRequired: false,
      formsRequiredShared: false,
      formsPending: false,
      waitlistFill: false,
      noShowFill: false,
      noShowFillShared: false,
      expiry: false,
      expiryShared: false,
    });
  });

  test("forbidden server factories and public template remain byte-identical to the current-master snapshot", () => {
    const expectedHashes = {
      "lib/waitlist.js": "f5bf6ead436d8e060bb76accc4f0f6e52de2c68cce4c3ae0010c104774254a12",
      "lib/forms.js": "ed6f4b552a0ed6c122d3cea1e67e4602dcf0204dbc83921837d5765bfa17e150",
      // 2026-07-21 refund-guard: deliberately re-pinned after fixing
      // handleProtectionChargeRefunded to only scope by coach_id when the charge
      // carries it. A package-purchase charge has no coach_id metadata, so the old
      // `coach_id=eq.` empty-string filter hit a uuid column -> Postgres 22P02 ->
      // handler threw -> refund webhook 500-looped. This hash pins the fixed file.
      "lib/protection.js": "8301110efe25154c62d693982f43ee250aa91fe9450caa0a3a80ffa7715ae2ce",
      "public/book.html": "93e49c3b5dcd10dd4ff5edc593c4f6bf610dbbdd3039b4ed5e28f8af1eadeb01",
    };
    const files = Object.keys(expectedHashes);
    const diff = execFileSync("git", ["diff", "--no-ext-diff", "--", ...files], { cwd: ROOT, encoding: "utf8" });
    assert.equal(diff, "");
    for (const file of files) {
      const disk = fs.readFileSync(path.join(ROOT, file));
      const hash = crypto.createHash("sha256").update(disk).digest("hex");
      assert.equal(hash, expectedHashes[file], `${file} changed outside the W1 lane`);
    }
  });
}
