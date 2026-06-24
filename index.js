// Coach Room / Sideline Studio token server.
// Mints short-lived LiveKit access tokens so the phone never sees the API secret.
// The secret lives ONLY in this server's env (Render). Never ship it in the app bundle.

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
require("dotenv").config();
const { AccessToken } = require("livekit-server-sdk");

const PORT = process.env.PORT || 3130;
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

// Supabase (shared by /claim, /clips, and the Phase 0 /token auth helper).
// Declared up here so requireSupabaseUser() in the helpers section can read them.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Phase 0 security: server-signed, room-scoped, short-lived "room ticket" so a
// no-signup browser athlete can still join. HMAC-SHA256 with this secret. If it
// is unset the server still boots (LiveKit-only deploys), but ticket mint/verify
// are disabled and only Supabase-JWT callers can reach /token — fail closed.
const ROOM_TICKET_SECRET = process.env.ROOM_TICKET_SECRET;

// Phase 0 security: clips are a minor's footage, so they live in a PRIVATE
// bucket and are served only via short-lived signed URLs (never a world-readable
// public URL). Bucket name is overridable for staging; default is clips-private.
const CLIPS_BUCKET = process.env.CLIPS_BUCKET || "clips-private";
// Signed-URL lifetime in seconds. 7 days: long enough for a coach to review a
// rep over the following days without re-signing, short enough that a leaked URL
// expires. The app re-signs on demand for older clips (see migration runbook).
const CLIP_SIGN_TTL_S = Number(process.env.CLIP_SIGN_TTL_S || 7 * 24 * 60 * 60);
// How long a minted room ticket stays valid. 30 min: a coach shares a browser
// link, the athlete opens it within the half hour. Short enough that a leaked
// link dies fast, long enough to absorb "open it in a few minutes".
const ROOM_TICKET_TTL_MS = 30 * 60 * 1000;

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
  console.error(
    "[token-server] Missing LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET in env",
  );
  process.exit(1);
}

const app = express();

// Render terminates TLS at the proxy; trust it so rate-limit reads the real client IP.
app.set("trust proxy", 1);

// Hardening: helmet with a CSP that allows the livekit-client UMD from jsDelivr,
// websockets to LiveKit Cloud, and the inline page styles/scripts we serve.
// LiveKit needs wss:// connections + WebRTC; default helmet CSP would block them,
// so we explicitly allow connect-src to *.livekit.cloud over wss/https.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        // 'wasm-unsafe-eval' lets the Analyze v1 pose engine compile MediaPipe's
        // WebAssembly module. It permits WASM compilation ONLY, not arbitrary
        // eval() of JS strings, so it's far narrower than 'unsafe-eval'.
        "script-src": [
          "'self'",
          "'unsafe-inline'",
          "'wasm-unsafe-eval'",
          "https://cdn.jsdelivr.net",
        ],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com"],
        "img-src": ["'self'", "data:", "blob:"],
        // media-src: local blobs + mediastream for WebRTC, plus https: so the
        // coach's co-watch direct film URLs (provider "other") can load as a
        // <video src>. Scoped to https: rather than "*" to keep it tight.
        "media-src": ["'self'", "blob:", "mediastream:", "https:"],
        // LiveKit signalling + ICE: wss/https to livekit.cloud, plus blob workers.
        // Analyze v1 (public/analyze) loads MediaPipe Tasks-Vision from jsDelivr
        // and the pose model .task from storage.googleapis.com, so both must be
        // reachable via connect-src or the pose pipeline can't fetch the model.
        "connect-src": [
          "'self'",
          "https://*.livekit.cloud",
          "wss://*.livekit.cloud",
          "https://cdn.jsdelivr.net",
          "https://storage.googleapis.com",
        ],
        "worker-src": ["'self'", "blob:"],
        // frame-src: co-watch YouTube/Drive embeds ONLY. No other origins.
        "frame-src": ["'self'", "https://www.youtube.com", "https://drive.google.com"],
      },
    },
    // getUserMedia / WebRTC needs these relaxed in some browsers.
    crossOriginEmbedderPolicy: false,
  }),
);

// CORS is no longer wildcard (Phase 0 security). The browser join page is
// same-origin (served by this server), so it never needs cross-origin CORS.
// The native app is NOT a browser origin (no Origin header), so it is unaffected
// by CORS entirely — it always reaches /token regardless of this allowlist.
// ALLOWED_ORIGINS is an optional comma-separated env override; the default is the
// known Render token-server origin(s). A request with no Origin header (native
// app, curl, server-to-server) is allowed through; only browser cross-origin
// requests from an unlisted origin are rejected.
const DEFAULT_ALLOWED_ORIGINS = [
  "https://coach-room-token-server.onrender.com",
];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CORS_ALLOWLIST = ALLOWED_ORIGINS.length
  ? ALLOWED_ORIGINS
  : DEFAULT_ALLOWED_ORIGINS;

