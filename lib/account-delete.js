// lib/account-delete.js
//
// D1 — in-app account deletion (Apple App Store 5.1.1(v), a hard requirement).
// Server-mediated on the token server, the ONLY place the Supabase service key
// lives, so it never ships in the app bundle. NOT flag-gated: this is a
// compliance feature and it acts ONLY on the authenticated caller.
//
// THE ONE IDENTITY EVER TOUCHED IS req user's own. The caller's uid comes
// EXCLUSIVELY from the verified JWT (requireSupabaseUser). No id is ever read
// from the request body — a hostile client cannot name another user to delete.
//
// Two lanes by role (derived the established way — user_metadata /
// app_metadata .role === "coach", same as /token and sendInvite):
//
//   ATHLETE caller: their claimed athlete CARD is the coach's business record,
//   so we only NULL athletes.user_id on it (the coach keeps the card, bookings
//   and purchases stay attached to it), clear the caller's own auth-user
//   references, delete the caller's push_tokens + notifications rows, then
//   delete the auth user. Nothing the coach owns is touched.
//
//   COACH caller: a full cascade of everything the coach owns, in a
//   dependency-safe order derived from the real FKs (migrations 0001-0012):
//   credit_deductions BEFORE package_purchases (the ledger FK is ON DELETE
//   RESTRICT), children before parents everywhere, storage objects for the
//   coach's clips where reachable, then the coach row, then the auth user.
//
// FAILURE POSTURE: a mid-cascade row-delete failure returns 500 and the auth
// user is NEVER deleted, so the caller can sign in and retry. Every delete is
// filtered and idempotent — a re-run no-ops the rows that are already gone and
// finishes the rest. Storage failures are NON-fatal (an orphaned private object
// is a warning, never a reason to strand an account Apple requires us to close).

// Private clips bucket (mirrors index.js). Objects live at "<room>/<file>"
// where <room> is normally a session id, sometimes an athlete id
// (app/(app)/athletes/[id].tsx falls back to the athlete id as the room).
const CLIPS_BUCKET = process.env.CLIPS_BUCKET || "clips-private";
const SIGN_MARK = `/object/sign/${CLIPS_BUCKET}/`;

// Read Supabase creds at CALL time (not module load), same as scheduling.js/
// notify.js, so a test that sets env before requiring index.js still sees them.
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

// Role from the VERIFIED user, exactly like /token and sendInvite. A coach is
// whoever the app marks as such; everyone else is an athlete. Never from the body.
function roleOf(user) {
  return user?.user_metadata?.role === "coach" ||
    user?.app_metadata?.role === "coach"
    ? "coach"
    : "athlete";
}

// Coach-owned tables to purge, CHILDREN BEFORE PARENTS, filtered by coach_id.
// Order derivation (migrations 0001/0002/0006/0009/0010/0011/0012):
//   - credit_deductions FIRST: its purchase_id FK is ON DELETE RESTRICT against
//     package_purchases, so the ledger MUST be gone before the purchases are.
//   - session children (notes/clips/drills/script/recaps) and athlete-facing
//     rows (messages/homework/videos/slots/invites/memberships) before their
//     sessions/athletes parents.
//   - packages after package_purchases (purchases.package_id is ON DELETE SET
//     NULL, so either order is safe; kept here for readability).
// Every other coach_id FK is ON DELETE CASCADE, so this explicit list only has
// to respect the single RESTRICT edge; the rest is defense in depth so a partial
// failure never leaves dangling children behind a gone parent.
const COACH_TABLES_BY_COACH_ID = [
  "credit_deductions", // RESTRICT vs package_purchases — must precede it
  "package_purchases",
  "booking_invites",
  "bookable_slots",
  "availability_windows",
  "group_members",
  "groups",
  "messages",
  "session_notes",
  "clip_markers",
  "drill_blocks",
  "script_items",
  "recaps",
  "homework",
  "videos",
  "athlete_claims",
  "sessions",
  "packages",
  "athletes",
];

