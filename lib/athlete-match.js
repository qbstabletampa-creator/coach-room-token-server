// lib/athlete-match.js
//
// Shared "match-or-create an athlete by buyer/guest email IN ONE COACH'S TENANT"
// logic. Extracted from lib/stripe-webhook.js so the Stripe buy-first funnel and
// the storefront guest-booking lane (lib/storefront.js) resolve an athlete the
// SAME way: case-insensitive email match scoped to the coach, and on a miss a new
// athlete CARD (never a Supabase auth user — the /claim tap is the magic link).
//
// Tenant isolation is the whole point: the match query pins coach_id, so a buyer
// whose email exists under a DIFFERENT coach is NEVER linked here — they get a
// fresh card in THIS coach's tenant. That keeps rosters from bleeding across
// coaches (a parent who trains with two coaches is two separate athlete cards).
//
// Every call takes the shared `s` accessor ({ url, key, headers }) the other libs
// build (scheduling.js sb(), stripe-webhook.js sb()). Reads/creates FAIL SOFT:
// on any error we return null so the caller degrades gracefully (the webhook
// still records the purchase; the guest booking still books the slot).

// The e-mail local part, a friendly fallback name when none is supplied.
function emailLocalPart(email) {
  const at = String(email).indexOf("@");
  return at > 0 ? String(email).slice(0, at) : String(email);
}

// Match the email to an existing athlete IN THIS COACH'S TENANT. Case-insensitive:
// the caller normalizes the email to lowercase and athletes are created lowercased
// here, so eq is a stable match. coach_id in the filter is the tenant lock — a
// same-email athlete under another coach never matches. Returns { id, user_id } or null.
async function findAthleteByEmail(s, { coachId, email }) {
  try {
    const resp = await fetch(
      `${s.url}/rest/v1/athletes?coach_id=eq.${coachId}` +
        `&parent_email=eq.${encodeURIComponent(email)}&select=id,user_id&limit=1`,
      { headers: s.headers },
    );
    if (!resp.ok) return null;
    const rows = await resp.json().catch(() => []);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (err) {
    console.error("[athlete-match] athlete match failed:", err);
    return null;
  }
}

// True when a PostgREST error body means the `source` column isn't there yet:
// 42703 = undefined_column (migration 0016 not applied), PGRST204 = schema cache
// has no such column. Either one means "retry the insert without source" so a
// live booking/purchase lane never breaks on the forward-only source stamp.
function isMissingSourceError(bodyText) {
  const d = String(bodyText || "");
  return d.includes("42703") || d.includes("PGRST204");
}

// Create an athlete card for this coach from the email (buy-first / lead funnel).
// We do NOT create a Supabase auth user — the /claim tap does that (that IS the
// magic link). `source` stamps acquisition (0016, default 'manual'); omit it and
// the DB default holds. FAIL-SOFT on the source column: if 0016 isn't applied yet
// the stamped insert 400s (42703/PGRST204), so we retry WITHOUT source rather than
// break the live lane. Returns { id } or null.
async function createAthlete(s, { coachId, name, email, source }) {
  const base = { coach_id: coachId, name, parent_email: email };
  const post = (body) =>
    fetch(`${s.url}/rest/v1/athletes`, {
      method: "POST",
      headers: { ...s.headers, prefer: "return=representation" },
      body: JSON.stringify(body),
    });
  try {
    let resp = await post(source ? { ...base, source } : base);
    if (!resp.ok && source) {
      // Only the source column can be the culprit for a stamped insert; if that
      // is what failed, drop it and try again so the athlete still gets created.
      const detail = await resp.text().catch(() => "");
      if (isMissingSourceError(detail)) {
        resp = await post(base);
      } else {
        console.error("[athlete-match] athlete create non-ok:", resp.status, detail);
        return null;
      }
    }
    if (!resp.ok) {
      console.error("[athlete-match] athlete create non-ok:", resp.status);
      return null;
    }
    const rows = await resp.json().catch(() => []);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (err) {
    console.error("[athlete-match] athlete create failed:", err);
    return null;
  }
}

// Resolve the email to an athlete in this coach's tenant: match one, else create
// one from the email (falling back to the email local part for a display name).
// Returns { athleteId, userId, created } or null on hard failure. `userId` is the
// matched athlete's auth user (null when unclaimed or freshly created), which the
// caller uses to decide whether to offer a claim. `source` stamps only the CREATE
// path — a MATCH never re-stamps an existing athlete.
async function matchOrCreateAthlete(s, { coachId, email, name, source }) {
  const matched = await findAthleteByEmail(s, { coachId, email });
  if (matched) {
    return { athleteId: matched.id, userId: matched.user_id ?? null, created: false };
  }
  const displayName = (name && String(name).trim()) || emailLocalPart(email);
  const created = await createAthlete(s, { coachId, name: displayName, email, source });
  if (!created) return null;
  return { athleteId: created.id, userId: null, created: true };
}

module.exports = {
  emailLocalPart,
  findAthleteByEmail,
  createAthlete,
  matchOrCreateAthlete,
  isMissingSourceError,
};
