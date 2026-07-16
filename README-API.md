# CoachTime Open API + MCP

Every coach can mint a tenant-scoped API key and plug their own AI (Claude,
agents, scripts) into their coaching business. Two surfaces, one credential:

- **REST** at `/api/v1/*` — plain HTTP JSON for scripts and integrations.
- **MCP** at `/mcp` — a Model Context Protocol server so an AI (Claude Desktop,
  Claude Code, any MCP client) can call your data directly as tools.

Both are locked to the coach who owns the key. A key sees that coach's data and
nothing else, ever. This surface ships **dark**: it is only live when the server
runs with `API_ENABLED=1`.

---

## Quickstart

### 1. Mint a key (in the app)

The coach app calls the key-management endpoints (authed by your normal coach
login). Under the hood:

```bash
# POST /developer/keys  (Authorization: Bearer <your coach session JWT>)
curl -X POST https://<server>/developer/keys \
  -H "Authorization: Bearer $COACH_JWT" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Claude agent"}'
```

Response (the plaintext key is shown **once** — store it now, it is never
retrievable again):

```json
{
  "key": "ctk_9f3a...e21c",
  "id": "…",
  "name": "My Claude agent",
  "prefix": "ctk_9f3a…",
  "rate_limit": 60,
  "scopes": []
}
```

### 2. Call the REST API

```bash
curl https://<server>/api/v1/athletes \
  -H "Authorization: Bearer ctk_9f3a...e21c"
```

```json
{ "athletes": [ { "id": "…", "name": "…", … } ], "limit": 50, "offset": 0 }
```

### 3. Add it to Claude as an MCP server

Point any MCP client at the `/mcp` URL with your key as the Bearer token. Example
Claude Desktop / Claude Code config:

```json
{
  "mcpServers": {
    "coachtime": {
      "type": "http",
      "url": "https://<server>/mcp",
      "headers": { "Authorization": "Bearer ctk_9f3a...e21c" }
    }
  }
}
```

Then ask your AI things like "list my athletes", "book-out my open slots for the
next 4 weeks", or "cancel the booking on slot X". The AI calls the tools below.

---

## REST endpoints

All routes require `Authorization: Bearer <key>`. All are scoped to the key's
coach. List endpoints accept `limit` (1–100, default 50) and `offset`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/athletes` | List athletes |
| GET | `/api/v1/athletes/:id` | Get one athlete (404 if not yours) |
| POST | `/api/v1/athletes` | Create an athlete (`name` required) |
| PATCH | `/api/v1/athletes/:id` | Update an athlete |
| DELETE | `/api/v1/athletes/:id` | Delete an athlete |
| GET | `/api/v1/sessions` | List sessions (optional `?athlete_id=`) |
| GET | `/api/v1/sessions/:id` | Get one session |
| POST | `/api/v1/sessions` | Create a session (`athlete_id`, `title` required) |
| PATCH | `/api/v1/sessions/:id` | Update a session |
| GET | `/api/v1/slots` | List bookable slots (optional `?status=`) |
| POST | `/api/v1/slots/generate` | Expand availability windows into open slots (`weeks` 1–12) |
| GET | `/api/v1/bookings` | List booked slots |
| POST | `/api/v1/bookings/cancel` | Cancel a booking (`slot_id`); refunds a credit |
| GET | `/api/v1/packages` | List your credit packages |
| GET | `/api/v1/purchases` | List package purchases (optional `?athlete_id=`) |
| GET | `/api/v1/credit-balances` | Live credit balance per athlete (optional `?athlete_id=`) |
| POST | `/api/v1/invites` | Mint a booking invite link (optional `athlete_id`/`slot_id`/`email`) |
| GET | `/api/v1/invites` | List booking invites |
| GET | `/api/v1/protection/policy` | Get default protection policy and service overrides |
| PUT | `/api/v1/protection/policy` | Set a default or service-specific protection policy |
| GET | `/api/v1/booking-charges` | List protection charges (`status`, `athlete_id`) |
| POST | `/api/v1/booking-charges/no-show` | Mark an eligible slot no-show and charge its fee |
| POST | `/api/v1/booking-charges/:id/waive` | Waive or refund a protection charge |
| PUT | `/api/v1/packages/:id/billing-plan` | Set package billing shape and cadence |
| GET | `/api/v1/subscriptions` | List athlete subscriptions |
| GET | `/api/v1/subscriptions/:id` | Get one subscription |
| POST | `/api/v1/subscriptions/:id/pause` | Pause a subscription |
| POST | `/api/v1/subscriptions/:id/resume` | Resume a subscription |
| POST | `/api/v1/subscriptions/:id/cancel` | Cancel now or at period end |
| GET | `/api/v1/dashboard` | Get the coach business rollup |
| GET | `/api/v1/payments/overview` | Get collected/owed totals and ledger |
| POST | `/api/v1/payments` | Record a collected payment |
| POST | `/api/v1/payments/:id/void` | Void a recorded payment |
| POST | `/api/v1/charges` | Create an owed charge |
| POST | `/api/v1/athletes/import` | Import up to 500 roster rows |
| GET | `/api/v1/coach-page` | Get the coach's sanitized public-page data |
| GET | `/api/v1/clips` | List clip-library metadata |
| POST | `/api/v1/clips/:id/url` | Mint a short-lived signed clip URL |

### Key management (coach-login authed, not key authed)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/developer/keys` | Mint a key (returns plaintext once) |
| GET | `/developer/keys` | List your keys (metadata only) |
| DELETE | `/developer/keys/:id` | Revoke a key |

