// Phase 0 clip-security unit tests. No network, no live creds.
// Run: node --test  (uses Node's built-in test runner; no new dependency).
//
// We set fake env BEFORE requiring index.js so the module boots in test mode
// (require.main !== module skips app.listen) and exports the pure helpers.

const test = require("node:test");
const assert = require("node:assert");

process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
process.env.ROOM_TICKET_SECRET = "test-ticket-secret";
process.env.CLIPS_BUCKET = "clips-private";

const {
  app,
  sniffVideoMagic,
  mintRoomTicket,
  verifyRoomTicket,
  signClipUrl,
  resolveClipObjectPath,
} = require("../index.js");

const http = require("node:http");

// ---- tiny in-process HTTP harness ------------------------------------------
// We drive the real Express app over an ephemeral port. No live creds: every
// outbound Supabase call is intercepted by swapping global.fetch per test.
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

// ---- magic-byte validation (Criterion 3) -----------------------------------

test("sniffVideoMagic accepts a WebM/EBML header", () => {
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.strictEqual(sniffVideoMagic(webm), "webm");
});

test("sniffVideoMagic accepts an MP4 ftyp box", () => {
  // size(4) + "ftyp" + brand
  const mp4 = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
  ]);
  assert.strictEqual(sniffVideoMagic(mp4), "mp4");
});

test("sniffVideoMagic REJECTS a text/script payload", () => {
  const txt = Buffer.from("<script>alert(1)</script>console.log('x')");
  assert.strictEqual(sniffVideoMagic(txt), null);
});

test("sniffVideoMagic rejects a too-short buffer", () => {
  assert.strictEqual(sniffVideoMagic(Buffer.from([0x1a, 0x45])), null);
  assert.strictEqual(sniffVideoMagic(null), null);
});

test("sniffVideoMagic rejects a webm header that is one byte off", () => {
  const almost = Buffer.from([0x1a, 0x45, 0xdf, 0xa4, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.strictEqual(almost && sniffVideoMagic(almost), null);
});

// ---- room ticket (the clips browser-athlete auth path, Criterion 1) --------

test("a freshly minted ticket verifies for its own room", () => {
  const t = mintRoomTicket("room-abc");
  assert.ok(t, "ticket minted");
  assert.strictEqual(verifyRoomTicket(t, "room-abc"), "room-abc");
});

test("a ticket is REJECTED for a different room (room-scoped)", () => {
  const t = mintRoomTicket("room-abc");
  assert.strictEqual(verifyRoomTicket(t, "room-xyz"), null);
});

test("a forged/garbage ticket is rejected", () => {
  assert.strictEqual(verifyRoomTicket("not.a.ticket", "room-abc"), null);
  assert.strictEqual(verifyRoomTicket("", "room-abc"), null);
  assert.strictEqual(verifyRoomTicket(undefined, "room-abc"), null);
});

test("a tampered signature is rejected", () => {
  const t = mintRoomTicket("room-abc");
  const tampered = t.slice(0, -2) + (t.endsWith("a") ? "b" : "a") + t.slice(-1);
  assert.strictEqual(verifyRoomTicket(tampered, "room-abc"), null);
});

// ---- signed URL helper (Criterion 2) ---------------------------------------
// Mock global fetch to assert signClipUrl calls the PRIVATE-bucket sign endpoint
// and returns an absolute https URL built from the relative signedURL.

test("signClipUrl targets the private bucket sign endpoint and returns an absolute URL", async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      json: async () => ({
        signedURL: "/object/sign/clips-private/room-abc/123.webm?token=SIGNED",
      }),
    };
  };
  try {
    const out = await signClipUrl("room-abc/123.webm");
    assert.ok(
      calls[0].url.includes("/storage/v1/object/sign/clips-private/room-abc/123.webm"),
      "calls the private-bucket sign endpoint, not the public path",
    );
    assert.strictEqual(calls[0].opts.method, "POST");
    assert.strictEqual(
      out,
      "https://test.supabase.co/storage/v1/object/sign/clips-private/room-abc/123.webm?token=SIGNED",
    );
    assert.ok(!out.includes("/object/public/"), "no public-bucket URL is ever returned");
  } finally {
    global.fetch = realFetch;
  }
});

test("signClipUrl returns null when Supabase sign fails", async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 403, text: async () => "denied" });
  try {
    const out = await signClipUrl("room-abc/123.webm");
    assert.strictEqual(out, null);
  } finally {
    global.fetch = realFetch;
  }
});

// ---- resolveClipObjectPath: room pinning + traversal (Item 1 boundary) ------

