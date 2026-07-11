// D1 account-deletion endpoint tests (POST /account/delete). The token-server
// data layer: role-split cascade, dependency-safe order, caller-only scope,
// idempotent retry. No network, no live creds; each test FILE runs in its own
// process under `node --test`, so this env is isolated.
//
// Env is set BEFORE requiring index.js so the module boots in test mode
// (require.main !== module skips app.listen). /account/delete is NOT flag-gated,
// so it registers unconditionally.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
process.env.ROOM_TICKET_SECRET = "test-ticket-secret";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.RESEND_API_KEY;

const { app } = require("../index.js");

const CALLER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // the authenticated caller
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // a DIFFERENT user id

// ---- tiny in-process HTTP harness (same shape as scheduling-endpoints) ------
function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body);
    const h = { ...headers };
    if (payload && !h["content-type"] && !h["Content-Type"]) {
      h["content-type"] = "application/json";
    }
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: h },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            json: (() => {
              try {
                return JSON.parse(data);
              } catch {
                return null;
              }
            })(),
            text: data,
          }),
        );
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Routes Supabase REST/storage/auth calls by URL + method; records every call so
// tests can assert order + scope. `verify` is the /auth/v1/user reply (the caller
// identity). `fail` optionally makes one matching (urlSubstr, method) return 500.
function installFetchMock({ verify, fail } = {}) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ u, method, body: opts.body ? safeParse(opts.body) : null });

    // JWT verification (requireSupabaseUser hits /auth/v1/user).
    if (u.includes("/auth/v1/user")) {
      return ok(verify || { id: CALLER });
    }
    // Injected failure on a specific table+method (cascade-abort test).
    if (fail && u.includes(fail.urlSubstr) && method === (fail.method || "DELETE")) {
      return { ok: false, status: 500, json: async () => ({}), text: async () => "boom" };
    }
    // Everything else (row deletes/patches, storage list/remove, admin delete,
    // select sweeps) succeeds with an empty array / ok.
    return ok([]);
  };
  return {
    calls,
    restore() {
      global.fetch = realFetch;
    },
  };
}

function safeParse(b) {
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
}
function ok(json) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

// Index of the FIRST recorded call matching a url substring + method.
function idxOf(calls, urlSubstr, method) {
  return calls.findIndex((c) => c.u.includes(urlSubstr) && c.method === method);
}

// ===========================================================================
// 1. ATHLETE deletion: unlink the coach-owned card, drop only the caller's own
//    notify rows, delete the auth user for the CALLER id only.
// ===========================================================================

