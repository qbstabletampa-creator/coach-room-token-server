// Coach Room token server.
// Mints short-lived LiveKit access tokens so the phone never sees the API secret.
// The secret lives ONLY in this server's .env. Never ship it in the app bundle.

const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { AccessToken } = require("livekit-server-sdk");

const PORT = process.env.PORT || 3130;
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
  console.error(
    "[token-server] Missing LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET in .env",
  );
  process.exit(1);
}

const app = express();
app.use(cors()); // open CORS for dev — phone hits this over Tailscale
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// POST /token  { room, identity, name }
// -> { token, url }
app.post("/token", async (req, res) => {
  try {
    const { room, identity, name } = req.body || {};

    if (!room || !identity) {
      return res
        .status(400)
        .json({ error: "room and identity are required" });
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
