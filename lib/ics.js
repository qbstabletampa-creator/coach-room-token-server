// lib/ics.js
//
// Dependency-free .ics (RFC-5545) builder for CoachTime booking confirmations,
// ported from qb-stable-app's client/src/lib/calendar.ts to this stack (CommonJS,
// no browser Blob/download — the string is emailed as a Resend attachment
// instead). The line-folding + escaping helpers copy nearly verbatim; the only
// adaptation is Buffer for UTF-8 byte handling instead of TextEncoder.
//
// Every instant here is a real UTC Date. DTSTART/DTEND are written in UTC form
// (the trailing Z), which is unambiguous and renders to the recipient's local
// time in any calendar app, anywhere (the "correct local time anywhere" goal).
// No fake-local math ever touches these values.

// Format a UTC Date as a compact RFC-5545 timestamp: 20260710T170000Z.
// toISOString() is always UTC, so the Z is real, never a local pretender.
function formatCalendarDate(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// Escape a value for an .ics text field: backslash, semicolon, comma, and
// newlines all carry meaning in RFC-5545, so they must be escaped.
function escapeIcs(s) {
  return String(s == null ? "" : s)
    .replace(/[\\;,]/g, (c) => "\\" + c)
    .replace(/\r\n/g, "\\n")
    .replace(/\n/g, "\\n");
}

// RFC-5545 line folding: a content line longer than 75 OCTETS is split, and each
// continuation line begins with a single space. We fold on byte boundaries (not
// character count) and never split a multibyte UTF-8 sequence. First segment is
// 75 bytes; continuations are 74 bytes of content + the 1 leading space = 75.
function foldIcsLine(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  let isFirst = true;
  while (start < bytes.length) {
    const maxLen = isFirst ? 75 : 74;
    let end = Math.min(start + maxLen, bytes.length);
    // Back up if `end` lands in the middle of a multibyte char (continuation
    // bytes match 10xxxxxx). Guard start+1 so we always make progress.
    while (end > start + 1 && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.slice(start, end).toString("utf8"));
    start = end;
    isFirst = false;
  }
  return parts.join("\r\n ");
}

/**
 * Build a VCALENDAR string for a single booked session.
 *
 * @param {object} opts
 * @param {string} opts.title        SUMMARY line.
 * @param {string} [opts.description] DESCRIPTION line.
 * @param {Date}   opts.start        real UTC start instant.
 * @param {Date}   opts.end          real UTC end instant.
 * @param {string} [opts.url]        URL property (the join/booking link).
 * @param {string} [opts.organizer]  ORGANIZER email (coach), wrapped mailto:.
 * @returns {string} the CRLF-joined VCALENDAR text.
 */
function buildIcs(opts) {
  const { title, description, start, end, url, organizer } = opts || {};
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@coachtime`;
  const stamp = formatCalendarDate(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CoachTime//Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${formatCalendarDate(start)}`,
    `DTEND:${formatCalendarDate(end)}`,
    foldIcsLine(`SUMMARY:${escapeIcs(title)}`),
  ];
  if (description) lines.push(foldIcsLine(`DESCRIPTION:${escapeIcs(description)}`));
  if (url) lines.push(foldIcsLine(`URL:${escapeIcs(url)}`));
  if (organizer) lines.push(foldIcsLine(`ORGANIZER:mailto:${escapeIcs(organizer)}`));
  lines.push("STATUS:CONFIRMED", "END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

/**
 * Build a Google "add to calendar" template URL for the same booked session.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {Date}   opts.start   real UTC start instant.
 * @param {Date}   opts.end     real UTC end instant.
 * @param {string} [opts.location]
 * @param {string} [opts.description]
 * @returns {string}
 */
function buildGoogleCalendarUrl(opts) {
  const { title, start, end, location, description } = opts || {};
  const params = new URLSearchParams();
  params.set("action", "TEMPLATE");
  params.set("text", title == null ? "" : String(title));
  params.set("dates", `${formatCalendarDate(start)}/${formatCalendarDate(end)}`);
  if (location) params.set("location", String(location));
  if (description) params.set("details", String(description));
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

module.exports = {
  buildIcs,
  buildGoogleCalendarUrl,
  formatCalendarDate,
  escapeIcs,
  foldIcsLine,
};
