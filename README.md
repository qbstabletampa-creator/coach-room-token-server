# Coach Room / Sideline Studio Token Server

Mints LiveKit access tokens for the live coaching room AND hosts the browser-join
experience. This server is the ONLY place the LiveKit API key/secret live. They must
never end up in the Expo app bundle, the app's `.env`, or git.

## Canonical repo (source of truth)

**This repo (`coach-room-token-server`) is the source of truth for the token server.**
A vendored copy exists at `coach-room-app/token-server` for local reference only —
do NOT edit or deploy from that copy. All changes happen here and deploy to Render.

- Live: https://coach-room-token-server.onrender.com
- Render service: `srv-d8jli6ek1jcs73dssfg0` (auto-deploys on push to `master`)

## Setup

```bash
npm install
npm start
```

Server listens on `0.0.0.0:3130` locally (override with `PORT`). Render sets `PORT`.

## Env (server-side only — Render env vars in prod, `.env` locally)

```
LIVEKIT_URL=wss://...livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
PORT=3130
```

The secret lives ONLY in Render env vars in production. Never commit it.

## Routes

| Method | Route | Purpose |
|--------|-------|---------|
| GET  | `/health` | `{ "ok": true }` |
| POST | `/token` | body `{ room, identity, name }` -> `{ token, url }`. Rate limited (see below). |
| GET  | `/join/:id` | HTML interstitial: tries the app deep link `coachroomapp://room/<id>`, falls back to `/web/<id>` after 1.2s. The everyone-can-open invite link. |
| GET  | `/web/:id` | Browser call page (`public/join.html`) — full LiveKit web room. |

`:id` is validated to `[A-Za-z0-9-]{1,64}`. Anything else returns a 400
"invalid room" page, so a malicious id can never be reflected into HTML/JS (XSS).

## The invite link

The app's invite message should share:

```
https://coach-room-token-server.onrender.com/join/<ROOM_ID>
```

- App installed -> deep-links into the app.
- No app -> lands in the browser call after ~1.2s.

(The old `coachroomapp://room/<id>` custom-scheme link only worked for people who
already had the app. The `/join/<id>` https link works for everyone.)

## Browser join page (`public/join.html`)

Self-contained, no build step. Uses the `livekit-client` UMD from jsDelivr, pinned
to `2.19.2` (same minor as the app's `livekit-client ^2.19.2`) with Subresource
Integrity. Name input + "Join session" button (getUserMedia needs HTTPS + a user
gesture — Render provides HTTPS), then POSTs `/token` and `Room.connect()`. Remote
video full-bleed, local self-view as a corner PiP, controls for mic / camera / leave.
Handles waiting-for-participant, connect/disconnect, track subscribe/unsubscribe,
error display, and mobile Safari (`playsinline`, portrait).

## Hardening

- **helmet** with a custom CSP that allows: the jsDelivr CDN script, Google Fonts,
  and `connect-src` to `https://*.livekit.cloud` + `wss://*.livekit.cloud` (LiveKit
  signalling + WebRTC). `crossOriginEmbedderPolicy` is disabled so getUserMedia/WebRTC
  works across browsers. Verified the join page still loads LiveKit under this CSP.
- **express-rate-limit** on `POST /token`: **30 requests / minute / IP**, standard
  `RateLimit-*` headers. Over the limit returns 429.
- `app.set("trust proxy", 1)` so the rate limiter reads the real client IP behind
  Render's TLS proxy.
- `app.use(express.static("public"))` serves the join page assets.

## Auth (later phase)

CORS is intentionally **open** right now — the iOS app and the browser join page both
hit `/token` from different origins. Full Supabase-JWT auth on `/token` (verify the
caller is a real, allowed user before minting) is a planned later phase. Until then,
the rate limit is the only abuse control on token minting.

## Local phone testing (Tailscale)

The phone joins LiveKit Cloud directly, but gets its token from this server. For local
dev the app points at the Tailscale IP:

```
EXPO_PUBLIC_TOKEN_SERVER_URL=http://100.103.56.37:3130
```

Confirm reachability (Tailscale up):

```bash
curl http://100.103.56.37:3130/health
```

In production the app points at `https://coach-room-token-server.onrender.com`.