test("athlete delete unlinks the card, drops caller-only rows, deletes the caller auth user", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock({
    verify: { id: CALLER, user_metadata: { role: "athlete" } },
  });
  try {
    const res = await request(port, {
      method: "POST",
      path: "/account/delete",
      headers: { authorization: "Bearer athlete-jwt" },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.deleted, true);
    assert.strictEqual(res.json.role, "athlete");

    // The card is UNLINKED (user_id -> null), scoped to the caller, never deleted.
    const cardPatch = mock.calls.find(
      (c) => c.u.includes("/athletes") && c.method === "PATCH",
    );
    assert.ok(cardPatch, "athletes.user_id was PATCHed");
    assert.ok(cardPatch.u.includes(`user_id=eq.${CALLER}`), "scoped to the caller's card");
    assert.strictEqual(cardPatch.body.user_id, null, "the identity link is nulled");
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/athletes") && c.method === "DELETE"),
      "an athlete NEVER deletes the coach-owned card",
    );

    // Only the caller's OWN notify rows are deleted, each scoped to user_id=caller.
    for (const table of ["push_tokens", "notifications"]) {
      const del = mock.calls.find(
        (c) => c.u.includes(`/${table}`) && c.method === "DELETE",
      );
      assert.ok(del, `${table} was deleted`);
      assert.ok(del.u.includes(`user_id=eq.${CALLER}`), `${table} scoped to the caller`);
    }

    // No coach-owned business data is ever touched on the athlete path.
    assert.ok(
      !mock.calls.some((c) => c.method === "DELETE" && c.u.includes("coach_id=eq.")),
      "no coach_id-scoped delete fires for an athlete caller",
    );

    // The auth user deleted is the CALLER, and it is the LAST call.
    const adminDel = mock.calls.find(
      (c) => c.u.includes("/auth/v1/admin/users/") && c.method === "DELETE",
    );
    assert.ok(adminDel, "the caller's auth user was deleted");
    assert.ok(adminDel.u.endsWith(`/auth/v1/admin/users/${CALLER}`), "deletes the CALLER id");
    assert.strictEqual(
      mock.calls[mock.calls.length - 1],
      adminDel,
      "the auth-user delete is the last thing that happens",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 2. COACH deletion: correct dependency order (ledger BEFORE purchases), the
//    auth-user delete happens LAST.
// ===========================================================================

test("coach delete purges in dependency order (credit ledger before purchases) then the auth user LAST", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock({
    verify: { id: CALLER, user_metadata: { role: "coach" } },
  });
  try {
    const res = await request(port, {
      method: "POST",
      path: "/account/delete",
      headers: { authorization: "Bearer coach-jwt" },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.deleted, true);
    assert.strictEqual(res.json.role, "coach");

    const ledgerIdx = idxOf(mock.calls, "/credit_deductions?coach_id=eq.", "DELETE");
    const purchasesIdx = idxOf(mock.calls, "/package_purchases?coach_id=eq.", "DELETE");
    const coachesIdx = idxOf(mock.calls, "/coaches?id=eq.", "DELETE");
    const adminIdx = idxOf(mock.calls, "/auth/v1/admin/users/", "DELETE");

    assert.ok(ledgerIdx >= 0, "credit_deductions was deleted");
    assert.ok(purchasesIdx >= 0, "package_purchases was deleted");
    assert.ok(
      ledgerIdx < purchasesIdx,
      "the credit ledger is deleted BEFORE package_purchases (ON DELETE RESTRICT)",
    );
    assert.ok(coachesIdx > purchasesIdx, "the coach row is deleted after its data");
    assert.ok(adminIdx > coachesIdx, "the auth user is deleted after the coach row");
    assert.strictEqual(adminIdx, mock.calls.length - 1, "the auth-user delete is the LAST call");
    assert.ok(
      mock.calls[adminIdx].u.endsWith(`/auth/v1/admin/users/${CALLER}`),
      "deletes the CALLER's auth user",
    );

    // Every coach_id-scoped delete targets the CALLER, never another tenant.
    for (const c of mock.calls) {
      if (c.method === "DELETE" && c.u.includes("coach_id=eq.")) {
        assert.ok(c.u.includes(`coach_id=eq.${CALLER}`), `delete scoped to caller: ${c.u}`);
      }
    }
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 3. COACH cascade abort: a mid-cascade row-delete 500 returns 500 and the auth
//    user is NEVER deleted.
// ===========================================================================

test("coach delete aborts with 500 on a cascade failure and never deletes the auth user", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock({
    verify: { id: CALLER, user_metadata: { role: "coach" } },
    fail: { urlSubstr: "/package_purchases", method: "DELETE" },
  });
  try {
    const res = await request(port, {
      method: "POST",
      path: "/account/delete",
      headers: { authorization: "Bearer coach-jwt" },
    });
    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.json.deleted, false);
    assert.ok(res.json.failed.includes("package_purchases"), "reports what failed");

    // The auth user was NOT deleted — the coach can retry.
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/auth/v1/admin/users/") && c.method === "DELETE"),
      "the auth user is never deleted when a cascade step fails",
    );
    // The coach row is not deleted either (we abort before it).
    assert.ok(
      !mock.calls.some((c) => c.u.includes("/coaches?id=eq.") && c.method === "DELETE"),
      "the coach row is not deleted after an abort",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 4. Retry idempotency: a run after a partial failure completes, deleting the
//    auth user. (Deletes are filtered, so already-gone rows no-op on re-run.)
// ===========================================================================

test("a re-run after a partial failure completes and deletes the auth user", async () => {
  const { server, port } = await startServer();

  // Run 1: fails mid-cascade -> 500, no auth delete.
  const mock1 = installFetchMock({
    verify: { id: CALLER, user_metadata: { role: "coach" } },
    fail: { urlSubstr: "/package_purchases", method: "DELETE" },
  });
  try {
    const first = await request(port, {
      method: "POST",
      path: "/account/delete",
      headers: { authorization: "Bearer coach-jwt" },
    });
    assert.strictEqual(first.status, 500);
    assert.ok(
      !mock1.calls.some((c) => c.u.includes("/auth/v1/admin/users/")),
      "run 1 leaves the auth user intact",
    );
  } finally {
    mock1.restore();
  }

  // Run 2: everything succeeds (already-gone rows no-op) -> 200 + auth delete.
  const mock2 = installFetchMock({
    verify: { id: CALLER, user_metadata: { role: "coach" } },
  });
  try {
    const second = await request(port, {
      method: "POST",
      path: "/account/delete",
      headers: { authorization: "Bearer coach-jwt" },
    });
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.json.deleted, true);
    assert.ok(
      mock2.calls.some(
        (c) => c.u.endsWith(`/auth/v1/admin/users/${CALLER}`) && c.method === "DELETE",
      ),
      "run 2 finishes the delete",
    );
  } finally {
    mock2.restore();
    server.close();
  }
});

// ===========================================================================
// 5. The caller can NEVER name another user id. A body naming OTHER is ignored:
//    the delete targets the CALLER only, and OTHER is never touched.
// ===========================================================================

test("a user id in the request body is ignored — only the caller is ever deleted", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock({
    verify: { id: CALLER, user_metadata: { role: "athlete" } },
  });
  try {
    const res = await request(port, {
      method: "POST",
      path: "/account/delete",
      headers: { authorization: "Bearer athlete-jwt" },
      // Hostile body naming a DIFFERENT user in every plausible field.
      body: JSON.stringify({ userId: OTHER, id: OTHER, uid: OTHER, user_id: OTHER }),
    });
    assert.strictEqual(res.status, 200);

    // The auth user deleted is the CALLER, not OTHER.
    const adminDel = mock.calls.find(
      (c) => c.u.includes("/auth/v1/admin/users/") && c.method === "DELETE",
    );
    assert.ok(adminDel.u.endsWith(`/auth/v1/admin/users/${CALLER}`), "deletes the caller");

    // OTHER's id appears in NO outgoing call, anywhere.
    assert.ok(
      !mock.calls.some((c) => c.u.includes(OTHER)),
      "the body-supplied id is never used in any Supabase call",
    );
  } finally {
    mock.restore();
    server.close();
  }
});

// ===========================================================================
// 6. Unauthenticated -> 401, nothing touched.
// ===========================================================================

test("no JWT -> 401 and no delete of any kind fires", async () => {
  const { server, port } = await startServer();
  const mock = installFetchMock({ verify: { id: CALLER } });
  try {
    const res = await request(port, { method: "POST", path: "/account/delete" });
    assert.strictEqual(res.status, 401);
    assert.ok(
      !mock.calls.some((c) => c.method === "DELETE"),
      "an unauthenticated caller triggers no deletes",
    );
  } finally {
    mock.restore();
    server.close();
  }
});