test("resolveClipObjectPath pins to the route room and strips traversal", () => {
  // bare filename -> room/<file>
  assert.strictEqual(resolveClipObjectPath("room-abc", "123.webm"), "room-abc/123.webm");
  // full path -> basename kept, room from the route (NOT the input room)
  assert.strictEqual(
    resolveClipObjectPath("room-abc", "room-xyz/123.webm"),
    "room-abc/123.webm",
    "the route room wins; you cannot sign another room's clip",
  );
  // traversal is neutralized (only the basename survives)
  assert.strictEqual(
    resolveClipObjectPath("room-abc", "../../etc/passwd"),
    "room-abc/passwd",
  );
  // unusable references rejected
  assert.strictEqual(resolveClipObjectPath("room-abc", ""), null);
  assert.strictEqual(resolveClipObjectPath("room-abc", "bad name!.webm"), null);
  assert.strictEqual(resolveClipObjectPath("room-abc", undefined), null);
});

// ---- POST /clips/sign route (Criterion 1) ----------------------------------

test("POST /clips/sign returns 401 with NO JWT and NO room ticket", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, {
      method: "POST",
      path: "/clips/sign",
      body: JSON.stringify({ room: "room-abc", path: "room-abc/123.webm" }),
    });
    assert.strictEqual(res.status, 401, "no credential -> 401");
  } finally {
    server.close();
  }
});

test("POST /clips/sign returns 401 with a ticket for a DIFFERENT room", async () => {
  const { server, port } = await startServer();
  try {
    const ticket = mintRoomTicket("room-other");
    const res = await request(port, {
      method: "POST",
      path: "/clips/sign",
      headers: { "x-room-ticket": ticket },
      body: JSON.stringify({ room: "room-abc", path: "123.webm" }),
    });
    assert.strictEqual(res.status, 401, "room-scoped ticket cannot sign another room");
  } finally {
    server.close();
  }
});