// The coach's own notification backbone rows are keyed by user_id (auth.users),
// not coach_id. They are ON DELETE CASCADE from auth.users so the final auth-user
// delete would clear them anyway, but we purge them explicitly for a clean,
// idempotent cascade and so the coach's PII is gone before the account closes.
const USER_ID_TABLES = ["push_tokens", "notifications", "notification_log"];

// Auth-user references that are NOT cascade-cleared (plain `references
// auth.users(id)` = NO ACTION): athletes.user_id, athlete_claims.claimed_by,
// booking_invites.accepted_by. If any row still points at the caller's uid when
// we delete the auth user, the delete FAILS. We NULL them first (they are the
// coach's records — the caller's identity is removed, the record is kept).
const AUTH_REF_NULLS = [
  { table: "athletes", col: "user_id" },
  { table: "athlete_claims", col: "claimed_by" },
  { table: "booking_invites", col: "accepted_by" },
];

// ---- Supabase REST helpers (service role) ----------------------------------

// DELETE rows matching a filter. Idempotent: a filter that matches nothing
// returns 200/204 (no-op), so a re-run of a partially-completed cascade is safe.
async function sbDelete(s, table, filter) {
  const resp = await fetch(`${s.url}/rest/v1/${table}?${filter}`, {
    method: "DELETE",
    headers: { ...s.headers, prefer: "return=minimal" },
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    return { ok: false, status: resp.status, detail };
  }
  return { ok: true };
}

// PATCH a column to null for every row matching a filter. Used to release the
// caller's auth-user references before the account is closed.
async function sbNull(s, table, col, filter) {
  const resp = await fetch(`${s.url}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: { ...s.headers, prefer: "return=minimal" },
    body: JSON.stringify({ [col]: null }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    return { ok: false, status: resp.status, detail };
  }
  return { ok: true };
}

// GET a select. Returns an array (empty on any error — callers treat a failed
// read as "nothing to sweep" and record a warning, never abort the delete).
async function sbSelect(s, table, query) {
  try {
    const resp = await fetch(`${s.url}/rest/v1/${table}?${query}`, {
      headers: s.headers,
    });
    if (!resp.ok) return null;
    const rows = await resp.json().catch(() => null);
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

// Pull "<room>/<file>" out of a stored clips-private signed URL (same shape as
// lib/call/livekit.ts clipObjectPathFromUrl). Null for YouTube/Drive/other links.
function clipPathFromUrl(url) {
  if (typeof url !== "string") return null;
  const i = url.indexOf(SIGN_MARK);
  if (i === -1) return null;
  let tail = url.slice(i + SIGN_MARK.length);
  const q = tail.indexOf("?");
  if (q !== -1) tail = tail.slice(0, q);
  const parts = tail.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const room = safeDecode(parts[0]);
  const file = safeDecode(parts[parts.length - 1]);
  if (!room || !file) return null;
  return `${room}/${file}`;
}

function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

// List every object under a storage prefix (paginated). Returns
// { ok, names }. ok=false on a list error so the caller can warn.
async function storageList(s, bucket, prefix) {
  const names = [];
  let offset = 0;
  for (;;) {
    const resp = await fetch(`${s.url}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      headers: s.headers,
      body: JSON.stringify({
        prefix,
        limit: 1000,
        offset,
        sortBy: { column: "name", order: "asc" },
      }),
    });
    if (!resp.ok) return { ok: false, names };
    const objs = await resp.json().catch(() => []);
    if (!Array.isArray(objs) || objs.length === 0) break;
    for (const o of objs) {
      // Entries with a null id are sub-folders; clips are flat files.
      if (o && o.id) names.push(`${prefix}/${o.name}`);
    }
    if (objs.length < 1000) break;
    offset += objs.length;
  }
  return { ok: true, names };
}

