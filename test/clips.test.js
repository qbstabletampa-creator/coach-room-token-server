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
  roomService,
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
            headers: res.headers,
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
  const crypto = require("node:crypto");
  const t = mintRoomTicket("room-abc");
  const p = t.slice(0, t.indexOf("."));

  // Forge: sign the real payload with the WRONG secret. Deterministic and
  // genuinely invalid, so it MUST be rejected. (The previous char-swap tamper
  // was non-deterministic: a no-op swap or base64 trailing-bit equivalence
  // could leave the signature cryptographically unchanged and still valid.)
  const wrongSig = crypto
    .createHmac("sha256", "attacker-does-not-know-the-secret")
    .update(p)
    .digest("base64url");
  assert.strictEqual(verifyRoomTicket(`${p}.${wrongSig}`, "room-abc"), null);

  // Also flip a real signature byte and re-encode -> must be rejected.
  const sb = Buffer.from(t.slice(t.indexOf(".") + 1), "base64url");
  sb[0] ^= 0xff;
  assert.strictEqual(
    verifyRoomTicket(`${p}.${sb.toString("base64url")}`, "room-abc"),
    null
  );
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

// ============================================================================
// Phase 1 hardening tests (S1 role source, S2 room authorization, S5 grant)
// ============================================================================

// A minimal MP4 ftyp header so req body sniffs as an mp4 clip (reused from the
// magic-byte tests above).
const MP4_BYTES = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
]);

