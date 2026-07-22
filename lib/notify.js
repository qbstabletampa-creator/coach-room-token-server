// lib/notify.js
//
// THE notification chokepoint for CoachTime, ported from little-soles'
// ls-api/src/lib/notify.ts to this stack (CommonJS, Supabase REST via fetch —
// NOT Prisma). Every future event (session booked, clip ready, payment
// confirmed) calls notify() and nothing else. One function, three channels,
// fanned out in a fixed order:
//
//   1. IN-APP  — durable `notifications` row via Supabase REST. Source of truth
//                + where idempotency lives (UNIQUE(user_id, type, dedupe_key)).
//   2. EMAIL   — Resend transactional email, ONLY when RESEND_API_KEY is set
//                (graceful no-op otherwise).
//   3. PUSH    — Expo push to EVERY token in the user's `push_tokens` rows.
//
// Two hard guarantees, identical to the original:
//   - notify() NEVER throws to its caller. A notification must never break the
//     business action that triggered it.
//   - Each channel is isolated in its own try/catch, so one failing channel
//     (Supabase down, Resend 500, Expo timeout) never blocks the others.
//
// Idempotency: when `dedupeKey` is supplied, (user_id, type, dedupe_key) is
// unique. If a row already exists (pre-check hit, or the insert loses the race
// with a 409 unique violation) we return EARLY — no second email, no second
// push — so a retried/duplicated event fires the user exactly once.
//
// Tolerance: the `notifications` / `push_tokens` tables may not exist yet in a
// given environment. Every Supabase call is wrapped so a 404 (missing table) or
// any error is caught + logged, and the other channels still run.

const { eventEmailHtml, buildPlainText, sendTransactionalEmail } = require("./email-shell");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// PostgREST returns 23505 for a unique-constraint violation (the idempotency
// race: two callers insert the same (user_id,type,dedupe_key)). The loser sees
// this — which is success, not failure: the row already exists.
const PG_UNIQUE_VIOLATION = "23505";

// Read Supabase creds at CALL time (not module load) so a test that sets env
// before requiring index.js -> notify still sees them.
function supabaseEnv() {
  return {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_KEY,
  };
}

/**
 * Fire a notification across all channels. Never throws.
 *
 * @param {object} args
 * @param {string} args.userId   Supabase auth user id (owner of the row/devices).
 * @param {string} args.type     event type slug (e.g. "session.booked").
 * @param {string} args.title    short heading (push title + email H1).
 * @param {string} args.body     one-line body (push body + email paragraph).
 * @param {object} [args.data]   free-form deep-link payload, stored + pushed.
 * @param {string} [args.dedupeKey]  when set, de-dupes on (userId,type,dedupeKey).
 * @param {string} [args.email]  recipient inbox for the email channel. Optional;
 *                               when absent the email channel is skipped (we do
 *                               not force a users-table lookup this stack may not
 *                               have — callers that know the email pass it).
 */
async function notify(args) {
  try {
    const { userId, type, title, body, data, dedupeKey, email } = args || {};
    if (!userId || !type) {
      console.error("[notify] missing userId/type, skipping:", { userId, type });
      return;
    }

    // ---- Channel 1: IN-APP (also the idempotency gate) --------------------
    // Returns true when we should STOP (already delivered), false to continue.
    const alreadyDelivered = await writeInAppRow({
      userId,
      type,
      title,
      body,
      data,
      dedupeKey,
    });
    if (alreadyDelivered) return; // idempotent: no re-send of email/push.

    // ---- Channel 2: EMAIL -------------------------------------------------
    try {
      if (email) {
        await sendTransactionalEmail({
          to: email,
          subject: title,
          html: eventEmailHtml(title, body),
          text: buildPlainText([title, "", body]),
        });
      }
    } catch (err) {
      console.error("[notify] email channel failed:", err);
    }

    // ---- Channel 3: PUSH (Expo) -------------------------------------------
    try {
      await sendExpoPush(userId, title, body, data);
    } catch (err) {
      console.error("[notify] push channel failed:", err);
    }
  } catch (err) {
    // Belt over the suspenders: nothing above should escape, but if anything
    // does, swallow it here. notify() must never throw to its caller.
    console.error("[notify] unexpected failure:", err);
  }
}