// Remove a batch of storage objects. Returns true on success.
async function storageRemove(s, bucket, paths) {
  const resp = await fetch(`${s.url}/storage/v1/object/${bucket}`, {
    method: "DELETE",
    headers: s.headers,
    body: JSON.stringify({ prefixes: paths }),
  });
  return resp.ok;
}

// Delete the auth user via the GoTrue admin API (service key). Treats a 404 as
// success: the user is already gone, so a re-run after a prior partial delete is
// idempotent. Returns { ok, status, detail }.
async function adminDeleteUser(s, uid) {
  const resp = await fetch(`${s.url}/auth/v1/admin/users/${uid}`, {
    method: "DELETE",
    headers: { apikey: s.key, authorization: `Bearer ${s.key}` },
  });
  if (resp.ok || resp.status === 404) return { ok: true, status: resp.status };
  const detail = await resp.text().catch(() => "");
  return { ok: false, status: resp.status, detail };
}

// Sweep the coach's private clip objects. Best-effort: every failure is a
// warning, never fatal. Sources merged (same as the retired edge function):
//   (a) the coach's session ids (clips upload under a "<sessionId>/" prefix),
//   (b) the coach's athlete ids (the athlete-screen room fallback),
//   (c) paths parsed from the coach's videos.url rows (catches clips whose
//       session was deleted — videos.session_id goes null, the object stays).
async function sweepCoachStorage(s, uid, warnings) {
  const paths = new Set();

  const sessions = await sbSelect(s, "sessions", `coach_id=eq.${uid}&select=id`);
  if (sessions === null) warnings.push("could not list sessions for storage sweep");
  const athletes = await sbSelect(s, "athletes", `coach_id=eq.${uid}&select=id`);
  if (athletes === null) warnings.push("could not list athletes for storage sweep");
  const videos = await sbSelect(s, "videos", `coach_id=eq.${uid}&select=url`);
  if (videos === null) warnings.push("could not list videos for storage sweep");

  for (const v of videos || []) {
    const p = clipPathFromUrl(v && v.url);
    if (p) paths.add(p);
  }

  const prefixes = [
    ...(sessions || []).map((r) => r && r.id).filter(Boolean),
    ...(athletes || []).map((r) => r && r.id).filter(Boolean),
  ];
  for (const prefix of prefixes) {
    const listed = await storageList(s, CLIPS_BUCKET, prefix);
    if (!listed.ok) {
      warnings.push(`could not list clips under ${prefix}`);
      continue;
    }
    for (const name of listed.names) paths.add(name);
  }

  if (paths.size > 0) {
    const all = Array.from(paths);
    for (let i = 0; i < all.length; i += 100) {
      const batch = all.slice(i, i + 100);
      const removed = await storageRemove(s, CLIPS_BUCKET, batch);
      if (!removed) warnings.push(`could not remove ${batch.length} clip file(s)`);
    }
  }
}

// ---- handler factory -------------------------------------------------------

/**
 * Build the POST /account/delete handler. `requireSupabaseUser` is injected
 * (same shape as scheduling.js) so the route stays testable — tests mock
 * global.fetch and drive the real handler over an ephemeral port.
 *
 * @param {object} deps
 * @param {(req)=>Promise<{user?:object,error?:string,status?:number}>} deps.requireSupabaseUser
 */
