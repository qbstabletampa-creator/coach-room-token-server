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
const {
  resolveSessionType,
  resolveBookingSessionType,
  fireBookingNotifications,
} = require("./scheduling");

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
const CHARGE_RETRY_DELAYS_MS = [5, 10];

async function runFailSoft(tag, fn) {
  try {
    return await Promise.resolve().then(fn);
  } catch (err) {
    console.error(`[storefront:hook:${tag}] failed (non-fatal):`, err);
    return null;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// COMPARE_GAP:COACH_PAGE:PUBLIC_SANITIZER:BEGIN
const COACH_PAGE_SECTION_KEYS = new Set([
  "about", "how_i_work", "locations", "gallery", "services", "steps", "socials",
]);
const COACH_PAGE_REPLY_TIMES = new Set(["within_day", "within_2_days", "within_week"]);
const COACH_PAGE_SOCIAL_PLATFORMS = new Set([
  "instagram", "youtube", "tiktok", "facebook", "x", "web",
]);

function coachPageText(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && Array.from(trimmed).length <= max ? trimmed : null;
}

function coachPageHttps(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? parsed.toString()
      : null;
  } catch (_) {
    return null;
  }
}

function sanitizeCoachPageUpgrade(value) {
  const input = value && typeof value === "object" ? value : {};
  const profile = input.profile && typeof input.profile === "object" ? input.profile : {};
  const years = Number.isInteger(profile.years_experience) &&
    profile.years_experience >= 1 && profile.years_experience <= 80
    ? profile.years_experience : null;
  const languages = Array.isArray(profile.languages)
    ? profile.languages.map((v) => coachPageText(v, 40)).filter(Boolean).slice(0, 6)
    : [];
  const locations = Array.isArray(input.locations) ? input.locations.slice(0, 8).map((row) => ({
    name: coachPageText(row && row.name, 100),
    address: coachPageText(row && row.address, 300),
    note: coachPageText(row && row.note, 300),
    sort: Number.isInteger(row && row.sort) ? row.sort : 0,
  })).filter((row) => row.name) : [];
  const gallery = Array.isArray(input.gallery) ? input.gallery.slice(0, 12).map((row) => ({
    url: coachPageHttps(row && row.url),
    caption: coachPageText(row && row.caption, 200),
    sort: Number.isInteger(row && row.sort) ? row.sort : 0,
  })).filter((row) => row.url) : [];
  const socials = Array.isArray(input.socials) ? input.socials.slice(0, 6).map((row) => ({
    platform: typeof (row && row.platform) === "string" ? row.platform : "",
    url: coachPageHttps(row && row.url),
    sort: Number.isInteger(row && row.sort) ? row.sort : 0,
  })).filter((row) => row.url && COACH_PAGE_SOCIAL_PLATFORMS.has(row.platform)) : [];
  const sections = Array.isArray(input.sections) ? input.sections.slice(0, 7).map((row) => ({
    key: row && row.key,
    visible: Boolean(row && row.visible),
    sort: Number.isInteger(row && row.sort) ? row.sort : 0,
  })).filter((row) => COACH_PAGE_SECTION_KEYS.has(row.key)) : [];
  return {
    profile: {
      headline: coachPageText(profile.headline, 120),
      years_experience: years,
      languages,
      reply_time: COACH_PAGE_REPLY_TIMES.has(profile.reply_time) ? profile.reply_time : null,
      how_i_work: coachPageText(profile.how_i_work, 2000),
    },
    locations,
    gallery,
    socials,
    sections,
  };
}

function withCoachPageUpgrade(base, value) {
  const upgrade = sanitizeCoachPageUpgrade(value);
  return {
    ...base,
    coach: { ...base.coach, ...upgrade.profile },
    session_types: [...base.session_types].sort((a, b) =>
      Number(Number(a.price_cents) !== 0) - Number(Number(b.price_cents) !== 0)),
    coach_page: {
      locations: upgrade.locations,
      gallery: upgrade.gallery,
      socials: upgrade.socials,
      sections: upgrade.sections,
    },
  };
}
// COMPARE_GAP:COACH_PAGE:PUBLIC_SANITIZER:END

async function storefrontDataForCoach(s, coach) {
  const coachId = coach.id;
  const sessionTypes = await sbGet(s,
    `session_types?coach_id=eq.${coachId}&active=is.true` +
      `&select=id,name,duration_min,price_cents,description&order=sort.asc,created_at.asc`);
  const packages = await sbGet(s,
    `packages?coach_id=eq.${coachId}&active=is.true` +
      `&select=id,name,description,price_cents,credits,billing_type,billing_interval,installment_count` +
      `&order=created_at.asc`);
  const nowIso = new Date().toISOString();
  const openSlots = await sbGet(s,
    `bookable_slots?coach_id=eq.${coachId}&status=eq.open` +
      `&starts_at=gt.${encodeURIComponent(nowIso)}` +
      `&select=id,starts_at,ends_at,timezone,title&order=starts_at.asc&limit=${OPEN_SLOTS_LIMIT}`);
  return { coach: sanitizeCoach(coach), session_types: Array.isArray(sessionTypes) ? sessionTypes : [],
    packages: Array.isArray(packages) ? packages : [], open_slots: Array.isArray(openSlots) ? openSlots : [] };
}

async function getOwnCoachPage({ coachId }) {
  const s = sb();
  if (!s) return { status: 503, data: { error: "storefront not configured" } };
  const rows = await sbGet(s, `coaches?id=eq.${coachId}&select=id,slug,full_name,business,disciplines,bio,city&limit=1`);
  const coach = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!coach) return { status: 404, data: { error: "not found" } };
  const data = await storefrontDataForCoach(s, coach);
  return { status: 200, data: { slug: coach.slug || null, claimed: Boolean(coach.slug), ...data } };
}