app.use(
  cors({
    origin(origin, cb) {
      // No Origin header → not a browser cross-origin call (native app, curl,
      // same-origin navigation). Allow it; auth is enforced per-route, not by CORS.
      if (!origin) return cb(null, true);
      // Allowed origin → reflect it (sets Access-Control-Allow-Origin).
      // Disallowed origin → do NOT throw (that would 500 the request). Instead
      // resolve false: no ACAO header is sent, so the browser blocks the
      // cross-origin read on its own, which is the real enforcement.
      return cb(null, CORS_ALLOWLIST.includes(origin));
    },
  }),
);
app.use(express.json());

// ---- Analyze v1: same-origin CORS proxy --------------------------------------
// The pose analyzer (public/analyze) reads video frames into a canvas, which
// requires the video to be same-origin OR served with CORS headers. Supabase
// public storage doesn't always send permissive CORS for video, so when a
// direct cross-origin load taints the canvas, the page retries through here.
// This route streams the remote clip back same-origin (no taint).
//
// SSRF guard: ONLY the Supabase storage host is allowed. Any other host -> 400.
// This is an exact-host allowlist, not a substring check, so look-alike hosts
// (e.g. elcisvvbkwgsypdtlbht.supabase.co.evil.com) are rejected.
const ALLOWED_PROXY_HOST = "elcisvvbkwgsypdtlbht.supabase.co";

// Defined BEFORE express.static. The exact path "/analyze/proxy" never collides
// with a real static file under public/analyze/ (there is no file named
// "proxy"), so it does not shadow the analyzer's assets.
app.get("/analyze/proxy", async (req, res) => {
  const raw = req.query.url;
  if (typeof raw !== "string" || !raw) {
    return res.status(400).json({ error: "url query param required" });
  }

  let target;
  try {
    target = new URL(raw);
  } catch {
    return res.status(400).json({ error: "invalid url" });
  }

  // Only https + the exact Supabase storage host. Reject everything else.
  if (target.protocol !== "https:" || target.hostname !== ALLOWED_PROXY_HOST) {
    return res.status(400).json({ error: "host not allowed" });
  }

  try {
    // Forward Range so the <video> can seek (byte-range requests).
    const fwdHeaders = {};
    if (req.headers.range) fwdHeaders.range = req.headers.range;

    // SSRF redirect guard (Phase 0): redirect: "manual" so fetch does NOT chase
    // a 3xx on its own. The exact-host allowlist above only validates the FIRST
    // URL; without this, a trusted Supabase response that 3xx-redirects (or a
    // host that resolves there) could bounce the proxy to an internal/arbitrary
    // address (e.g. 169.254.169.254 cloud metadata), defeating the allowlist.
    // Supabase public/signed object reads return 200/206 directly and never need
    // a redirect, so we reject any 3xx outright instead of following it.
    const upstream = await fetch(target.toString(), {
      method: "GET",
      headers: fwdHeaders,
      redirect: "manual",
    });

    // Reject any redirect. fetch with redirect:"manual" surfaces 3xx as a real
    // status (or an opaqueredirect type); either way we refuse to follow it.
    if (
      (upstream.status >= 300 && upstream.status < 400) ||
      upstream.type === "opaqueredirect"
    ) {
      console.warn(
        "[token-server] analyze proxy refused redirect:",
        upstream.status,
        upstream.headers.get("location") || "(opaque)",
      );
      return res.status(502).json({ error: "redirect not allowed" });
    }

    // Mirror status (200 or 206 for partial content; 4xx/5xx pass through too).
    res.status(upstream.status);

    // Pass through the headers the player needs for seeking/sizing.
    const ct = upstream.headers.get("content-type");
    const cl = upstream.headers.get("content-length");
    const ar = upstream.headers.get("accept-ranges");
    const cr = upstream.headers.get("content-range");
    if (ct) res.setHeader("content-type", ct);
    if (cl) res.setHeader("content-length", cl);
    if (ar) res.setHeader("accept-ranges", ar);
    if (cr) res.setHeader("content-range", cr);

    if (!upstream.body) {
      return res.end();
    }

    // Stream the bytes through without buffering the whole clip in memory.
    const { Readable } = require("stream");
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.error("[token-server] analyze proxy error:", err);
    if (!res.headersSent) res.status(502).json({ error: "proxy fetch failed" });
    else res.end();
  }
});

// Serve static assets (public/join.html etc.)
app.use(express.static(path.join(__dirname, "public")));

// ---- helpers ---------------------------------------------------------------

// Room ids in invites are alphanumeric + dash, bounded length.
// Anything else is rejected so it can never be reflected into HTML/JS.
const ROOM_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

function isValidRoomId(id) {
  return typeof id === "string" && ROOM_ID_RE.test(id);
}