function buildAccountDeleteHandler(deps) {
  const { requireSupabaseUser } = deps || {};

  return async function deleteAccount(req, res) {
    try {
      const s = sb();
      if (!s) {
        return res.status(503).json({ deleted: false, error: "account deletion not configured" });
      }

      // Identity comes ONLY from the verified JWT. The request body is never
      // read for a user id — a caller can never name another account to delete.
      const authd = await requireSupabaseUser(req);
      if (authd.error) {
        return res.status(authd.status || 401).json({ deleted: false, error: authd.error });
      }
      const uid = authd.user.id;
      const role = roleOf(authd.user);
      const warnings = [];

      if (role === "coach") {
        // --- 1. Storage first (non-fatal): the coach's private clip objects. --
        await sweepCoachStorage(s, uid, warnings);

        // --- 2. Rows, children before parents. FAIL-FAST before the auth user.
        // A single failure returns 500 with what failed and leaves the auth user
        // intact, so the coach can sign in and retry (idempotent re-run).
        for (const table of COACH_TABLES_BY_COACH_ID) {
          const r = await sbDelete(s, table, `coach_id=eq.${uid}`);
          if (!r.ok) {
            return res.status(500).json({
              deleted: false,
              error: "Some data could not be deleted. Nothing was finalized. Try again.",
              failed: `${table}: ${r.status}`,
              warnings,
            });
          }
        }
        // The coach's own notification backbone (user_id keyed).
        for (const table of USER_ID_TABLES) {
          const r = await sbDelete(s, table, `user_id=eq.${uid}`);
          if (!r.ok) {
            return res.status(500).json({
              deleted: false,
              error: "Some data could not be deleted. Nothing was finalized. Try again.",
              failed: `${table}: ${r.status}`,
              warnings,
            });
          }
        }
        // Release any NO-ACTION auth-user references the caller still holds (e.g.
        // a card THIS coach claimed in another coach's tenant) so the auth-user
        // delete cannot be blocked by a dangling FK.
        for (const { table, col } of AUTH_REF_NULLS) {
          const r = await sbNull(s, table, col, `${col}=eq.${uid}`);
          if (!r.ok) {
            return res.status(500).json({
              deleted: false,
              error: "Some data could not be deleted. Nothing was finalized. Try again.",
              failed: `${table}.${col}: ${r.status}`,
              warnings,
            });
          }
        }
        // The coach profile row. (Would cascade on the auth-user delete anyway,
        // but the brief closes it explicitly: rows, then coach row, then user.)
        const coachDel = await sbDelete(s, "coaches", `id=eq.${uid}`);
        if (!coachDel.ok) {
          return res.status(500).json({
            deleted: false,
            error: "Some data could not be deleted. Nothing was finalized. Try again.",
            failed: `coaches: ${coachDel.status}`,
            warnings,
          });
        }
      } else {
        // --- ATHLETE caller ---------------------------------------------------
        // The coach keeps the athlete CARD (their business record): only NULL the
        // caller's identity link on it, plus any other auth-user references the
        // caller holds. Bookings/purchases stay attached to the card.
        for (const { table, col } of AUTH_REF_NULLS) {
          const r = await sbNull(s, table, col, `${col}=eq.${uid}`);
          if (!r.ok) {
            return res.status(500).json({
              deleted: false,
              error: "Your account could not be closed. Nothing was finalized. Try again.",
              failed: `${table}.${col}: ${r.status}`,
              warnings,
            });
          }
        }
        // Delete the caller's OWN notification backbone rows (user_id keyed).
        for (const table of USER_ID_TABLES) {
          const r = await sbDelete(s, table, `user_id=eq.${uid}`);
          if (!r.ok) {
            return res.status(500).json({
              deleted: false,
              error: "Your account could not be closed. Nothing was finalized. Try again.",
              failed: `${table}: ${r.status}`,
              warnings,
            });
          }
        }
      }

      // --- Auth user LAST. Only reached when every step above succeeded. -------
      const del = await adminDeleteUser(s, uid);
      if (!del.ok) {
        return res.status(500).json({
          deleted: false,
          error: "Your data was removed but the account could not be closed. Try again.",
          warnings,
        });
      }

      res.json({ deleted: true, role, ...(warnings.length ? { warnings } : {}) });
    } catch (err) {
      console.error("[account-delete] failed:", err);
      res.status(500).json({ deleted: false, error: "account deletion failed" });
    }
  };
}

module.exports = {
  buildAccountDeleteHandler,
  // Pure helpers exported for unit tests + reuse.
  roleOf,
  clipPathFromUrl,
  COACH_TABLES_BY_COACH_ID,
  USER_ID_TABLES,
  AUTH_REF_NULLS,
};
