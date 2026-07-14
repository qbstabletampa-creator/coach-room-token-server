// lib/api-keys.js
//
// The open-API credential layer for CoachTime (build brief: feat/open-api-mcp).
// A coach mints a tenant-scoped API key from the app; the key authenticates the
// /api/v1 REST surface and the /mcp MCP endpoint, and every request is locked to
// the key's coach_id server-side.
//
// SECRET HANDLING (house rule): the plaintext key is returned to the caller
// EXACTLY ONCE at mint time and never persisted. Only sha256(key) is stored
// (api_keys.key_hash, UNIQUE) plus a short non-secret display prefix. A lookup
// hashes the presented Bearer and matches key_hash — the server never has the
// plaintext to leak.
//
// POSTURE (mirrors requireSupabaseUser + scheduling.js): read Supabase creds at
// CALL time; Supabase unconfigured -> 503 (not 500); a bad/absent/revoked key
// -> 401; these functions return { error, status } instead of throwing so the
// route decides the response. All Supabase access uses the SERVICE KEY (bypasses
// RLS); tenant isolation is manual and enforced by the callers.

const crypto = require("crypto");

// Read creds at call time so a test that sets env before requiring index.js
// still sees them (same as sb() in scheduling.js / notify.js).
function sb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return {
    url,
    key,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
  };
}

