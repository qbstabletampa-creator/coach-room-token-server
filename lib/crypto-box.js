// Authenticated encryption for server-only calendar OAuth secrets.
// Environment and randomness are deliberately read only when a function runs.

const crypto = require("node:crypto");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLUMNS = new Set(["refresh_token_enc", "access_token_enc"]);

function key() {
  const raw = process.env.CALENDAR_TOKEN_KEY;
  if (typeof raw !== "string" || !/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error("calendar token key is not configured");
  }
  return Buffer.from(raw, "hex");
}

function context(options) {
  const value = options || {};
  if (!UUID_RE.test(value.coachId || "") || !COLUMNS.has(value.column)) {
    throw new TypeError("invalid calendar secret context");
  }
  return `calendar_connections:${value.coachId.toLowerCase()}:google:${value.column}`;
}

function encryptSecret(plaintext, options) {
  if (typeof plaintext !== "string" || !plaintext) {
    throw new TypeError("invalid calendar secret");
  }
  const aad = Buffer.from(context(options), "utf8");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

function decodePart(value, bytes) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid encrypted calendar secret");
  }
  const decoded = Buffer.from(value, "base64url");
  if ((bytes != null && decoded.length !== bytes) ||
      decoded.toString("base64url") !== value) {
    throw new Error("invalid encrypted calendar secret");
  }
  return decoded;
}

function decryptSecret(serialized, options) {
  try {
    if (typeof serialized !== "string") throw new Error();
    const parts = serialized.split(":");
    if (parts.length !== 4 || parts[0] !== "v1") throw new Error();
    const iv = decodePart(parts[1], 12);
    const tag = decodePart(parts[2], 16);
    const encrypted = decodePart(parts[3]);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAAD(Buffer.from(context(options), "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch (_) {
    // A stable error prevents ciphertext, keys, authentication details, or
    // plaintext fragments from escaping through logs and route envelopes.
    throw new Error("calendar secret authentication failed");
  }
}

module.exports = { encryptSecret, decryptSecret };