// Defense in depth: even validated ids get escaped before interpolation.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Safe for embedding inside a single-quoted JS string literal.
// Room ids are already validated to [A-Za-z0-9-] so this never actually fires,
// but we escape defensively in case validation ever loosens. (Line separators
// U+2028/U+2029 are also blocked by validation, so they're not handled here.)
function escapeJsString(str) {
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

// ---- Phase 0 auth helpers --------------------------------------------------

// Verify a Supabase user JWT from the Authorization: Bearer header. This reuses
// the EXACT pattern already proven on POST /claim (auth/v1/user check with the
// service key) so /token and /claim share one auth primitive.
//
// Returns { user } on success, or { error, status } on failure (401 for a
// missing/invalid token, 503 if Supabase is not configured). It never throws on
// a bad token — the caller decides what to do (e.g. fall through to a room
// ticket) — but a thrown network error propagates to the route's try/catch.
async function requireSupabaseUser(req) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { error: "auth not configured", status: 503 };
  }
  const auth = req.headers.authorization || "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!jwt) return { error: "sign in required", status: 401 };

  const uResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, authorization: `Bearer ${jwt}` },
  });
  if (!uResp.ok) return { error: "invalid session", status: 401 };
  const user = await uResp.json();
  if (!user?.id) return { error: "invalid session", status: 401 };
  return { user };
}