test("POST /clips/sign happy path: valid room ticket -> fresh signed URL (mocked sign)", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  let signedPath = null;
  // Only the sign endpoint is hit (room-ticket auth needs no Supabase call).
  global.fetch = async (url) => {
    signedPath = String(url);
    return {
      ok: true,
      json: async () => ({
        signedURL: "/object/sign/clips-private/room-abc/123.webm?token=FRESH",
      }),
    };
  };
  try {
    const ticket = mintRoomTicket("room-abc");
    const res = await request(port, {
      method: "POST",
      path: "/clips/sign",
      headers: { "x-room-ticket": ticket },
      body: JSON.stringify({ room: "room-abc", path: "room-abc/123.webm" }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(
      res.json.url,
      "https://test.supabase.co/storage/v1/object/sign/clips-private/room-abc/123.webm?token=FRESH",
    );
    assert.ok(
      signedPath.includes("/object/sign/clips-private/room-abc/123.webm"),
      "signs the room-pinned object path",
    );
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test("POST /clips/sign with a valid Supabase JWT signs the clip", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/auth/v1/user")) {
      return { ok: true, json: async () => ({ id: "user-1" }) };
    }
    return {
      ok: true,
      json: async () => ({
        signedURL: "/object/sign/clips-private/room-abc/9.webm?token=JWTSIGNED",
      }),
    };
  };
  try {
    const res = await request(port, {
      method: "POST",
      path: "/clips/sign",
      headers: { authorization: "Bearer good-jwt" },
      body: JSON.stringify({ room: "room-abc", filename: "9.webm" }),
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.json.url.endsWith("token=JWTSIGNED"));
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test("POST /clips/sign returns 401 for a bad/expired JWT (no silent fallthrough)", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401 }); // auth/v1/user rejects
  try {
    const res = await request(port, {
      method: "POST",
      path: "/clips/sign",
      headers: { authorization: "Bearer bad-jwt" },
      body: JSON.stringify({ room: "room-abc", filename: "9.webm" }),
    });
    assert.strictEqual(res.status, 401);
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

// ---- SSRF redirect guard (Criterion 3) -------------------------------------

test("GET /analyze/proxy rejects a 3xx redirect with 502 (does not follow)", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  let followed = false;
  global.fetch = async (url, opts) => {
    // Assert the route asked fetch NOT to auto-follow.
    assert.strictEqual(opts.redirect, "manual", "proxy must use redirect:manual");
    // Simulate the allowed Supabase host responding with a 302 to metadata.
    return {
      status: 302,
      type: "default",
      headers: {
        get: (k) =>
          k.toLowerCase() === "location" ? "http://169.254.169.254/latest/meta-data/" : null,
      },
      body: null,
    };
  };
  try {
    const target = encodeURIComponent(
      "https://elcisvvbkwgsypdtlbht.supabase.co/storage/v1/object/sign/clips-private/x.webm?token=t",
    );
    const res = await request(port, { path: `/analyze/proxy?url=${target}` });
    assert.strictEqual(res.status, 502, "redirect is refused, not chased");
    assert.match(res.json.error, /redirect not allowed/);
    assert.strictEqual(followed, false);
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test("GET /analyze/proxy still rejects a non-allowlisted host (exact-host check intact)", async () => {
  const { server, port } = await startServer();
  try {
    const target = encodeURIComponent("https://evil.example.com/x.webm");
    const res = await request(port, { path: `/analyze/proxy?url=${target}` });
    assert.strictEqual(res.status, 400);
    assert.match(res.json.error, /host not allowed/);
  } finally {
    server.close();
  }
});

// ---- /claim atomic single-use (Criterion 2) --------------------------------
// The fix puts the precondition in the UPDATE filter. We assert: (1) the PATCH
// to athlete_claims carries claimed_at=is.null AND expires_at=gt.<now> in the
// query string and Prefer: return=representation, and (2) when that PATCH comes
// back with 0 rows, the route returns 409 (someone already claimed / expired)
// and never binds the athlete.

test("POST /claim consumes atomically: 0 rows updated -> 409, athlete never bound", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ u, method: opts.method, headers: opts.headers });
    if (u.includes("/auth/v1/user")) {
      return { ok: true, json: async () => ({ id: "user-1" }) };
    }
    // lookupClaim (GET athlete_claims) -> claim exists (not 404)
    if (u.includes("/rest/v1/athlete_claims?token=eq.") && (!opts.method || opts.method === "GET")) {
      return {
        ok: true,
        json: async () => [
          { token: "t", expires_at: "2999-01-01T00:00:00Z", claimed_at: null, athlete_id: "ath-1" },
        ],
      };
    }
    // The atomic consume PATCH -> simulate the row already taken (0 rows back).
    if (u.includes("/rest/v1/athlete_claims?token=eq.") && opts.method === "PATCH") {
      return { ok: true, json: async () => [] };
    }
    // athletes PATCH should NEVER be reached in the 0-row case.
    if (u.includes("/rest/v1/athletes")) {
      throw new Error("athlete bind must not run when claim consume returns 0 rows");
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const uuid = "11111111-1111-1111-1111-111111111111";
    const res = await request(port, {
      method: "POST",
      path: `/claim/${uuid}`,
      headers: { authorization: "Bearer good-jwt" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 409, "0 rows updated -> already claimed");

    const consume = calls.find(
      (c) => c.method === "PATCH" && c.u.includes("/rest/v1/athlete_claims?token=eq."),
    );
    assert.ok(consume, "the atomic consume PATCH ran");
    assert.match(consume.u, /claimed_at=is\.null/, "precondition: unclaimed is in the filter");
    assert.match(consume.u, /expires_at=gt\./, "precondition: not-expired is in the filter");
    assert.strictEqual(
      String(consume.headers.prefer),
      "return=representation",
      "Prefer: return=representation so 0 rows is detectable",
    );
    // athletes PATCH never fired (the throw above would have surfaced as 500/error).
    assert.ok(
      !calls.some((c) => c.u.includes("/rest/v1/athletes")),
      "athlete card is not bound when the claim was already taken",
    );
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test("POST /claim binds the athlete when the atomic consume returns exactly one row", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  let athleteBound = false;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/auth/v1/user")) return { ok: true, json: async () => ({ id: "user-1" }) };
    if (u.includes("/rest/v1/athlete_claims?token=eq.") && (!opts.method || opts.method === "GET")) {
      return {
        ok: true,
        json: async () => [
          { token: "t", expires_at: "2999-01-01T00:00:00Z", claimed_at: null, athlete_id: "ath-1" },
        ],
      };
    }
    if (u.includes("/rest/v1/athlete_claims?token=eq.") && opts.method === "PATCH") {
      // one row consumed
      return { ok: true, json: async () => [{ athlete_id: "ath-1", claimed_by: "user-1" }] };
    }
    if (u.includes("/rest/v1/athletes")) {
      athleteBound = true;
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const uuid = "22222222-2222-2222-2222-222222222222";
    const res = await request(port, {
      method: "POST",
      path: `/claim/${uuid}`,
      headers: { authorization: "Bearer good-jwt" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.athleteId, "ath-1");
    assert.ok(athleteBound, "exactly-one-row consume proceeds to bind the athlete");
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});
