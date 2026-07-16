// lib/reminders.js
//
// The session-reminder cron for CoachTime (GET /cron/reminders in the wire
// contract). Internal, scheduled, NOT client-callable: a cron secret header
// gates it. On each run it scans booked bookable_slots whose start falls inside
// a reminder window (24h-before and 30min-before by default), resolves the two
// recipients (the booked athlete's auth user + the coach), and fans each out
// through the existing notify() chokepoint.
//
// Two guarantees mirror the rest of this stack:
//   - Dedup is real. A per (user, window, slot) row in notification_log records
//     each send the same way notify() records its notifications row; a window is
//     wide enough that a 15-30 min cron cadence catches every slot, and the log
//     check makes a second fire impossible. A 24h reminder and a 30min reminder
//     are DISTINCT keys (session.reminder.24h vs session.reminder.30m + slot id)
//     so both fire, once each.
//   - One bad recipient never sinks the sweep. Each notify() is isolated; a
//     failure is logged and skipped (no log row, so it retries next sweep) and
//     the sweep continues to the next recipient/slot. The response is always
//     200 { scanned, sent } unless the initial slot query itself fails.
//
// SCAR (steal inventory): every instant here is real UTC. Windows are computed
// as ms deltas off Date.now(); starts_at is a timestamptz. Never local-time math.

// The reminder windows. offsetMs is how far before the slot the reminder fires;
// each window is centered on that offset, WINDOW_WIDTH_MS wide.
const REMINDER_WINDOWS = [
  {
    key: "24h",
    type: "session.reminder.24h",
    offsetMs: 24 * 60 * 60 * 1000,
    title: "Session tomorrow",
    body: "Your coaching session is coming up in about 24 hours.",
  },
  {
    key: "30m",
    type: "session.reminder.30m",
    offsetMs: 30 * 60 * 1000,
    title: "Session starting soon",
    body: "Your coaching session starts in about 30 minutes.",
  },
];

// Full width of each window band. >= the max cron cadence (30 min) so no slot
// slips through a gap between runs; the notification_log dedup absorbs the
// overlap when the cadence is tighter (e.g. 15 min hits a 30 min band twice).
const WINDOW_WIDTH_MS = 30 * 60 * 1000;

// Read Supabase creds at CALL time (not module load), same as notify.js /
// scheduling.js, so a test that sets env before wiring the route still sees them.
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

// Which reminder window a slot falls in given the current instant, or null. A
// slot is in a window when the delta (start - now) sits inside the band centered
// on that window's offset. Pure + exported for direct unit testing.
function windowForSlot(startMs, nowMs, windows = REMINDER_WINDOWS, widthMs = WINDOW_WIDTH_MS) {
  const delta = startMs - nowMs;
  if (delta <= 0) return null; // already started / past
  const half = widthMs / 2;
  for (const w of windows) {
    if (delta >= w.offsetMs - half && delta < w.offsetMs + half) return w;
  }
  return null;
}

// The auth users to remind for a booked slot: the coach (coaches.id = auth.uid,
// always an auth user) and the booked athlete — but only once the athlete has
// CLAIMED (athletes.user_id set). An unclaimed athlete has no auth user, so it
// is skipped here; its pre-account reminders are an email/SMS lane, not this
// in-app fan-out (see 0012 notification_log note). Pure + exported for testing.
function resolveRecipients(slot) {
  const out = [];
  if (slot.coach_id) out.push({ userId: slot.coach_id, role: "coach" });
  const athlete = slot.athlete || null;
  if (athlete && athlete.user_id) {
    out.push({
      userId: athlete.user_id,
      role: "athlete",
      email: athlete.parent_email || undefined,
    });
  }
  return out;
}

// Booked slots whose start falls within the outermost reminder band. One query;
// each row is classified into its window in JS via windowForSlot.
async function fetchBookedSlots(s, { loIso, hiIso, includeSessionType = false }) {
  const q =
    `${s.url}/rest/v1/bookable_slots` +
    `?status=eq.booked` +
    `&starts_at=gt.${encodeURIComponent(loIso)}` +
    `&starts_at=lte.${encodeURIComponent(hiIso)}` +
    `&select=id,coach_id,booked_by,starts_at,ends_at,timezone,title,session_id,` +
    (includeSessionType ? `session_type_id,` : ``) +
    `athlete:booked_by(user_id,name,parent_email)` +
    `&order=starts_at.asc`;
  const resp = await fetch(q, { headers: s.headers });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`supabase GET ${resp.status}: ${detail}`);
  }
  if (includeSessionType) {
    const rows = await resp.json();
    if (!Array.isArray(rows)) throw new Error("invalid booked-slot representation");
    return rows;
  }
  return resp.json().catch(() => []);
}

// True when this (user, window-type, slot) reminder was already sent. Any prior
// notification_log row for the triple counts, so a reminder never double-fires.
// Best-effort: a missing table / error returns false (proceed) — notify()'s own
// dedupe_key on the notifications row is the second line of defense.
async function logHasSend(s, { userId, type, referenceId }) {
  const q =
    `${s.url}/rest/v1/notification_log` +
    `?user_id=eq.${encodeURIComponent(userId)}` +
    `&type=eq.${encodeURIComponent(type)}` +
    `&reference_id=eq.${encodeURIComponent(referenceId)}` +
    `&select=id&limit=1`;
  try {
    const resp = await fetch(q, { headers: s.headers });
    if (!resp.ok) return false;
    const rows = await resp.json().catch(() => []);
    return Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    console.error("[reminders] dedupe check failed:", err);
    return false;
  }
}