// ---- Room ticket (server-signed, room-scoped, short-lived) -----------------
// A room ticket lets a no-signup browser athlete reach /token without a Supabase
// account. It is NOT a LiveKit token and carries NO LiveKit grant — it only
// proves "the bearer was authorized by a logged-in user to join THIS room,
// recently". /token verifies it and then mints a properly role-scoped LiveKit
// token server-side. Format: base64url(payload).base64url(hmacSHA256(payload)).
// Payload is JSON: { room, exp }. The signature binds room + exp so neither can
// be tampered with. No secret in the ticket, no client-controlled grant.

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBuf(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function mintRoomTicket(room) {
  if (!ROOM_TICKET_SECRET) return null;
  const payload = JSON.stringify({ room: String(room), exp: Date.now() + ROOM_TICKET_TTL_MS });
  const p = b64url(payload);
  const sig = crypto.createHmac("sha256", ROOM_TICKET_SECRET).update(p).digest();
  return `${p}.${b64url(sig)}`;
}

// Returns the room id the ticket is valid for, or null if invalid/expired/forged.
function verifyRoomTicket(ticket, room) {
  if (!ROOM_TICKET_SECRET || typeof ticket !== "string" || !ticket.includes(".")) {
    return null;
  }
  const dot = ticket.indexOf(".");
  const p = ticket.slice(0, dot);
  const sigPart = ticket.slice(dot + 1);
  const expected = crypto.createHmac("sha256", ROOM_TICKET_SECRET).update(p).digest();
  let provided;
  try {
    provided = b64urlToBuf(sigPart);
  } catch {
    return null;
  }
  // Constant-time compare; lengths must match or timingSafeEqual throws.
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(b64urlToBuf(p).toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.room !== "string" || typeof payload.exp !== "number") {
    return null;
  }
  if (payload.exp <= Date.now()) return null; // expired
  if (String(room) !== payload.room) return null; // room-scoped: ticket is for one room only
  return payload.room;
}

// ---- clip storage helpers (Phase 0 security) -------------------------------

// Validate the REAL file type by magic bytes, not the client's Content-Type
// header (which a malicious uploader controls). We only accept the two container
// formats MediaRecorder produces:
//   WebM/Matroska: EBML header 1A 45 DF A3 at offset 0.
//   MP4/QuickTime: an ISO-BMFF box with "ftyp" at bytes 4..8 ("....ftyp...").
// Anything else (a script, an html page, a zip) is rejected with 415 before it
// ever reaches storage. Returns "webm" | "mp4" | null.
function sniffVideoMagic(buf) {
  if (!buf || buf.length < 12) return null;
  // WebM / Matroska EBML.
  if (
    buf[0] === 0x1a &&
    buf[1] === 0x45 &&
    buf[2] === 0xdf &&
    buf[3] === 0xa3
  ) {
    return "webm";
  }
  // MP4 / ISO-BMFF: "ftyp" at offset 4. (Box size is bytes 0..4, type 4..8.)
  if (
    buf[4] === 0x66 && // f
    buf[5] === 0x74 && // t
    buf[6] === 0x79 && // y
    buf[7] === 0x70 // p
  ) {
    return "mp4";
  }
  return null;
}

// Mint a short-lived signed URL for a private-bucket object. Calls the Supabase
// Storage sign endpoint with the service key and returns a fully-qualified https
// URL the client can GET directly (no signature -> Supabase returns 400/403).
// Returns the signed URL string, or null on failure (caller decides the status).
async function signClipUrl(objectPath) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const resp = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/${CLIPS_BUCKET}/${objectPath}`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ expiresIn: CLIP_SIGN_TTL_S }),
    },
  );
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error("[token-server] clip sign failed:", resp.status, detail);
    return null;
  }
  const data = await resp.json().catch(() => null);
  // Supabase returns { signedURL: "/object/sign/<bucket>/<path>?token=..." } —
  // a path relative to /storage/v1. Make it absolute so the client can fetch it.
  const signed = data && (data.signedURL || data.signedUrl);
  if (!signed || typeof signed !== "string") return null;
  const rel = signed.startsWith("/") ? signed : `/${signed}`;
  return `${SUPABASE_URL}/storage/v1${rel}`;
}

// Resolve the client's clip reference into a SAFE object path inside :room.
// Accepts either an object path ("<room>/<file>") or a bare filename ("<file>"),
// and always returns "<room>/<basename>" — the room is taken from the route, not
// the input, so a caller authed for room A can never sign a clip in room B, and
// "../" path traversal is stripped (only [A-Za-z0-9._-] filenames are allowed).
// Returns null if the filename is unusable. This is the authorization boundary
// for /clips/sign: the signed object is pinned to the room the caller proved.
const CLIP_FILENAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
function resolveClipObjectPath(room, ref) {
  if (typeof ref !== "string" || !ref) return null;
  // Take the last path segment (handles both "<room>/<file>" and "<file>", and
  // neutralizes any "a/b/../c" traversal — the basename is all we keep).
  const base = ref.split("/").filter(Boolean).pop() || "";
  if (!CLIP_FILENAME_RE.test(base)) return null;
  if (base === "." || base === "..") return null;
  return `${room}/${base}`;
}

// ---- routes ----------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// GET /join/:id — interstitial that tries the app deep link, then falls back
// to the browser room. Works for everyone: app users get deep-linked, the rest
// land in the browser call after a short delay.
app.get("/join/:id", (req, res) => {
  const rawId = req.params.id || "";
  if (!isValidRoomId(rawId)) {
    return res.status(400).type("html").send(invalidRoomPage());
  }
  const idHtml = escapeHtml(rawId);
  const idJs = escapeJsString(rawId);

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Opening CoachTime…</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: #0E0E0F;
    color: #F2F0EB;
    font-family: "Space Grotesk", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    display: flex; align-items: center; justify-content: center;
    text-align: center; padding: 24px;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    background: #16161A; border-radius: 8px; padding: 40px 32px;
    max-width: 380px; width: 100%;
    box-shadow: 0 10px 40px rgba(0,0,0,0.4);
  }
  .dot {
    width: 12px; height: 12px; border-radius: 50%;
    background: #D4C36A; margin: 0 auto 20px;
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: .35; transform: scale(.85);} 50% { opacity: 1; transform: scale(1);} }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; letter-spacing: .2px; }
  p { font-size: 14px; line-height: 1.5; color: #B8B6B0; margin: 0 0 24px; }
  a.fallback {
    display: inline-block; color: #0E0E0F; background: #D4C36A;
    text-decoration: none; font-weight: 600; font-size: 15px;
    padding: 12px 22px; border-radius: 8px;
  }
  .room { color: #D4C36A; font-weight: 600; }
</style>
</head>
<body>
  <div class="card">
    <div class="dot" aria-hidden="true"></div>
    <h1>Opening CoachTime…</h1>
    <p>Launching the app for room <span class="room">${idHtml}</span>.<br/>No app? You'll join in the browser.</p>
    <a class="fallback" id="browserLink" href="/web/${idHtml}">Join in browser</a>
  </div>
<script>
  (function () {
    var roomId = '${idJs}';
    // The room ticket (Phase 0) rides in the URL fragment (#t=...). Fragments are
    // never sent to the server, so the ticket stays out of server logs. Carry it
    // through to /web so the browser join page can read it and reach /token.
    var frag = window.location.hash || '';
    // Keep the manual "Join in browser" link carrying the ticket too.
    try { document.getElementById('browserLink').href = '/web/' + roomId + frag; } catch (e) {}
    // Try the native app first.
    try { window.location = 'coachroomapp://room/' + roomId; } catch (e) {}
    // Fall back to the browser room if the app didn't take over.
    setTimeout(function () { window.location = '/web/' + roomId + frag; }, 1200);
  })();
</script>
</body>
</html>`);
});

// GET /web/:id — serves the browser call page. We serve the static join.html
// and let it parse the room id from the path client-side, so nothing dynamic
// is interpolated server-side here (extra XSS safety). Validate first anyway.
app.get("/web/:id", (req, res) => {
  const rawId = req.params.id || "";
  if (!isValidRoomId(rawId)) {
    return res.status(400).type("html").send(invalidRoomPage());
  }
  res.sendFile(path.join(__dirname, "public", "join.html"));
});

function invalidRoomPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Invalid room</title>
<style>html,body{height:100%;margin:0}body{background:#0E0E0F;color:#F2F0EB;
font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
display:flex;align-items:center;justify-content:center;text-align:center;padding:24px}
h1{font-size:20px;margin:0 0 8px}p{color:#B8B6B0;font-size:14px;margin:0}</style></head>
<body><div><h1>Invalid room link</h1><p>That session link doesn't look right.</p></div></body></html>`;
}

