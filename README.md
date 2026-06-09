# Coach Room Token Server

Mints LiveKit access tokens for the live coaching room. This server is the ONLY
place the LiveKit API key/secret live. They must never end up in the Expo app
bundle or in the app's `.env`.

## Setup

```bash
npm install
npm start
```

Server listens on `0.0.0.0:3130` (override with `PORT` in `.env`).

## .env (already written, server-side only)

```
LIVEKIT_URL=wss://...livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
PORT=3130
```

## Routes

- `GET /health` -> `{ "ok": true }`
- `POST /token` body `{ "room", "identity", "name" }` -> `{ "token", "url" }`

## Important for phone testing

The phone joins LiveKit Cloud directly over the internet, but it gets its token
from THIS server. So this process must:

1. Stay running the whole time you test live video.
2. Be reachable from the phone at the Tailscale IP the app points to:
   `EXPO_PUBLIC_TOKEN_SERVER_URL=http://100.103.56.37:3130`.

Confirm the phone (with Tailscale up) can reach it:

```bash
curl http://100.103.56.37:3130/health
```