// Decode a JWT's payload (middle segment) WITHOUT verifying — the test only
// inspects the claims the server put in, not the signature.
function decodeJwtPayload(jwt) {
  const parts = String(jwt).split(".");
  assert.strictEqual(parts.length, 3, "a real JWT has three dot-separated parts");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

// Build a global.fetch mock for the /token JWT path: it answers /auth/v1/user
// with the given user, and answers the S2 authorization lookups so that `user`
// is treated as the OWNER of `room` (coach_id === user.id on the session).
// This keeps the S1 identity tests green both before and after S2 lands.
function mockUserOwnsRoom(user, room) {
  return async (url) => {
    const u = String(url);
    if (u.includes("/auth/v1/user")) {
      return { ok: true, json: async () => user };
    }
    if (u.includes("/rest/v1/sessions")) {
      return {
        ok: true,
        json: async () => [
          { id: room, coach_id: user.id, athlete_id: "ath-owned", athletes: { user_id: null } },
        ],
      };
    }
    if (u.includes("/rest/v1/athletes")) {
      return { ok: true, json: async () => [] };
    }
    return { ok: true, json: async () => ({}) };
  };
}

// ---- S1: coach role is derived from app_metadata ONLY ----------------------

test("S1: user_metadata.role='coach' does NOT grant a coach identity (athlete-)", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  const user = {
    id: "u-meta-coach",
    user_metadata: { role: "coach" }, // client-writable — must be ignored
    app_metadata: {},
  };
  global.fetch = mockUserOwnsRoom(user, "room-s1a");
  try {
    const res = await request(port, {
      method: "POST",
      path: "/token",
      headers: { authorization: "Bearer good-jwt" },
      body: JSON.stringify({ room: "room-s1a", identity: "coach-HACKER" }),
    });
    assert.strictEqual(res.status, 200, "authorized owner mints a token");
    const payload = decodeJwtPayload(res.json.token);
    assert.ok(
      String(payload.sub).startsWith("athlete-"),
      `user_metadata.role must not promote: got sub=${payload.sub}`,
    );
    assert.strictEqual(payload.sub, "athlete-u-meta-coach");
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test("S1: app_metadata.role='coach' DOES grant a coach identity (coach-)", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  const user = {
    id: "u-app-coach",
    user_metadata: {},
    app_metadata: { role: "coach" }, // server-controlled — the real signal
  };
  global.fetch = mockUserOwnsRoom(user, "room-s1b");
  try {
    const res = await request(port, {
      method: "POST",
      path: "/token",
      headers: { authorization: "Bearer good-jwt" },
      body: JSON.stringify({ room: "room-s1b" }),
    });
    assert.strictEqual(res.status, 200);
    const payload = decodeJwtPayload(res.json.token);
    assert.strictEqual(payload.sub, "coach-u-app-coach");
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

// ---- S2: room-level authorization on /token (JWT path) + /room-ticket -------

// Build a fetch mock where /auth/v1/user returns `user`, and the sessions /
// athletes lookups return whatever rows the scenario supplies (empty by default).
function mockAuthz(user, { sessionRows = [], athleteRows = [] } = {}) {
  return async (url) => {
    const u = String(url);
    if (u.includes("/auth/v1/user")) return { ok: true, json: async () => user };
    if (u.includes("/rest/v1/sessions")) return { ok: true, json: async () => sessionRows };
    if (u.includes("/rest/v1/athletes")) return { ok: true, json: async () => athleteRows };
    return { ok: true, json: async () => ({}) };
  };
}

test("S2: coach who owns the session mints (200)", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  const user = { id: "coach-1", app_metadata: { role: "coach" } };
  global.fetch = mockAuthz(user, {
    sessionRows: [{ id: "room-own", coach_id: "coach-1", athlete_id: "a1", athletes: { user_id: null } }],
  });
  try {
    const res = await request(port, {
      method: "POST",
      path: "/token",
      headers: { authorization: "Bearer good-jwt" },
      body: JSON.stringify({ room: "room-own" }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(decodeJwtPayload(res.json.token).sub, "coach-coach-1");
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test("S2: coach minting for a FOREIGN room is refused (403)", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  const user = { id: "coach-1", app_metadata: { role: "coach" } };
  // The room exists but belongs to a different coach; no matching athlete row.
  global.fetch = mockAuthz(user, {
    sessionRows: [{ id: "room-foreign", coach_id: "coach-2", athlete_id: "a9", athletes: { user_id: "someone-else" } }],
  });
  try {
    const res = await request(port, {
      method: "POST",
      path: "/token",
      headers: { authorization: "Bearer good-jwt" },
      body: JSON.stringify({ room: "room-foreign" }),
    });
    assert.strictEqual(res.status, 403);
    assert.match(res.json.error, /not authorized/);
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test("S2: coach who owns the athlete card mints (Go Live fallback, 200)", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  const user = { id: "coach-1", app_metadata: { role: "coach" } };
  // Room is an athlete id (no session yet): sessions lookup empty, athletes owned.
  global.fetch = mockAuthz(user, {
    sessionRows: [],
    athleteRows: [{ id: "ath-room", coach_id: "coach-1", user_id: null }],
  });
  try {
    const res = await request(port, {
      method: "POST",
      path: "/token",
      headers: { authorization: "Bearer good-jwt" },
      body: JSON.stringify({ room: "ath-room" }),
    });
    assert.strictEqual(res.status, 200);
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test("S2: claimed athlete on the session mints (200)", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  const user = { id: "athlete-user-1", app_metadata: {} };
  // Session belongs to a coach, but its athlete is claimed by this user.
  global.fetch = mockAuthz(user, {
    sessionRows: [{ id: "room-sess", coach_id: "coach-9", athlete_id: "a1", athletes: { user_id: "athlete-user-1" } }],
  });
  try {
    const res = await request(port, {
      method: "POST",
      path: "/token",
      headers: { authorization: "Bearer good-jwt" },
      body: JSON.stringify({ room: "room-sess" }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(decodeJwtPayload(res.json.token).sub, "athlete-athlete-user-1");
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test("S2: athlete minting for a foreign session is refused (403)", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  const user = { id: "athlete-user-1", app_metadata: {} };
  // Session's athlete is claimed by someone else, and no athlete row matches.
  global.fetch = mockAuthz(user, {
    sessionRows: [{ id: "room-other", coach_id: "coach-9", athlete_id: "a2", athletes: { user_id: "different-athlete" } }],
  });
  try {
    const res = await request(port, {
      method: "POST",
      path: "/token",
      headers: { authorization: "Bearer good-jwt" },
      body: JSON.stringify({ room: "room-other" }),
    });
    assert.strictEqual(res.status, 403);
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test("S2: the /token room-ticket path is untouched (guest still mints, no authz lookup)", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  // If the ticket path wrongly reached the DB authz check this mock would throw.
  global.fetch = async (url) => {
    throw new Error(`ticket path must not hit Supabase: ${url}`);
  };
  try {
    const ticket = mintRoomTicket("room-guest");
    const res = await request(port, {
      method: "POST",
      path: "/token",
      body: JSON.stringify({ room: "room-guest", ticket }),
    });
    assert.strictEqual(res.status, 200, "valid room ticket still mints a guest token");
    assert.ok(decodeJwtPayload(res.json.token).sub.startsWith("guest-"));
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test("S2: /room-ticket minting for a foreign room is refused (403)", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  const user = { id: "coach-1", app_metadata: { role: "coach" } };
  global.fetch = mockAuthz(user, {
    sessionRows: [{ id: "room-foreign", coach_id: "coach-2", athlete_id: "a9", athletes: { user_id: null } }],
  });
  try {
    const res = await request(port, {
      method: "POST",
      path: "/room-ticket",
      headers: { authorization: "Bearer good-jwt" },
      body: JSON.stringify({ room: "room-foreign" }),
    });
    assert.strictEqual(res.status, 403);
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

// ---- S3: rate limiters on GET /analyze/proxy and GET /claim/:token ----------
// A wired express-rate-limit middleware sets RateLimit-* headers (standardHeaders)
// on every response, so their presence proves the limiter is in the chain.

test("S3: GET /analyze/proxy is rate-limited (RateLimit headers present)", async () => {
  const { server, port } = await startServer();
  try {
    // No url param -> 400, but the limiter runs before the handler and sets headers.
    const res = await request(port, { path: "/analyze/proxy" });
    assert.strictEqual(res.status, 400);
    assert.ok(res.headers["ratelimit-limit"], "proxy limiter sets RateLimit-Limit");
  } finally {
    server.close();
  }
});

test("S3: GET /claim/:token is rate-limited (RateLimit headers present)", async () => {
  const { server, port } = await startServer();
  try {
    const res = await request(port, { path: "/claim/not-a-uuid" });
    assert.strictEqual(res.status, 400);
    assert.ok(res.headers["ratelimit-limit"], "claim GET limiter sets RateLimit-Limit");
  } finally {
    server.close();
  }
});

// ---- S3: per-room clip storage quota ---------------------------------------

test("S3: POST /clips/:room returns 429 when the room prefix is at the object cap", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  let uploaded = false;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    // roomClipUsage lists the prefix -> return 60 objects (at ROOM_CLIP_MAX_OBJECTS).
    if (u.includes("/storage/v1/object/list/")) {
      const rows = Array.from({ length: 60 }, (_, i) => ({
        name: `${i}.mp4`,
        metadata: { size: 1000 },
      }));
      return { ok: true, json: async () => rows };
    }
    // The actual object write must NOT be reached once the quota trips.
    if (opts.method === "POST" && u.includes("/storage/v1/object/")) {
      uploaded = true;
      return { ok: true, text: async () => "" };
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const ticket = mintRoomTicket("room-quota");
    const res = await request(port, {
      method: "POST",
      path: "/clips/room-quota",
      headers: { "x-room-ticket": ticket, "content-type": "video/mp4" },
      body: MP4_BYTES,
    });
    assert.strictEqual(res.status, 429, "at the object cap -> 429");
    assert.match(res.json.error, /storage limit/);
    assert.strictEqual(uploaded, false, "no object is written when the quota trips");
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

// ---- S5: /token grant-decode (the security keystone) -----------------------
// Decode the minted LiveKit JWT and lock its shape: room-scoped grant, identity
// derived from the Supabase user (never the client-supplied identity), and no
// admin/create powers.

test("S5: minted /token JWT is room-scoped, identity is server-derived, no roomAdmin", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  const user = { id: "keystone-uid", app_metadata: { role: "coach" } };
  global.fetch = mockUserOwnsRoom(user, "room-keystone");
  try {
    const res = await request(port, {
      method: "POST",
      path: "/token",
      headers: { authorization: "Bearer good-jwt" },
      // Client tries to pick its own identity — the server must ignore it.
      body: JSON.stringify({ room: "room-keystone", identity: "coach-ATTACKER" }),
    });
    assert.strictEqual(res.status, 200);

    const payload = decodeJwtPayload(res.json.token);
    const grant = payload.video || {};

    // Room-scoped: the grant is pinned to the requested room only.
    assert.strictEqual(grant.room, "room-keystone", "grant is room-scoped");
    assert.strictEqual(grant.roomJoin, true, "roomJoin granted for the call");

    // Identity is derived server-side from the Supabase user, NOT req.body.identity.
    assert.strictEqual(payload.sub, "coach-keystone-uid", "identity is server-derived");
    assert.notStrictEqual(payload.sub, "coach-ATTACKER", "client-supplied identity is ignored");

    // No elevated powers: a leaked token cannot administer or create rooms.
    assert.ok(!grant.roomAdmin, "no roomAdmin grant");
    assert.ok(!grant.roomCreate, "no roomCreate grant");
    assert.ok(!grant.roomList, "no roomList grant");
  } finally {
    global.fetch = realFetch;
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
    if (u.includes("/rest/v1/sessions")) {
      return {
        ok: true,
        json: async () => [
          { id: "room-abc", coach_id: "user-1", athletes: { user_id: null } },
        ],
      };
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

// ---- M1: clip JWT paths are bound to room membership ----------------------

test("M1: non-member JWT cannot sign a clip for a foreign room (403)", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  const user = { id: "clip-outsider", app_metadata: { role: "coach" } };
  global.fetch = mockAuthz(user, {
    sessionRows: [
      { id: "room-clips", coach_id: "other-coach", athletes: { user_id: "other-athlete" } },
    ],
  });
  try {
    const res = await request(port, {
      method: "POST",
      path: "/clips/sign",
      headers: { authorization: "Bearer good-jwt" },
      body: JSON.stringify({ room: "room-clips", filename: "rep.mp4" }),
    });
    assert.strictEqual(res.status, 403);
    assert.match(res.json.error, /not authorized/);
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test("M1: non-member JWT cannot upload to a foreign room (403)", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  const user = { id: "clip-outsider", app_metadata: { role: "coach" } };
  global.fetch = mockAuthz(user, {
    sessionRows: [
      { id: "room-clips", coach_id: "other-coach", athletes: { user_id: "other-athlete" } },
    ],
  });
  try {
    const res = await request(port, {
      method: "POST",
      path: "/clips/room-clips",
      headers: { authorization: "Bearer good-jwt", "content-type": "video/mp4" },
      body: MP4_BYTES,
    });
    assert.strictEqual(res.status, 403);
    assert.match(res.json.error, /not authorized/);
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

// ---- M2: HTTPS data relay is room-authorized and coach-only ----------------

const DATA_PAYLOAD = Buffer.from(JSON.stringify({ v: 2, t: "mode", mode: "face" }))
  .toString("base64");

async function requestDataRelay(port) {
  return request(port, {
    method: "POST",
    path: "/data",
    headers: { authorization: "Bearer good-jwt" },
    body: JSON.stringify({ room: "room-data", payload: DATA_PAYLOAD }),
  });
}

test("M2: non-member coach cannot relay into a foreign room (403)", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  global.fetch = mockAuthz(
    { id: "coach-outsider", app_metadata: { role: "coach" } },
    {
      sessionRows: [
        { id: "room-data", coach_id: "coach-owner", athletes: { user_id: "athlete-member" } },
      ],
    },
  );
  try {
    const res = await requestDataRelay(port);
    assert.strictEqual(res.status, 403);
    assert.match(res.json.error, /not authorized/);
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test("M2: room-member athlete cannot use the coach relay (403)", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  global.fetch = mockAuthz(
    { id: "athlete-member", app_metadata: {} },
    {
      sessionRows: [
        { id: "room-data", coach_id: "coach-owner", athletes: { user_id: "athlete-member" } },
      ],
    },
  );
  try {
    const res = await requestDataRelay(port);
    assert.strictEqual(res.status, 403);
    assert.match(res.json.error, /coach role required/);
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test("M2: room-authorized app_metadata coach can relay (200)", async () => {
  const { server, port } = await startServer();
  const realFetch = global.fetch;
  const realSendData = roomService.sendData;
  const calls = [];
  global.fetch = mockAuthz(
    { id: "coach-owner", user_metadata: { role: "athlete" }, app_metadata: { role: "coach" } },
    {
      sessionRows: [
        { id: "room-data", coach_id: "coach-owner", athletes: { user_id: "athlete-member" } },
      ],
    },
  );
  roomService.sendData = async (...args) => calls.push(args);
  try {
    const res = await requestDataRelay(port);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { ok: true });
    assert.strictEqual(calls.length, 1, "relay reaches LiveKit once");
    assert.strictEqual(calls[0][0], "room-data");
    assert.strictEqual(calls[0][3].topic, "ct.v1");
  } finally {
    roomService.sendData = realSendData;
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
