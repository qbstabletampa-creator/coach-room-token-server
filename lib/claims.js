// lib/claims.js
//
// Shared athlete-claim minting for the D19 progressive-account wave. The ACCOUNT
// mechanism IS the existing athlete_claims flow (index.js GET/POST /claim/:token):
// a single-use, 14-day token an athlete taps to bind athletes.user_id — no signup
// wall, magic link only. The coach mints one today (coach-room-app cloud.ts
// mintAthleteClaim: insert { coach_id, athlete_id }, letting the DB default the
// token + expires_at). D19 adds two more places that offer that SAME claim: the
// booking touchpoint (lib/scheduling.js) and the Stripe webhook
// (lib/stripe-webhook.js). This module centralizes "reuse an existing unexpired
// unclaimed claim for an athlete, else mint one" so both new touchpoints stay
// byte-identical to the coach-side mint and never spray duplicate rows.
//
// Every function takes the shared `s` accessor ({ url, key, headers }) the other
// libs build (scheduling.js sb(), stripe-webhook.js sb()). All calls FAIL SOFT —
// a claim-offer hiccup must never unwind a paid booking or a payment. On any
// error we return null, which the callers read as "no claim URL to surface."

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// The athlete claim URL that index.js /claim/:token serves. /claim and /book ride
// the SAME token-server origin, so the booking base is the correct base here too.
function claimUrl(base, token) {
  const b = String(base || "").replace(/\/+$/, "");
  return `${b}/claim/${token}`;
}

// Find a reusable claim for an athlete: unclaimed AND unexpired, newest first.
// Returns a token or null. Read-only; never throws (a miss just means "mint one").
async function findReusableClaim(s, athleteId) {
  try {
    const nowIso = new Date().toISOString();
    const resp = await fetch(
      `${s.url}/rest/v1/athlete_claims?athlete_id=eq.${athleteId}` +
        `&claimed_at=is.null&expires_at=gt.${encodeURIComponent(nowIso)}` +
        `&select=token&order=created_at.desc&limit=1`,
      { headers: s.headers },
    );
    if (!resp.ok) return null;
    const rows = await resp.json().catch(() => []);
    return Array.isArray(rows) && rows[0] && rows[0].token ? rows[0].token : null;
  } catch (err) {
    console.error("[claims] findReusableClaim failed (non-fatal):", err);
    return null;
  }
}

// Mint a fresh claim row for (coach, athlete), IDENTICAL shape to the coach-side
// mint: insert { coach_id, athlete_id } and let the DB default the token + the
// 14-day expires_at. Returns the token or null.
async function mintClaim(s, { coachId, athleteId }) {
  try {
    const resp = await fetch(`${s.url}/rest/v1/athlete_claims`, {
      method: "POST",
      headers: { ...s.headers, prefer: "return=representation" },
      body: JSON.stringify({ coach_id: coachId, athlete_id: athleteId }),
    });
    if (!resp.ok) {
      console.error("[claims] mintClaim non-ok:", resp.status);
      return null;
    }
    const rows = await resp.json().catch(() => []);
    return Array.isArray(rows) && rows[0] && rows[0].token ? rows[0].token : null;
  } catch (err) {
    console.error("[claims] mintClaim failed (non-fatal):", err);
    return null;
  }
}

// Reuse-or-mint the athlete's claim (the progressive-account offer). Returns a
// token or null. Reusing keeps a single live invite per athlete, so re-touching a
// portal-worthy moment (a second booking, a second purchase) never sprays
// duplicate claim rows.
async function mintOrReuseClaim(s, { coachId, athleteId }) {
  if (!s || !coachId || !athleteId || !UUID_RE.test(String(athleteId))) return null;
  const existing = await findReusableClaim(s, athleteId);
  if (existing) return existing;
  return mintClaim(s, { coachId, athleteId });
}

module.exports = { claimUrl, findReusableClaim, mintClaim, mintOrReuseClaim };