// ---- live clip upload (the rep-review loop) ---------------------------------
// The athlete's browser records its own camera (MediaRecorder on the existing
// getUserMedia stream — full source quality) and POSTs the bytes here; we push
// them into a PRIVATE Supabase Storage bucket (CLIPS_BUCKET) and return a
// short-lived SIGNED https URL. Bytes never persist on this box (Render disk is
// ephemeral). Requires SUPABASE_URL + SUPABASE_SERVICE_KEY in env; without
// them the endpoint answers 503 so the call can toast honestly.
//
// Phase 0 security (3 changes vs the old route):
//   1. AUTH: same dual-auth as /token. A verified Supabase user JWT (coach /
//      native athlete) OR a valid room ticket scoped to :room (browser athlete).
//      No credential -> 401. This kills "anyone can write 40MB to our bucket".
//   2. PRIVATE bucket + signed URL: writes go to the private CLIPS_BUCKET and we
//      return a signed URL, so a minor's footage is not world-readable by URL.
//   3. MAGIC-BYTE validation: the real bytes must be WebM or MP4, not just a
//      trusted Content-Type header. Non-video -> 415.

// SUPABASE_URL / SUPABASE_SERVICE_KEY are declared once near the top of the file
// (the Phase 0 /token auth helper needs them before this point).

const clipLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many clip uploads, slow down." },
});

// ---- on-demand clip re-sign (Phase 0 security) ------------------------------
// POST /clips/sign  { room, path | filename }  -> { url }
// Signed clip URLs are short-lived (CLIP_SIGN_TTL_S). Persisting a long-lived
// URL would either leak (long TTL) or go dark after the TTL (short TTL). Instead
// the app stores only the object PATH and asks here for a FRESH signed URL at
// play time, so clips never expire on the user and the public bucket can be
// fully retired (a minor's footage is never world-readable).
//
// Auth: EXACTLY the same dual-auth as /clips/:room and /token:
//   (a) a verified Supabase user JWT (coach / native athlete), OR
//   (b) a valid room ticket scoped to THIS room (no-signup browser athlete).
// No valid credential -> 401. The object is pinned to :room server-side, so a
// caller authed for one room cannot sign another room's clip.
//
// MUST be registered BEFORE "/clips/:room" so Express matches "/clips/sign" here
// and does not treat "sign" as a :room param (route order matters in Express).
const clipSignLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // playback re-signs are read-only and cheap; a review session may
  // open several clips in a minute, so this is roomier than the upload limit.
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many sign requests, slow down." },
});

app.post("/clips/sign", clipSignLimiter, async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(503).json({ error: "clip storage not configured" });
    }
    const { room, path: clipPath, filename } = req.body || {};
    if (!room || !isValidRoomId(String(room))) {
      return res.status(400).json({ error: "bad room id" });
    }
    const roomStr = String(room);

    // ---- AUTH: same dual-auth as /clips/:room and /token -------------------
    const hasAuthHeader = (req.headers.authorization || "").startsWith("Bearer ");
    if (hasAuthHeader) {
      const authd = await requireSupabaseUser(req);
      if (authd.error) {
        return res.status(authd.status).json({ error: authd.error });
      }
    } else {
      const ticket = req.headers["x-room-ticket"] || req.body.ticket || "";
      if (!verifyRoomTicket(String(ticket), roomStr)) {
        return res
          .status(401)
          .json({ error: "authentication required (sign in or valid room ticket)" });
      }
    }

    // Resolve to a safe object path pinned to :room (strips traversal, ignores
    // any room embedded in the input).
    const objectPath = resolveClipObjectPath(roomStr, clipPath || filename);
    if (!objectPath) {
      return res.status(400).json({ error: "bad clip reference" });
    }

    const signedUrl = await signClipUrl(objectPath);
    if (!signedUrl) {
      return res.status(502).json({ error: "could not sign clip url" });
    }
    res.json({ url: signedUrl });
  } catch (err) {
    console.error("[token-server] clip sign error:", err);
    res.status(500).json({ error: "clip sign failed" });
  }
});

