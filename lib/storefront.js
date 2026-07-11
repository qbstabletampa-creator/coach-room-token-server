// lib/storefront.js
//
// The public coach storefront (steal inventory #1, SoloCoach teardown 2026-07-11):
// a shareable page at /coach/<slug> where a NEW lead can see the coach, the menu
// of session types, the next open times, and book with just a name + email — no
// account, no invite link, no paywall. This is the discovery lane; the invite
// token lane (book.html) stays for existing athletes.
//
// All three routes live behind SCHEDULING_ENABLED in index.js and are served by
// the SERVICE ROLE (no anon Supabase policy exists on these rows, by design):
//   GET  /coach/:slug            -> public/coach.html (only when the slug exists)
//   GET  /coach/:slug/data       -> sanitized JSON (no email/phone/keys)
//   POST /coach/:slug/book-guest -> match-or-create the athlete IN THIS TENANT,
//                                   atomically claim the slot (no credit burned),
//                                   mint/reuse a claim, fire the .ics email.
//
// PM default (build brief): a new lead NEVER hits a paywall. Guest booking books
// the slot with ZERO credit deduction — the invite lane keeps its credit gate,
// the storefront lane is a free front door. Atomicity is the same conditional
// PATCH gate bookSlot uses (status=eq.open), so a double-book race yields 409.

const path = require("path");
const { mintOrReuseClaim, claimUrl } = require("./claims");
const { matchOrCreateAthlete } = require("./athlete-match");
const { resolveSessionType, fireBookingNotifications } = require("./scheduling");

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Public handle: lowercase letters/digits/hyphens, 1-40 chars, no leading/trailing
// hyphen. Matches the lowercase-enforced coaches.slug (migration 0013) and is safe
// to interpolate into a PostgREST eq filter (only [a-z0-9-]).
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// Loose email shape: something@something.tld. Not RFC-perfect on purpose — it just
// rejects obvious junk before we lowercase + use it as the tenant match key.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// How many upcoming open slots the public page shows. Enough to feel alive, few
// enough to keep the payload tight.
const OPEN_SLOTS_LIMIT = 20;

// Read Supabase creds at CALL time (same posture as scheduling.js / notify.js) so
// a test that sets env before requiring index.js still sees them.
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

async function sbGet(s, pathWithQuery) {
  const resp = await fetch(`${s.url}/rest/v1/${pathWithQuery}`, { headers: s.headers });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`supabase GET ${resp.status}: ${detail}`);
  }
  return resp.json().catch(() => []);
}