function buildStorefrontHandlers(deps) {
  const {
    notify,
    bookingGate = null,
    calendarMirror = null,
    formsPendingWaiver = null,
    guestCharge = null,
    // COMPARE_GAP:COACH_PAGE:DEPS:BEGIN
    coachPagePublicReader = null,
    coachPageTemplatePath = null,
    // COMPARE_GAP:COACH_PAGE:DEPS:END
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
      // COMPARE_GAP:COACH_PAGE:TEMPLATE:BEGIN
      if (coachPagePublicReader && coachPageTemplatePath) {
        const galleryOrigin = new URL(process.env.SUPABASE_URL).origin;
        res.set({
          "Cache-Control": "no-store, max-age=0",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy":
            "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; " +
            "form-action 'self'; connect-src 'self'; font-src 'self'; " +
            `img-src 'self' ${galleryOrigin}; ` +
            "style-src 'unsafe-inline'; script-src 'unsafe-inline'",
        });
        return res.sendFile(coachPageTemplatePath);
      }
      res.sendFile(path.join(__dirname, "..", "public", "coach.html"));
      // COMPARE_GAP:COACH_PAGE:TEMPLATE:END
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

      // COMPARE_GAP:COACH_PAGE:PUBLIC_READ:BEGIN
      const base = await storefrontDataForCoach(s, coach);
      if (!coachPagePublicReader) return res.json(base);
      const upgrade = await coachPagePublicReader({ coachId: coach.id });
      res.set({
        "Cache-Control": "no-store, max-age=0",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      res.json(withCoachPageUpgrade(base, upgrade));
      // COMPARE_GAP:COACH_PAGE:PUBLIC_READ:END
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
      const requestedTypeSupplied =
        Object.prototype.hasOwnProperty.call(body, "session_type_id") &&
        body.session_type_id !== undefined &&
        body.session_type_id !== null;
      const requestedTypeId = requestedTypeSupplied ? String(body.session_type_id) : null;
      const legacyRequestedTypeId = body.session_type_id ? String(body.session_type_id) : null;

      // Resolve the coach by slug (the tenant every write is scoped to).
      const coach = await lookupCoachBySlug(s, slug);
      if (!coach) return res.status(404).json({ error: "not found" });
      const coachId = coach.id;

      // Enabled hooks distinguish omitted types from supplied garbage and require
      // the supplied type's ownership lookup to succeed before any claim. With
      // both hooks off, retain master's truthy-input validation and persistence.
      let sessionTypeId = null;
      let pricingReadFailed = false;
      if (bookingGate || guestCharge) {
        if (requestedTypeSupplied && !UUID_RE.test(requestedTypeId)) {
          return res.status(400).json({ error: "unknown_session_type" });
        }
        if (requestedTypeSupplied) {
          try {
            sessionTypeId = await resolveSessionType(s, {
              coachId,
              sessionTypeId: requestedTypeId,
            });
          } catch (err) {
            console.error("[storefront] type ownership read failed (blocking):", err);
            return res.status(503).json({ error: "session_type_unavailable" });
          }
          if (!sessionTypeId) {
            return res.status(400).json({ error: "unknown_session_type" });
          }
        }
        try {
          const resolvedType = await resolveBookingSessionType(s, {
            coachId,
            slotId,
            requestedTypeId: sessionTypeId,
            requestedTypeValidated: true,
            requireTypeWhenUntyped: true,
          });
          if (resolvedType.error) {
            return res.status(400).json({ error: resolvedType.error });
          }
          sessionTypeId = resolvedType.sessionTypeId;
        } catch (err) {
          if (bookingGate) {
            console.error("[storefront:booking-gate] type/policy read failed (non-fatal):", err);
          }
          if (guestCharge) pricingReadFailed = true;
        }
      } else if (legacyRequestedTypeId) {
        sessionTypeId = await resolveSessionType(s, { coachId, sessionTypeId: legacyRequestedTypeId });
        if (!sessionTypeId) {
          return res.status(400).json({ error: "unknown session type" });
        }
      }

      // Match-or-create the athlete IN THIS TENANT. A same-email athlete under a
      // DIFFERENT coach never links here (findAthleteByEmail pins coach_id), so a
      // lead who trains with two coaches gets a separate card per coach.
      const resolved = await matchOrCreateAthlete(s, { coachId, email, name, source: "guest" });
      if (!resolved) {
        return res.status(500).json({ error: "could not create your profile" });
      }
      const { athleteId, userId } = resolved;

      // ---- PRE-CLAIM, BLOCKING: protection card/approval gate ---------------
      if (bookingGate) {
        let gate = null;
        try {
          gate = await bookingGate({
            coachId,
            athleteId,
            slotId,
            sessionTypeId,
            setupContext: { email, returnPath: `/coach/${slug}` },
          });
        } catch (err) {
          console.error("[storefront:booking-gate] policy read failed (non-fatal):", err);
        }
        if (gate?.status === "card_setup_unavailable") {
          return res.status(503).json({ error: "card_setup_unavailable" });
        }
        if (gate && gate.allowed === false) {
          return res.status(402).json({ error: "needs_card", setup_url: gate.setup_url });
        }
        if (gate && Object.prototype.hasOwnProperty.call(gate, "sessionTypeId")) {
          sessionTypeId = gate.sessionTypeId;
        }
      }

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

      // Guest bookings deduct no package credit, so the ordered low-credit hook
      // is intentionally a no-op in this lane.
      // HOOK:CALENDAR_MIRROR (calendar-sync factory, 0018 — wired here)
      if (calendarMirror) {
        await runFailSoft("calendar-mirror", () => calendarMirror({ coachId, athleteId, slot }));
      }

      // HOOK:FORMS_PENDING_WAIVER (forms factory, 0030 — wired here)
      if (formsPendingWaiver) {
        await runFailSoft("forms-pending-waiver", () => formsPendingWaiver({ coachId, athleteId, slot }));
      }

      // PAYMENTS_ENABLED owns coach_charges. Retry its insert twice in-request;
      // the claimed booking never unwinds, but final failure is made loud.
      let chargeFailure = pricingReadFailed;
      let chargeAmount = null;
      if (guestCharge && sessionTypeId && !pricingReadFailed) {
        try {
          const types = await sbGet(
            s,
            `session_types?id=eq.${sessionTypeId}&coach_id=eq.${coachId}` +
              `&active=is.true&select=id,name,price_cents&limit=1`,
          );
          const type = Array.isArray(types) && types[0] ? types[0] : null;
          const amount = Number(type?.price_cents);
          chargeAmount = Number.isInteger(amount) && amount > 0 ? amount : null;
          if (type && Number.isInteger(amount) && amount > 0) {
            let lastError = null;
            for (let attempt = 0; attempt <= CHARGE_RETRY_DELAYS_MS.length; attempt++) {
              try {
                const result = await guestCharge({
                  coachId,
                  athlete_id: athleteId,
                  slot_id: slotId,
                  label: `${type.name || "Guest session"} booking`,
                  amount_cents: amount,
                });
                if (result?.error) throw new Error(result.error);
                lastError = null;
                break;
              } catch (err) {
                lastError = err;
                if (attempt < CHARGE_RETRY_DELAYS_MS.length) {
                  await wait(CHARGE_RETRY_DELAYS_MS[attempt]);
                }
              }
            }
            if (lastError) throw lastError;
          }
        } catch (err) {
          chargeFailure = true;
          console.error("[storefront:hook:guest-charge] failed after retries (non-fatal):", err);
        }
      }
      if (guestCharge && chargeFailure) {
        const amountText = chargeAmount == null ? "unknown" : `$${(chargeAmount / 100).toFixed(2)}`;
        await runFailSoft("guest-charge-notify", () => notify?.({
          userId: coachId,
          type: "payments.charge_log_failed",
          title: "Guest charge needs manual entry",
          body: `Guest booking recorded but the owed charge could not be logged — athlete ${name}, slot ${slotId}, amount ${amountText}; record it manually in Payments.`,
          data: { athleteId, slotId, amount_cents: chargeAmount },
          dedupeKey: `guest-charge-log-failed:${slotId}:${Date.now()}`,
        }));
      }

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
      await runFailSoft("booking-notify", () => fireBookingNotifications({
        notify,
        getBookBaseUrl,
        invite: pseudoInvite,
        slot,
        claimUrl: claimUrlOut,
        bookUrl: `${getBookBaseUrl()}/coach/${slug}`,
      }));

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

module.exports = { buildStorefrontHandlers, getOwnCoachPage, SLUG_RE };
