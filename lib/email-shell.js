// lib/email-shell.js
//
// Branded transactional email for CoachTime. Ported from little-soles'
// ls-api/src/lib/email.ts and re-skinned to the QB Stable aesthetic
// (Pure Black / Stark White / Vegas Gold #D4C36A).
//
// Three exports:
//   - brandedEmailShell(innerRows)   the single source of truth for the look.
//   - buildPlainText(lines)          plain-text fallback builder.
//   - sendTransactionalEmail(args)   the ONE place that talks to Resend.
//
// Graceful by design (mirrors the little-soles contract):
//   - No RESEND_API_KEY  -> no-op (returns false), never throws.
//   - Apple private-relay PLACEHOLDER address -> skipped (not a real inbox).
//   - Resend itself errors / the SDK is missing -> logged, returns false.
// Sending email must NEVER break the action that triggered it, so callers
// wrap this too (notify() does). CommonJS to match index.js.

// ---- brand tokens ----------------------------------------------------------
const GOLD = "#D4C36A"; // Vegas Gold — THE gold, on any background (brand-voice rule).
const BLACK = "#0E0E0F"; // near-pure black, matches the app / join.html chrome.
const INK = "#1A1A1D"; // body text on white.
const MUTE = "#6B6B70"; // secondary text.
const HAIR = "#E6E6E6"; // hairline dividers on white.

// The verified Resend sender. Overridable via env so staging / a different
// verified domain can swap in without a code change. Defaults are placeholders
// until CJ verifies the CoachTime domain in Resend.
const FROM = process.env.EMAIL_FROM || "CoachTime <hello@coachtime.app>";
const REPLY_TO = process.env.EMAIL_REPLY_TO || "hello@coachtime.app";

// Apple can hide a user's real email behind a private relay. When our own auth
// mints a synthetic placeholder for that case it lives on this domain, which is
// NOT a deliverable inbox — never try to email it. (Apple's REAL relay,
// privaterelay.appleid.com, IS deliverable and is deliberately NOT skipped.)
const PLACEHOLDER_EMAIL_DOMAIN =
  process.env.EMAIL_PLACEHOLDER_DOMAIN || "@users.coachtime.app";

const SITE_URL = process.env.EMAIL_SITE_URL || "https://coachtime.app";

// escapeHtml — event-supplied title/body are not trusted markup.
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// True when this address has no real inbox (empty or our synthetic placeholder).
function isPlaceholderEmail(to) {
  const email = String(to == null ? "" : to).trim().toLowerCase();
  if (!email) return true;
  return email.endsWith(PLACEHOLDER_EMAIL_DOMAIN.toLowerCase());
}

// The shared brand chrome: black header band with the gold CoachTime wordmark,
// a white body card holding the caller's rows, and one shared sign-off. Inline
// styles only (email clients strip <style>/external CSS), mobile-friendly, one
// centered 600px card. `innerRows` is a sequence of <tr>...</tr> rows that slot
// in below the header divider so they inherit the 40px side padding.
function brandedEmailShell(innerRows) {
  return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background-color:#F4F4F5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F4F4F5;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid ${HAIR};border-radius:14px;overflow:hidden;">
          <tr>
            <td style="padding:30px 40px;text-align:center;background-color:${BLACK};">
              <div style="font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:800;letter-spacing:3px;color:${GOLD};">COACHTIME</div>
              <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:2px;color:#9A9A9E;padding-top:6px;text-transform:uppercase;">Coaching, live.</div>
            </td>
          </tr>
          ${innerRows}
          <tr>
            <td style="padding:36px 40px 0 40px;">
              <div style="height:1px;background-color:${HAIR};line-height:1px;font-size:1px;">&nbsp;</div>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 40px 36px 40px;text-align:center;">
              <div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:800;letter-spacing:2px;color:#000000;">COACHTIME</div>
              <p style="margin:14px 0 0 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:${MUTE};">
                Questions? Just reply, a real human reads every email.<br/>
                <a href="${SITE_URL}" style="color:#000000;text-decoration:none;font-weight:600;">${escapeHtml(
                  SITE_URL.replace(/^https?:\/\//, ""),
                )}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Standard event email body: a gold H1 title + a paragraph. title/body are
// escaped (event-supplied). Used by notify()'s per-event emails.
function eventEmailHtml(title, body) {
  return brandedEmailShell(`<tr>
            <td style="padding:32px 40px 0 40px;">
              <h1 style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:23px;line-height:1.3;color:${INK};font-weight:800;">${escapeHtml(
                title,
              )}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 40px 0 40px;">
              <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#333333;">${escapeHtml(
                body,
              )}</p>
            </td>
          </tr>`);
}

// Plain-text fallback builder. Pass the lines; get a single \n-joined string
// wrapped with the wordmark header/footer so no-HTML clients still read clean.
function buildPlainText(lines) {
  const arr = Array.isArray(lines) ? lines : [String(lines == null ? "" : lines)];
  return ["COACHTIME", "Coaching, live.", "", ...arr, "", "CoachTime"].join("\n");
}

// One Resend client per process, lazily built only when a key exists. Kept in a
// module-scope cache so we don't reconstruct it per send. Null means "email not
// configured" (the normal case in dev / before the key lands on Render).
let _resendClient; // undefined = not yet resolved, null = unavailable.
function getResend() {
  if (_resendClient !== undefined) return _resendClient;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    _resendClient = null;
    return null;
  }
  try {
    // Lazy require: the `resend` SDK is only loaded when a key is actually set,
    // so tests (no key) never need the package installed.
    const { Resend } = require("resend");
    _resendClient = new Resend(key);
  } catch (err) {
    console.error("[email] Resend SDK unavailable, email disabled:", err.message);
    _resendClient = null;
  }
  return _resendClient;
}

/**
 * The single transactional sender. Graceful no-op when email is unconfigured or
 * the address is a placeholder, and never throws (errors are logged). Returns
 * true only when a send was actually attempted and Resend reported no error.
 */
async function sendTransactionalEmail(args) {
  try {
    const resend = getResend();
    if (!resend) return false; // no RESEND_API_KEY (or SDK missing) — no-op.

    const to = String((args && args.to) || "").trim().toLowerCase();
    if (isPlaceholderEmail(to)) return false; // no real inbox to deliver to.

    const payload = {
      from: FROM,
      to: [to],
      replyTo: REPLY_TO,
      subject: (args && args.subject) || "CoachTime",
      html: (args && args.html) || "",
    };
    if (args && args.text) payload.text = args.text;
    // Optional Resend attachments passthrough (e.g. a booking .ics invite).
    // Additive: callers that don't send attachments are entirely unaffected.
    // Shape per Resend: [{ filename, content, contentType? }] where content is a
    // base64 string or a Buffer.
    if (args && Array.isArray(args.attachments) && args.attachments.length > 0) {
      payload.attachments = args.attachments;
    }

    const { error } = await resend.emails.send(payload);
    if (error) {
      console.error("[email] transactional send failed:", error);
      return false;
    }
    return true;
  } catch (err) {
    // Never let an email error escape to the caller.
    console.error("[email] transactional send threw:", err);
    return false;
  }
}

module.exports = {
  brandedEmailShell,
  eventEmailHtml,
  buildPlainText,
  sendTransactionalEmail,
  isPlaceholderEmail,
  escapeHtml,
};