// Keys are "ctk_" + 32 random bytes as hex (64 hex chars). 128 bits of entropy
// in the random tail; the "ctk_" prefix makes a leaked key greppable/revocable.
const KEY_BYTES = 32;
const KEY_PREFIX = "ctk_";
// The stored display prefix: "ctk_" + first 8 hex of the tail (12 chars total).
// Non-secret, enough to tell two keys apart in a list without revealing the key.
const DISPLAY_PREFIX_LEN = KEY_PREFIX.length + 8;

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// Parse the Bearer token off an Authorization header. Returns "" when absent.
function bearerOf(req) {
  const auth = (req.headers && req.headers.authorization) || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

/**
 * Mint a new API key for a coach. Returns { key, id, prefix, name, ...} where
 * `key` is the PLAINTEXT — surface it to the coach once, then it is gone. On a
 * config/DB problem returns { error, status } (503 unconfigured, 502 write fail).
 * TENANT: the row is written with the caller's coachId; the caller must have
 * proven that coachId (coach JWT) before calling this.
 */
async function mintApiKey({ coachId, name }) {
  const s = sb();
  if (!s) return { error: "api not configured", status: 503 };
  if (!coachId) return { error: "coach required", status: 401 };

  const key = KEY_PREFIX + crypto.randomBytes(KEY_BYTES).toString("hex");
  const keyHash = sha256Hex(key);
  const keyPrefix = key.slice(0, DISPLAY_PREFIX_LEN);
  const cleanName =
    typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : "API key";

  const resp = await fetch(`${s.url}/rest/v1/api_keys`, {
    method: "POST",
    headers: { ...s.headers, prefer: "return=representation" },
    body: JSON.stringify({
      coach_id: coachId,
      name: cleanName,
      key_hash: keyHash,
      key_prefix: keyPrefix,
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error("[api-keys] mint failed:", resp.status, detail);
    return { error: "could not create key", status: 502 };
  }
  const rows = await resp.json().catch(() => []);
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!row) return { error: "could not create key", status: 502 };

  return {
    key, // PLAINTEXT — shown once, never stored
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    rate_limit: row.rate_limit,
    scopes: row.scopes || [],
    created_at: row.created_at,
  };
}

/**
 * Revoke a key. TENANT-LOCKED: the filter pins coach_id, so a coach can only
 * revoke their OWN key — a foreign keyId matches 0 rows -> { revoked: false }.
 * Idempotent-ish: only flips rows where revoked_at is still null.
 */
async function revokeApiKey({ coachId, keyId }) {
  const s = sb();
  if (!s) return { error: "api not configured", status: 503 };
  if (!coachId) return { error: "coach required", status: 401 };
  if (!keyId) return { error: "keyId required", status: 400 };

  const resp = await fetch(
    `${s.url}/rest/v1/api_keys` +
      `?id=eq.${encodeURIComponent(keyId)}` +
      `&coach_id=eq.${encodeURIComponent(coachId)}` +
      `&revoked_at=is.null`,
    {
      method: "PATCH",
      headers: { ...s.headers, prefer: "return=representation" },
      body: JSON.stringify({ revoked_at: new Date().toISOString() }),
    },
  );
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error("[api-keys] revoke failed:", resp.status, detail);
    return { error: "could not revoke key", status: 502 };
  }
  const rows = await resp.json().catch(() => []);
  return { revoked: Array.isArray(rows) && rows.length > 0, keyId };
}

/**
 * List a coach's keys (metadata only — NEVER the hash, NEVER the plaintext).
 * TENANT-LOCKED to coachId. Returns { keys: [...] } or { error, status }.
 */
async function listApiKeys({ coachId }) {
  const s = sb();
  if (!s) return { error: "api not configured", status: 503 };
  if (!coachId) return { error: "coach required", status: 401 };

  const resp = await fetch(
    `${s.url}/rest/v1/api_keys` +
      `?coach_id=eq.${encodeURIComponent(coachId)}` +
      `&select=id,name,key_prefix,rate_limit,scopes,created_at,last_used_at,revoked_at` +
      `&order=created_at.desc`,
    { headers: s.headers },
  );
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error("[api-keys] list failed:", resp.status, detail);
    return { error: "could not list keys", status: 502 };
  }
  const rows = await resp.json().catch(() => []);
  return { keys: Array.isArray(rows) ? rows : [] };
}

/**
 * Authenticate an inbound API/MCP request by its Bearer key. Hashes the
 * presented key, looks up a NON-revoked api_keys row by key_hash, and returns
 * { apiKey: { id, coachId, rateLimit, scopes } } on success. House-style
 * failures (never throws for the expected cases):
 *   - Supabase unconfigured -> { error, status: 503 }
 *   - missing/blank Bearer   -> { error, status: 401 }
 *   - no matching live key   -> { error, status: 401 }
 * On success, fires a fire-and-forget last_used_at bump (best-effort; a failure
 * there never affects the request).
 */
async function requireApiKey(req) {
  const s = sb();
  if (!s) return { error: "api not configured", status: 503 };

  const presented = bearerOf(req);
  if (!presented) return { error: "api key required", status: 401 };

  const keyHash = sha256Hex(presented);
  const resp = await fetch(
    `${s.url}/rest/v1/api_keys` +
      `?key_hash=eq.${encodeURIComponent(keyHash)}` +
      `&revoked_at=is.null` +
      `&select=id,coach_id,rate_limit,scopes&limit=1`,
    { headers: s.headers },
  );
  if (!resp.ok) {
    // A missing table or any lookup error is an auth failure, not a 500: the
    // caller cannot be authenticated, so reject cleanly.
    const detail = await resp.text().catch(() => "");
    console.error("[api-keys] lookup non-ok:", resp.status, detail);
    return { error: "invalid api key", status: 401 };
  }
  const rows = await resp.json().catch(() => []);
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!row) return { error: "invalid api key", status: 401 };

  // Fire-and-forget last_used_at bump. Never awaited into the request path.
  bumpLastUsed(s, row.id);

  return {
    apiKey: {
      id: row.id,
      coachId: row.coach_id,
      rateLimit: Number(row.rate_limit) || 60,
      scopes: Array.isArray(row.scopes) ? row.scopes : [],
    },
  };
}

// Best-effort last_used_at update. Swallows everything — a telemetry write must
// never break or slow an authed request.
function bumpLastUsed(s, keyId) {
  try {
    fetch(`${s.url}/rest/v1/api_keys?id=eq.${encodeURIComponent(keyId)}`, {
      method: "PATCH",
      headers: { ...s.headers, prefer: "return=minimal" },
      body: JSON.stringify({ last_used_at: new Date().toISOString() }),
    }).catch(() => {});
  } catch {
    /* never throws */
  }
}

module.exports = {
  mintApiKey,
  revokeApiKey,
  listApiKeys,
  requireApiKey,
  // exported for tests
  sha256Hex,
};