app.post(
  "/clips/:room",
  clipLimiter,
  express.raw({ type: ["video/*", "application/octet-stream"], limit: "40mb" }),
  async (req, res) => {
    try {
      if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return res.status(503).json({ error: "clip storage not configured" });
      }
      const room = req.params.room || "";
      if (!isValidRoomId(room)) {
        return res.status(400).json({ error: "bad room id" });
      }

      // ---- AUTH (Phase 0): same dual-auth as /token --------------------------
      // (a) a verified Supabase user JWT (coach or native athlete), OR
      // (b) a valid room ticket scoped to THIS room (no-signup browser athlete).
      // No valid credential -> 401. A bad/expired JWT is a hard 401 (the caller
      // clearly meant to authenticate as a user; do not fall through to ticket).
      const hasAuthHeader = (req.headers.authorization || "").startsWith("Bearer ");
      if (hasAuthHeader) {
        const authd = await requireSupabaseUser(req);
        if (authd.error) {
          return res.status(authd.status).json({ error: authd.error });
        }
      } else {
        // express.raw consumed the body, so the ticket rides in a header (the
        // browser uploader sends X-Room-Ticket) or a query param fallback.
        const ticket =
          req.headers["x-room-ticket"] || req.query.ticket || "";
        if (!verifyRoomTicket(String(ticket), room)) {
          return res
            .status(401)
            .json({ error: "authentication required (sign in or valid room ticket)" });
        }
      }

      const body = req.body;
      if (!body || !body.length) {
        return res.status(400).json({ error: "empty clip" });
      }

      // ---- MAGIC-BYTE validation (Phase 0): trust the bytes, not the header --
      const kind = sniffVideoMagic(body);
      if (!kind) {
        return res
          .status(415)
          .json({ error: "unsupported media: not a webm/mp4 video" });
      }
      // Hard backstop: the iOS coach (expo-video / AVPlayer) can't decode WebM,
      // so a WebM clip is a silent black stage. Refuse it at the server so no
      // unplayable clip ever reaches storage (CJ, 2026-06-24).
      if (kind === "webm") {
        return res
          .status(415)
          .json({ error: "iOS coach can't play WebM - record MP4" });
      }
      const ext = kind; // "webm" | "mp4", derived from the real bytes
      const contentType = kind === "mp4" ? "video/mp4" : "video/webm";
      const objectPath = `${room}/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.${ext}`;

      // ---- PRIVATE bucket write (Phase 0): CLIPS_BUCKET, not public "clips" --
      const up = await fetch(
        `${SUPABASE_URL}/storage/v1/object/${CLIPS_BUCKET}/${objectPath}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
            "content-type": contentType,
            "x-upsert": "false",
          },
          body,
        },
      );
      if (!up.ok) {
        const detail = await up.text().catch(() => "");
        console.error("[token-server] clip upload failed:", up.status, detail);
        return res.status(502).json({ error: "storage upload failed" });
      }

      // ---- SIGNED URL (Phase 0): no world-readable /object/public/ URL -------
      const signedUrl = await signClipUrl(objectPath);
      if (!signedUrl) {
        return res.status(502).json({ error: "could not sign clip url" });
      }
      res.json({ url: signedUrl });
    } catch (err) {
      console.error("[token-server] clip upload error:", err);
      res.status(500).json({ error: "clip upload failed" });
    }
  },
);

// ---- claim links (athlete identity) -----------------------------------------
// The coach mints a single-use token (athlete_claims row); the athlete taps
// the link and claims the card — no sign-up. GET renders the landing page;
// POST (with a Supabase user JWT) performs the bind server-side with the
// service key: athletes.user_id + claim consumed. Single-use + expiring.

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

async function lookupClaim(token) {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/athlete_claims?token=eq.${token}` +
      `&select=token,expires_at,claimed_at,athlete_id,athletes(name),coaches:coach_id(full_name)`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    },
  );
  if (!resp.ok) return null;
  const rows = await resp.json();
  return rows && rows[0] ? rows[0] : null;
}