async function sbPatch(s, pathWithQuery, body, { representation = true } = {}) {
  const resp = await fetch(`${s.url}/rest/v1/${pathWithQuery}`, {
    method: "PATCH",
    headers: {
      ...s.headers,
      prefer: representation ? "return=representation" : "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`supabase PATCH ${resp.status}: ${detail}`);
  }
  if (!representation) return null;
  return resp.json().catch(() => []);
}

async function sbPost(s, table, body, { representation = true } = {}) {
  const resp = await fetch(`${s.url}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      ...s.headers,
      prefer: representation ? "return=representation" : "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`supabase POST ${resp.status}: ${detail}`);
  }
  if (!representation) return null;
  return resp.json().catch(() => []);
}

// Look up a coach by public slug. Returns the row (id + storefront fields) or null.
async function lookupCoachBySlug(s, slug) {
  const rows = await sbGet(
    s,
    `coaches?slug=eq.${slug}` +
      `&select=id,full_name,business,disciplines,bio,city&limit=1`,
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// The public JSON view of a coach: ONLY the fields the storefront renders. No
// email, no phone, no booking_url/payment_url, no coach id — nothing an anon
// visitor should not see. The guest booking resolves the coach by slug
// server-side, so the client never needs the coach id.
function sanitizeCoach(coach) {
  return {
    name: coach.full_name || "Coach",
    business: coach.business || null,
    disciplines: Array.isArray(coach.disciplines) ? coach.disciplines : [],
    bio: coach.bio || null,
    city: coach.city || null,
  };
}

function buildStorefrontHandlers(deps) {
  const {
    notify,
    getBookBaseUrl = () =>
      process.env.SCHEDULING_PUBLIC_URL || "https://coachtime.app",
  } = deps || {};

  // GET /coach/:slug — serve the storefront page ONLY when the slug resolves to a
  // real coach (a real 404 for unknown handles, not a soft JS one — better for
  // sharing + search). The static coach.html then fetches /coach/:slug/data for
  // the full payload. A bad slug format or unknown coach -> friendly 404 page.
  async function getCoachPage(req, res) {
    try {
      const slug = String(req.params.slug || "").toLowerCase();
      if (!SLUG_RE.test(slug)) {
        return res.status(404).type("html").send(notFoundPage());
      }
      const s = sb();
      if (!s) return res.status(404).type("html").send(notFoundPage());
      const coach = await lookupCoachBySlug(s, slug).catch(() => null);
      if (!coach) return res.status(404).type("html").send(notFoundPage());
      res.sendFile(path.join(__dirname, "..", "public", "coach.html"));
    } catch (err) {
      console.error("[storefront] getCoachPage failed:", err);
      res.status(404).type("html").send(notFoundPage());
    }
  }

  // GET /coach/:slug/data — the sanitized JSON the page renders from.
  async function getCoachData(req, res) {
    try {
      const s = sb();
      if (!s) return res.status(503).json({ error: "storefront not configured" });
      const slug = String(req.params.slug || "").toLowerCase();
      if (!SLUG_RE.test(slug)) return res.status(404).json({ error: "not found" });

      const coach = await lookupCoachBySlug(s, slug);
      if (!coach) return res.status(404).json({ error: "not found" });

      const sessionTypes = await sbGet(
        s,
        `session_types?coach_id=eq.${coach.id}&active=is.true` +
          `&select=id,name,duration_min,price_cents,description&order=sort.asc,created_at.asc`,
      );

      const nowIso = new Date().toISOString();
      const openSlots = await sbGet(
        s,
        `bookable_slots?coach_id=eq.${coach.id}&status=eq.open` +
          `&starts_at=gt.${encodeURIComponent(nowIso)}` +
          `&select=id,starts_at,ends_at,timezone,title` +
          `&order=starts_at.asc&limit=${OPEN_SLOTS_LIMIT}`,
      );

      res.json({
        coach: sanitizeCoach(coach),
        session_types: Array.isArray(sessionTypes) ? sessionTypes : [],
        open_slots: Array.isArray(openSlots) ? openSlots : [],
      });
    } catch (err) {
      console.error("[storefront] getCoachData failed:", err);
      res.status(500).json({ error: "could not load coach" });
    }
  }

  // POST /coach/:slug/book-guest { slot_id, session_type_id?, name, email }
  // The zero-friction front door: no account, no credit. Match-or-create the
  // athlete in THIS coach's tenant, atomically claim the slot, mint/reuse a claim,
  // fire the confirmation .ics email. 409 on a slot race.
  async function bookGuest(req, res) {
    try {
      const s = sb();
      if (!s) return res.status(503).json({ error: "storefront not configured" });
      const slug = String(req.params.slug || "").toLowerCase();
      if (!SLUG_RE.test(slug)) return res.status(404).json({ error: "not found" });

      const body = req.body || {};
      const slotId = body.slot_id ? String(body.slot_id) : "";
      if (!UUID_RE.test(slotId)) {
        return res.status(400).json({ error: "slot_id is required" });
      }
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return res.status(400).json({ error: "name is required" });
      const rawEmail = typeof body.email === "string" ? body.email.trim() : "";
      if (!EMAIL_RE.test(rawEmail)) {
        return res.status(400).json({ error: "a valid email is required" });
      }
      const email = rawEmail.toLowerCase();
      const requestedTypeId = body.session_type_id ? String(body.session_type_id) : null;

      // Resolve the coach by slug (the tenant every write is scoped to).
      const coach = await lookupCoachBySlug(s, slug);
      if (!coach) return res.status(404).json({ error: "not found" });
      const coachId = coach.id;

      // Only a type this coach actually owns + has active is recorded (cross-tenant
      // or stray ids drop to null; the booking still goes through).
      const sessionTypeId = await resolveSessionType(s, { coachId, sessionTypeId: requestedTypeId });

      // Match-or-create the athlete IN THIS TENANT. A same-email athlete under a
      // DIFFERENT coach never links here (findAthleteByEmail pins coach_id), so a
      // lead who trains with two coaches gets a separate card per coach.
      const resolved = await matchOrCreateAthlete(s, { coachId, email, name });
      if (!resolved) {
        return res.status(500).json({ error: "could not create your profile" });
      }
      const { athleteId, userId } = resolved;

      // ---- Gate: atomically claim the slot (open -> booked). NO credit ---------
      // status=eq.open is the concurrency gate: exactly one racing booker flips it,
      // the rest match 0 rows and get 409. The guest lane deducts NO credit (PM
      // default: a new lead never hits a paywall), so there is no FIFO step here.
      const claimed = await sbPatch(
        s,
        `bookable_slots?id=eq.${slotId}&coach_id=eq.${coachId}&status=eq.open`,
        {
          status: "booked",
          booked_by: athleteId,
          booked_at: new Date().toISOString(),
          session_type_id: sessionTypeId,
        },
      );
      if (!Array.isArray(claimed) || claimed.length === 0) {
        return res.status(409).json({ error: "slot_unavailable" });
      }
      const slot = claimed[0];

      // ---- Linked film session (non-fatal), wired onto the slot ---------------
      try {
        const created = await sbPost(s, "sessions", {
          coach_id: coachId,
          athlete_id: athleteId,
          title: slot.title || "Live coaching session",
          status: "planned",
        });
        const sessionId = Array.isArray(created) && created[0] ? created[0].id : null;
        if (sessionId) {
          await sbPatch(
            s,
            `bookable_slots?id=eq.${slotId}`,
            { session_id: sessionId },
            { representation: false },
          );
        }
      } catch (err) {
        console.error("[storefront] guest session create (non-fatal):", err);
      }

      // ---- Progressive account: offer a claim when the athlete is unclaimed ----
      // A brand-new lead (created) or a matched-but-unclaimed athlete (user_id
      // null) gets the claim link; an already-claimed athlete gets none. Fail-soft:
      // a claim hiccup never unwinds the booking (claim_url stays null).
      let claimUrlOut = null;
      if (userId == null) {
        const claimToken = await mintOrReuseClaim(s, { coachId, athleteId }).catch(() => null);
        if (claimToken) claimUrlOut = claimUrl(getBookBaseUrl(), claimToken);
      }

      // ---- Notify the coach + email the guest the .ics + calendar links -------
      // The guest lane has no invite token, so it passes an explicit bookUrl (the
      // public coach page) for the email's "session link".
      const pseudoInvite = {
        coach_id: coachId,
        athlete_id: athleteId,
        token: null,
        email,
        coaches: { full_name: coach.full_name },
        athletes: { name, parent_email: email, user_id: userId },
      };
      await fireBookingNotifications({
        notify,
        getBookBaseUrl,
        invite: pseudoInvite,
        slot,
        claimUrl: claimUrlOut,
        bookUrl: `${getBookBaseUrl()}/coach/${slug}`,
      }).catch((err) => console.error("[storefront] guest booking notify (non-fatal):", err));

      res.json({ booked: true, claim_url: claimUrlOut, slot });
    } catch (err) {
      console.error("[storefront] bookGuest failed:", err);
      res.status(500).json({ error: "booking failed" });
    }
  }

  return { getCoachPage, getCoachData, bookGuest };
}

// A friendly 404 for an unknown/invalid coach handle. Same dark look as the
// invalid-room page in index.js, CoachTime brand.
function notFoundPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Coach not found</title>
<style>html,body{height:100%;margin:0}body{background:#0E0E0F;color:#F2F0EB;
font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
display:flex;align-items:center;justify-content:center;text-align:center;padding:24px}
h1{font-size:20px;margin:0 0 8px}p{color:#B8B6B0;font-size:14px;margin:0}
.brand{font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#D4C36A;font-weight:600;margin:0 0 14px}</style></head>
<body><div><p class="brand">CoachTime</p><h1>We couldn't find that coach.</h1>
<p>Double-check the link, or ask your coach for their page.</p></div></body></html>`;
}

module.exports = { buildStorefrontHandlers, SLUG_RE };
