// lib/audit.js
//
// Append-only audit trail for the open API/MCP surface. One row per key-authed
// request (method, path, status, ip), keyed to the api_key and its coach. Wired
// via res.on('finish') so it records the FINAL status without touching the
// response path.
//
// POSTURE (mirrors notify.js exactly): logApiCall NEVER throws to its caller and
// tolerates the audit_log table being absent (a 404/any error is logged and
// swallowed). An audit write must never break or slow the API request that
// triggered it. Reads creds at call time; a no-op when Supabase is unconfigured.

function supabaseEnv() {
  return {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_KEY,
  };
}

/**
 * Record one API/MCP call. Best-effort, never throws.
 *
 * @param {object} args
 * @param {string|null} args.apiKeyId  the api_keys.id that authed the call (null if unknown).
 * @param {string}      args.coachId   tenant the call was scoped to (required to write a row).
 * @param {string}      args.method    HTTP method.
 * @param {string}      args.path      request path (query string stripped by the caller).
 * @param {number}      args.status    final HTTP status.
 * @param {string|null} [args.ip]      client ip (inet); null/invalid is fine (column is nullable).
 */
async function logApiCall({ apiKeyId, coachId, method, path, status, ip }) {
  try {
    if (!coachId) return; // no tenant -> nothing to attribute the row to.
    const { url, key } = supabaseEnv();
    if (!url || !key) return; // Supabase not configured -> nothing durable to write.

    const resp = await fetch(`${url}/rest/v1/audit_log`, {
      method: "POST",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify({
        api_key_id: apiKeyId || null,
        coach_id: coachId,
        method: method == null ? null : String(method).slice(0, 10),
        path: path == null ? null : String(path).slice(0, 512),
        status: Number.isInteger(status) ? status : null,
        // inet column: only send a value that looks like an address, else null.
        ip: isProbablyIp(ip) ? ip : null,
      }),
    });
    if (!resp.ok && resp.status !== 404) {
      // 404 = table missing (tolerated silently). Anything else, log once.
      console.error(
        "[audit] write non-ok:",
        resp.status,
        await resp.text().catch(() => ""),
      );
    }
  } catch (err) {
    // Network error / missing table / anything. Swallow — audit is best-effort.
    console.error("[audit] write threw (non-fatal):", err);
  }
}

// Loose guard so a garbage value never trips a Postgres inet type error (which
// would surface as a noisy non-ok). IPv4 dotted-quad or anything with a colon
// (IPv6) passes; everything else becomes null.
function isProbablyIp(v) {
  if (typeof v !== "string" || !v) return false;
  if (v.includes(":")) return true; // IPv6-ish
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(v);
}

/**
 * Attach an audit hook to a response. Call this AFTER the request has an authed
 * apiKey on it; it fires once when the response finishes, recording the final
 * status. Extracts a clean path (query string stripped).
 */
function auditOnFinish(req, res, { apiKeyId, coachId }) {
  let logged = false;
  res.on("finish", () => {
    if (logged) return;
    logged = true;
    const rawPath = req.originalUrl || req.url || "";
    const path = rawPath.split("?")[0];
    // req.ip is populated by Express (trust proxy is set); fall back to socket.
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || null;
    logApiCall({
      apiKeyId,
      coachId,
      method: req.method,
      path,
      status: res.statusCode,
      ip,
    });
  });
}

module.exports = { logApiCall, auditOnFinish };