// Write the durable in-app row and enforce idempotency. Returns true when the
// event was ALREADY delivered (a matching dedupe row exists / a 409 race) so
// the caller skips email + push. Returns false to proceed. Never throws:
// a missing table or any Supabase error is logged and we proceed best-effort.
async function writeInAppRow({ userId, type, title, body, data, dedupeKey }) {
  const { url, key } = supabaseEnv();
  if (!url || !key) {
    // No Supabase configured — nothing durable to write, but the other channels
    // (email/push) may still be usable. Proceed.
    return false;
  }
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };

  try {
    // Fast path: if a dedupeKey is set and a row already exists, this event
    // already fired. Skip everything.
    if (dedupeKey) {
      const q =
        `${url}/rest/v1/notifications` +
        `?user_id=eq.${encodeURIComponent(userId)}` +
        `&type=eq.${encodeURIComponent(type)}` +
        `&dedupe_key=eq.${encodeURIComponent(dedupeKey)}` +
        `&select=id&limit=1`;
      const existing = await fetch(q, { headers });
      if (existing.ok) {
        const rows = await existing.json().catch(() => []);
        if (Array.isArray(rows) && rows.length > 0) {
          return true; // already delivered.
        }
      } else if (existing.status !== 404) {
        // 404 = table missing (tolerated). Any other non-ok is logged; we still
        // attempt the insert below (which will surface the real error).
        console.error(
          "[notify] in-app dedupe check non-ok:",
          existing.status,
          await existing.text().catch(() => ""),
        );
      }
    }

    // Insert the durable row. `Prefer: return=minimal` — we don't need the row
    // back, just the status. A 409 means the unique index rejected a duplicate
    // (idempotency race): treat as already-delivered.
    const insert = await fetch(`${url}/rest/v1/notifications`, {
      method: "POST",
      headers: { ...headers, prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: userId,
        type,
        title: title == null ? null : String(title),
        body: body == null ? null : String(body),
        // notifications.data is NOT NULL — a null here 23502s the whole in-app
        // write (refund alerts were silently lost, 2026-07-22 e2e minor #1).
        data: data == null ? {} : data,
        dedupe_key: dedupeKey == null ? null : dedupeKey,
      }),
    });

    if (insert.status === 409) {
      // Lost the race on the unique index (or a redelivered dedupe): already
      // delivered. Stop so we don't double-send email/push.
      return true;
    }
    if (insert.status === 201 || insert.status === 200 || insert.ok) {
      return false; // fresh row created — proceed to email/push.
    }

    // Any other status: a duplicate reported as a body-level PostgREST error, a
    // missing table (404), or a schema hiccup. Inspect the body for the unique
    // violation code so an idempotency race surfaced as a 400 still stops us.
    const detail = await insert.text().catch(() => "");
    if (detail && detail.includes(PG_UNIQUE_VIOLATION)) {
      return true; // unique violation reported in the body — already delivered.
    }
    console.error("[notify] in-app write failed:", insert.status, detail);
    // Fall through best-effort: still attempt email/push so the user is not
    // left with zero signal because of one bad channel.
    return false;
  } catch (err) {
    // Network error / table missing / anything. Log and proceed best-effort.
    console.error("[notify] in-app write threw:", err);
    return false;
  }
}

/**
 * Send an Expo push to ALL of a user's registered devices. Graceful no-op when
 * the user has no tokens (the normal case today). Reads tokens from the
 * `push_tokens` table (user_id, token) via Supabase REST. Never throws past the
 * caller's try/catch; tolerates a missing table.
 */
async function sendExpoPush(userId, title, body, data) {
  const { url, key } = supabaseEnv();
  if (!url || !key) return; // no Supabase — no tokens to read.

  let tokens = [];
  const q =
    `${url}/rest/v1/push_tokens` +
    `?user_id=eq.${encodeURIComponent(userId)}` +
    `&select=token`;
  const resp = await fetch(q, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (!resp.ok) {
    if (resp.status !== 404) {
      console.error("[notify] push token lookup non-ok:", resp.status);
    }
    return; // table missing or lookup failed — nothing to send.
  }
  const rows = await resp.json().catch(() => []);
  tokens = (Array.isArray(rows) ? rows : [])
    .map((r) => r && r.token)
    .filter((t) => typeof t === "string" && t.length > 0);

  if (tokens.length === 0) return; // no devices — expected in dev.

  // One message per token. Expo accepts an array of messages in a single POST.
  const messages = tokens.map((t) => ({
    to: t,
    title,
    body,
    sound: "default",
    data: data || {},
  }));

  const res = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(messages),
  });
  if (!res.ok) {
    console.error(`[notify] Expo push HTTP ${res.status}`);
  }
}

module.exports = { notify };