app.get("/claim/:token", async (req, res) => {
  const token = req.params.token || "";
  if (!UUID_RE.test(token) || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(400).type("html").send(invalidRoomPage());
  }
  const claim = await lookupClaim(token).catch(() => null);
  const valid =
    claim && !claim.claimed_at && new Date(claim.expires_at).getTime() > Date.now();
  const athleteName = escapeHtml(claim?.athletes?.name ?? "Athlete");
  const coachName = escapeHtml(claim?.coaches?.full_name ?? "Your coach");

  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>CoachTime — You're invited</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; }
  body { background:#0E0E0F; color:#F2F0EB; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         display:flex; align-items:center; justify-content:center; text-align:center; padding:24px; }
  .card { background:#16161A; border-radius:12px; padding:40px 32px; max-width:400px; width:100%;
          box-shadow:0 12px 48px rgba(0,0,0,0.45); }
  .brand { font-size:13px; letter-spacing:2px; text-transform:uppercase; color:#D4C36A; margin:0 0 14px; font-weight:600; }
  h1 { font-size:22px; margin:0 0 8px; }
  p { font-size:14px; line-height:1.55; color:#B8B6B0; margin:0 0 22px; }
  .gold { color:#D4C36A; font-weight:600; }
  a.cta { display:inline-block; color:#0E0E0F; background:#D4C36A; text-decoration:none;
          font-weight:700; font-size:15px; padding:13px 24px; border-radius:8px; }
</style></head><body><div class="card">
  <p class="brand">CoachTime</p>
  ${
    valid
      ? `<h1>${athleteName}, you're in.</h1>
         <p><span class="gold">${coachName}</span> set up your spot — your film, your punch lists, and your live sessions in one place. No sign-up, just claim it.</p>
         <a class="cta" href="coachroomapp://claim/${escapeHtml(token)}">Claim my spot</a>
         <p style="margin-top:18px;font-size:12.5px">Claiming finishes inside the CoachTime app. Browser claiming is coming next.</p>`
      : `<h1>This invite has expired.</h1>
         <p>Ask your coach to send a fresh link — it takes them one tap.</p>`
  }
</div></body></html>`);
});

// POST /claim/:token  (Authorization: Bearer <supabase user JWT>)
// Binds the athlete card to the authenticated user. Single-use.
const claimLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many claim attempts, slow down." },
});

app.post("/claim/:token", claimLimiter, async (req, res) => {
  try {
    const token = req.params.token || "";
    if (!UUID_RE.test(token)) return res.status(400).json({ error: "bad token" });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(503).json({ error: "claims not configured" });
    }
    const auth = req.headers.authorization || "";
    const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!jwt) return res.status(401).json({ error: "sign in to claim" });

    // Verify the user JWT against Supabase auth.
    const uResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, authorization: `Bearer ${jwt}` },
    });
    if (!uResp.ok) return res.status(401).json({ error: "invalid session" });
    const user = await uResp.json();
    if (!user?.id) return res.status(401).json({ error: "invalid session" });

    // lookupClaim is ONLY for the friendly 404 "claim not found" message. The
    // authority for single-use is the filtered UPDATE below, never this read.
    const claim = await lookupClaim(token);
    if (!claim) return res.status(404).json({ error: "claim not found" });

    // ---- ATOMIC consume (Phase 0): no check-then-act window ------------------
    // The precondition (unclaimed AND not expired) lives in the UPDATE filter,
    // so two concurrent requests cannot both win: PostgREST applies the filter
    // row-by-row, the first PATCH flips claimed_at, the second matches 0 rows.
    // `Prefer: return=representation` returns the rows actually updated, so an
    // empty array means "someone already claimed or it expired" -> 409. There
    // is no separate read-then-write, so the classic race is gone.
    const nowIso = new Date().toISOString();
    const svcHeaders = {
      apikey: SUPABASE_SERVICE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "content-type": "application/json",
    };
    const consumeResp = await fetch(
      `${SUPABASE_URL}/rest/v1/athlete_claims` +
        `?token=eq.${token}` +
        `&claimed_at=is.null` +
        `&expires_at=gt.${encodeURIComponent(nowIso)}`,
      {
        method: "PATCH",
        headers: { ...svcHeaders, prefer: "return=representation" },
        body: JSON.stringify({ claimed_by: user.id, claimed_at: nowIso }),
      },
    );
    if (!consumeResp.ok) {
      const detail = await consumeResp.text().catch(() => "");
      console.error("[token-server] claim consume failed:", consumeResp.status, detail);
      return res.status(502).json({ error: "claim failed" });
    }
    const consumed = await consumeResp.json().catch(() => []);
    // 0 rows updated -> the claim was already taken or is expired. Either way the
    // token is spent/unusable: 409 already-claimed (single-use is enforced here).
    if (!Array.isArray(consumed) || consumed.length === 0) {
      return res.status(409).json({ error: "already claimed" });
    }
    const consumedRow = consumed[0];

    // Token is now consumed atomically. Bind the athlete card. If THIS fails the
    // token is already spent (the safe direction: no double-bind, no second
    // request can re-consume), so we surface 502 and the user re-requests a link.
    const r1 = await fetch(
      `${SUPABASE_URL}/rest/v1/athletes?id=eq.${consumedRow.athlete_id}`,
      {
        method: "PATCH",
        headers: { ...svcHeaders, prefer: "return=minimal" },
        body: JSON.stringify({ user_id: user.id }),
      },
    );
    if (!r1.ok) return res.status(502).json({ error: "claim failed" });

    res.json({ ok: true, athleteId: consumedRow.athlete_id });
  } catch (err) {
    console.error("[token-server] claim error:", err);
    res.status(500).json({ error: "claim failed" });
  }
});

// ---- room ticket mint ------------------------------------------------------
// AUTHENTICATED. Only a logged-in Supabase user (the coach) can mint a room
// ticket. The coach app calls this when it builds a shareable browser link, so
// the link can carry a ticket a no-signup athlete uses to reach /token. The
// ticket is room-scoped and short-lived; it grants NOTHING by itself.
const ticketLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many ticket requests, slow down." },
});

// POST /room-ticket  { room }  (Authorization: Bearer <supabase user JWT>)
//   -> { ticket, expiresInMs }
app.post("/room-ticket", ticketLimiter, async (req, res) => {
  try {
    if (!ROOM_TICKET_SECRET) {
      return res.status(503).json({ error: "room tickets not configured" });
    }
    const { room } = req.body || {};
    if (!room || !isValidRoomId(String(room))) {
      return res.status(400).json({ error: "bad room id" });
    }
    // Minting requires auth: a stranger cannot forge a ticket without a real
    // Supabase session. (Network errors bubble to the catch below.)
    const authd = await requireSupabaseUser(req);
    if (authd.error) {
      return res.status(authd.status).json({ error: authd.error });
    }
    const ticket = mintRoomTicket(String(room));
    if (!ticket) {
      return res.status(503).json({ error: "room tickets not configured" });
    }
    res.json({ ticket, expiresInMs: ROOM_TICKET_TTL_MS });
  } catch (err) {
    console.error("[token-server] room-ticket error:", err);
    res.status(500).json({ error: "failed to mint room ticket" });
  }
});

// ---- token mint ------------------------------------------------------------

// Rate limit: 30 requests / minute / IP. Token mints are cheap and signed
// locally, but this caps abuse (e.g. a script hammering the endpoint to spin
// up rooms). 30/min is generous for a human join flow (a few retries on a
// flaky network) while still throttling automated abuse.
const tokenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many token requests, slow down and try again." },
});

// POST /token  { room, identity, name } -> { token, url }
// POST /token  { room, name?, ticket? }  -> { token, url }
//
// Phase 0 auth (this is the impersonation fix). To mint a LiveKit token the
// caller MUST present EITHER:
//   (a) a valid Supabase user JWT in Authorization: Bearer — coach (native app)
//       or native athlete (anonymous Supabase session created on /claim), OR
//   (b) a valid room ticket for THIS room — no-signup browser athlete.
// No JWT and no valid ticket -> 401. Identity and role are derived SERVER-SIDE
// from whichever credential checked out; the client-supplied `identity` is
// IGNORED entirely (that was the impersonation hole — a stranger could type
// "coach-<uid>"). `name` is kept only as a display label.
app.post("/token", tokenLimiter, async (req, res) => {
  try {
    const { room, name, ticket } = req.body || {};

    if (!room) {
      return res.status(400).json({ error: "room is required" });
    }
    // Same validation every other route applies — never pass an arbitrary
    // string into a LiveKit grant (Engine finding N2, 2026-06-12).
    if (!isValidRoomId(String(room))) {
      return res.status(400).json({ error: "bad room id" });
    }
    const roomStr = String(room);

    // Derive identity + role SERVER-SIDE. Never trust req.body.identity.
    let identity = null;
    let role = "athlete"; // browser/native athlete by default; coach is proven by JWT metadata

    // Path (a): Supabase user JWT, if an Authorization header is present.
    const hasAuthHeader = (req.headers.authorization || "").startsWith("Bearer ");
    if (hasAuthHeader) {
      const authd = await requireSupabaseUser(req);
      if (authd.error) {
        // A bad/expired JWT is a hard 401 — do not silently fall through to a
        // ticket, the caller clearly meant to authenticate as a user.
        return res.status(authd.status).json({ error: authd.error });
      }
      const user = authd.user;
      // Role from the verified user's metadata. A coach is whoever the app
      // marks as such (user_metadata.role === "coach"); everyone else is an
      // athlete. This comes from the trusted /auth/v1/user response, NOT the
      // request body, so it cannot be spoofed by the client.
      const claimedRole =
        user.user_metadata?.role || user.app_metadata?.role || null;
      role = claimedRole === "coach" ? "coach" : "athlete";
      identity = `${role}-${user.id}`;
    } else {
      // Path (b): room ticket for a no-signup browser athlete.
      const ticketRoom = verifyRoomTicket(ticket, roomStr);
      if (!ticketRoom) {
        return res
          .status(401)
          .json({ error: "authentication required (sign in or valid room ticket)" });
      }
      // Server-generated guest identity, scoped to the ticket's room. The
      // browser cannot pick its own identity.
      role = "athlete";
      identity = `guest-${crypto.randomBytes(5).toString("hex")}`;
    }

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name: name ? String(name).slice(0, 80) : undefined,
      // Short TTL: the token is only needed at the initial signal handshake, not
      // for the call duration, so 15 min does not drop anyone mid-call but a
      // leaked token dies fast.
      ttl: "15m",
    });

    // Two-way video preserved for BOTH roles: coach and athlete each publish
    // their own camera/mic and subscribe to the other. Role-scoping here means
    // identity/role are server-derived and the room is authorized — it does NOT
    // strip publish from athletes. Nobody gets roomAdmin/roomCreate.
    at.addGrant({
      roomJoin: true,
      room: roomStr,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    // toJwt() is async in livekit-server-sdk v2.
    const token = await at.toJwt();

    res.json({ token, url: LIVEKIT_URL });
  } catch (err) {
    console.error("[token-server] mint failed:", err);
    res.status(500).json({ error: "failed to mint token" });
  }
});

// Only bind the port when run directly (node index.js). When required by a test
// (require.main !== module) we export the pure helpers for unit testing and skip
// listen(), so tests never open a socket or need live LiveKit/Supabase creds.
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[token-server] listening on 0.0.0.0:${PORT}`);
    console.log(`[token-server] LiveKit URL: ${LIVEKIT_URL}`);
  });
}

module.exports = {
  app, // exported so tests can drive routes over an ephemeral port (no live creds)
  sniffVideoMagic,
  mintRoomTicket,
  verifyRoomTicket,
  isValidRoomId,
  signClipUrl,
  resolveClipObjectPath,
};