// Append the notification_log row that marks this reminder sent. Never throws.
async function logRecordSend(s, { userId, type, referenceId, channel }) {
  try {
    await fetch(`${s.url}/rest/v1/notification_log`, {
      method: "POST",
      headers: { ...s.headers, prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: userId,
        type,
        reference_id: referenceId,
        channel,
      }),
    });
  } catch (err) {
    console.error("[reminders] notification_log write failed:", err);
  }
}

/**
 * Build the reminder-cron route handler. `notify` is injected so the sweep stays
 * testable (tests mock global.fetch for Supabase + pass a stub notify).
 *
 * @param {object} deps
 * @param {(args:object)=>Promise<void>} deps.notify  the notify() chokepoint.
 */
function buildRemindersHandler({ notify, rulesProvider } = {}) {
  return async function remindersHandler(req, res) {
    // AUTH: cron-only. No secret configured, or a header mismatch -> 401, do
    // nothing. Never client-callable.
    const secret = process.env.CRON_SECRET;
    const provided = req.get
      ? req.get("x-cron-secret")
      : req.headers && req.headers["x-cron-secret"];
    if (!secret || provided !== secret) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const s = sb();
    if (!s) return res.status(200).json({ scanned: 0, sent: 0 });

    try {
      const nowMs = Date.now();
      const plan = rulesProvider
        ? await rulesProvider.load({ nowMs, widthMs: WINDOW_WIDTH_MS })
        : null;
      const half = WINDOW_WIDTH_MS / 2;
      const scanWindows = plan ? plan.scanWindows : REMINDER_WINDOWS;
      const offsets = scanWindows.map((w) => w.offsetMs);
      const loIso = new Date(nowMs + Math.min(...offsets) - half).toISOString();
      const hiIso = new Date(nowMs + Math.max(...offsets) + half).toISOString();

      const slots = await fetchBookedSlots(s, { loIso, hiIso, includeSessionType: Boolean(plan) });

      let scanned = 0;
      let sent = 0;
      for (const slot of Array.isArray(slots) ? slots : []) {
        scanned++;
        const windows = plan
          ? plan.sessionWindowsFor(slot.coach_id, slot.session_type_id || null)
          : REMINDER_WINDOWS;
        const w = windowForSlot(new Date(slot.starts_at).getTime(), nowMs, windows);
        if (!w) continue;

        for (const r of resolveRecipients(slot)) {
          if (plan && w.recipient !== "both" && w.recipient !== r.role) continue;
          if (await logHasSend(s, { userId: r.userId, type: w.type, referenceId: slot.id })) {
            continue; // already reminded this user for this slot+window
          }
          try {
            if (plan) {
              const values = {
                athlete: String((slot.athlete && slot.athlete.name) || (r.role === "coach" ? "Your athlete" : "You")).trim(),
                coach: "your coach",
                time: new Intl.DateTimeFormat("en-US", {
                  weekday: "short", month: "short", day: "numeric", hour: "numeric",
                  minute: "2-digit", timeZoneName: "short", timeZone: slot.timezone || "America/New_York",
                }).format(new Date(slot.starts_at)),
                service: String(slot.title || "coaching session").trim(),
              };
              const expand = (text) => String(text).replace(/\{(athlete|coach|time|service)\}/g, (_, key) => values[key]);
              await notify({
                userId: r.userId,
                type: w.type,
                title: expand(w.title),
                body: expand(w.body),
                data: {
                    slotId: slot.id,
                    sessionId: slot.session_id || null,
                    window: w.key,
                    ruleId: w.ruleId,
                    href: r.role === "athlete"
                      ? "/athlete"
                      : slot.session_id ? `/sessions/${slot.session_id}` : "/settings/notifications",
                },
                dedupeKey: slot.id,
                email: r.email || undefined,
              });
            } else {
              await notify({
                userId: r.userId,
                type: w.type,
                title: w.title,
                body: w.body,
                data: { slotId: slot.id, sessionId: slot.session_id || null, window: w.key },
                dedupeKey: slot.id,
                email: r.email || undefined,
              });
            }
          } catch (err) {
            // A bad recipient must not abort the sweep or 500 the response. No
            // log row + no count means it retries next sweep.
            if (plan) console.error("[reminders] provider notification failed");
            else console.error("[reminders] notify failed:", r.userId, slot.id, err);
            continue;
          }
          await logRecordSend(s, {
            userId: r.userId,
            type: w.type,
            referenceId: slot.id,
            channel: "inapp",
          });
          sent++;
        }
      }

      if (plan) {
        const lifecycle = await plan.runLifecycle({ notify });
        scanned += lifecycle.scanned;
        sent += lifecycle.sent;

        // HOOK:HOMEWORK_REMINDER
        const homework = await plan.runHomeworkDue({ notify });
        scanned += homework.scanned;
        sent += homework.sent;
      }

      res.json({ scanned, sent });
    } catch (err) {
      console.error("[reminders] sweep failed:", err);
      res.status(500).json({ error: "reminder sweep failed" });
    }
  };
}

module.exports = {
  buildRemindersHandler,
  // Pure helpers exported for unit tests + reuse.
  windowForSlot,
  resolveRecipients,
  REMINDER_WINDOWS,
  WINDOW_WIDTH_MS,
};