---

## MCP tools

`/mcp` is a stateless Streamable HTTP MCP server. It exposes 34 tools, all
tenant-locked to the key's coach:

`list_athletes`, `get_athlete`, `create_athlete`, `update_athlete`,
`list_sessions`, `get_session`, `list_slots`, `generate_slots`, `list_bookings`,
`cancel_booking`, `list_packages`, `get_credit_balances`, `send_invite`,
`list_invites`.

Protection: `get_protection_policy`, `set_protection_policy`,
`list_booking_charges`, `charge_no_show`, `waive_charge`.

Billing: `create_billing_plan`, `list_subscriptions`, `get_subscription`,
`pause_subscription`, `resume_subscription`, `cancel_subscription`.

Dashboard and payments: `get_dashboard`, `get_payments_overview`,
`record_payment`, `void_payment`, `create_charge`.

Roster, storefront, and film: `import_athletes`, `get_coach_page`, `list_clips`,
`get_clip_url`.

---

## Rate limits

- Per key: `rate_limit` requests per minute (default **60**), on both the REST
  and MCP surfaces, keyed by the key id.
- The rate-limit store is in-memory and resets on server deploy (acceptable for
  v1; a restart briefly widens the window).

## Security notes

- **Tenant isolation is absolute.** Every read and write is filtered by the
  key's `coach_id` server-side. A request for another coach's id returns `404`
  (reads) or `403 cross_tenant` (writes) — never another tenant's data.
- **Keys are hashed.** Only `sha256(key)` is stored, plus a short display prefix.
  The plaintext is returned once at mint time and never again. Losing it means
  minting a new one.
- **Revocation is immediate.** A revoked key authenticates nothing (`401`).
- **Audit log.** Every key-authed request records one `audit_log` row
  (method, path, status, ip, key, coach) for the owning coach to review.
- **Clip bytes remain private.** The API exposes tenant-scoped metadata and can
  mint the same short-lived signed URLs as the app. It never exposes the bucket
  publicly or accepts an arbitrary object path to sign.

## Errors

House style: JSON `{ "error": "…" }` with an honest status.

| Status | Meaning |
|--------|---------|
| 400 | Bad input (missing/invalid field) |
| 401 | Missing, invalid, or revoked key |
| 403 | `cross_tenant` — a write referencing another coach's row |
| 404 | Not found (includes cross-tenant read probes) |
| 409 | Conflict (e.g. cancelling a slot that is not booked) |
| 429 | Rate limit exceeded for this key |
| 503 | API not configured on the server (Supabase unset) |
