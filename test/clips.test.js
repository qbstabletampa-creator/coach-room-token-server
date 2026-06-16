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
  sniffVideoMagic,
  mintRoomTicket,
  verifyRoomTicket,
  signClipUrl,
} = require("../index.js");

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
