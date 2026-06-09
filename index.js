// Coach Room / Sideline Studio token server.
// Mints short-lived LiveKit access tokens so the phone never sees the API secret.
// The secret lives ONLY in this server's env (Render). Never ship it in the app bundle.

const path = require("path");
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
        "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com"],
        "img-src": ["'self'", "data:", "blob:"],
        "media-src": ["'self'", "blob:", "mediastream:"],
        // LiveKit signalling + ICE: wss/https to livekit.cloud, plus blob workers.
        "connect-src": [
          "'self'",
          "https://*.livekit.cloud",
          "wss://*.livekit.cloud",
          "https://cdn.jsdelivr.net",
        ],
        "worker-src": ["'self'", "blob:"],
        "frame-src": ["'self'"],
      },
    },
    // getUserMedia / WebRTC needs these relaxed in some browsers.
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(cors()); // open CORS for now — the iOS app + the browser join page both need it.
                 // Full Supabase-JWT auth on /token is a later phase (see README).
app.use(express.json());

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
<title>Opening Sideline…</title>
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
    <h1>Opening Sideline…</h1>
    <p>Launching the app for room <span class="room">${idHtml}</span>.<br/>No app? You'll join in the browser.</p>
    <a class="fallback" href="/web/${idHtml}">Join in browser</a>
  </div>
<script>
  (function () {
    var roomId = '${idJs}';
    // Try the native app first.
    try { window.location = 'coachroomapp://room/' + roomId; } catch (e) {}
    // Fall back to the browser room if the app didn't take over.
    setTimeout(function () { window.location = '/web/' + roomId; }, 1200);
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
app.post("/token", tokenLimiter, async (req, res) => {
  try {
    const { room, identity, name } = req.body || {};

    if (!room || !identity) {
      return res.status(400).json({ error: "room and identity are required" });
    }

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: String(identity),
      name: name ? String(name) : undefined,
    });

    at.addGrant({
      roomJoin: true,
      room: String(room),
      canPublish: true,
      canSubscribe: true,
    });

    // toJwt() is async in livekit-server-sdk v2.
    const token = await at.toJwt();

    res.json({ token, url: LIVEKIT_URL });
  } catch (err) {
    console.error("[token-server] mint failed:", err);
    res.status(500).json({ error: "failed to mint token" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[token-server] listening on 0.0.0.0:${PORT}`);
  console.log(`[token-server] LiveKit URL: ${LIVEKIT_URL}`);
});
