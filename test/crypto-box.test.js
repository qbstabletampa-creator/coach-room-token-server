const test = require("node:test");
const assert = require("node:assert/strict");

const { encryptSecret, decryptSecret } = require("../lib/crypto-box");

const COACH = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const KEY = "11".repeat(32);

test.beforeEach(() => { process.env.CALENDAR_TOKEN_KEY = KEY; });
test.after(() => { delete process.env.CALENDAR_TOKEN_KEY; });

test("AES-256-GCM round trips with random IVs and no plaintext", () => {
  const options = { coachId: COACH, column: "refresh_token_enc" };
  const first = encryptSecret("refresh-secret", options);
  const second = encryptSecret("refresh-secret", options);
  assert.match(first, /^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$/);
  assert.notEqual(first, second);
  assert.equal(first.includes("refresh-secret"), false);
  assert.equal(decryptSecret(first, options), "refresh-secret");
  assert.equal(decryptSecret(second, options), "refresh-secret");
});

test("AAD binds ciphertext to coach and column", () => {
  const value = encryptSecret("access-secret", { coachId: COACH, column: "access_token_enc" });
  assert.throws(() => decryptSecret(value, { coachId: OTHER, column: "access_token_enc" }),
    /^Error: calendar secret authentication failed$/);
  assert.throws(() => decryptSecret(value, { coachId: COACH, column: "refresh_token_enc" }),
    /^Error: calendar secret authentication failed$/);
});

test("tampered version, IV, tag, body and malformed encoding fail closed", () => {
  const options = { coachId: COACH, column: "refresh_token_enc" };
  const value = encryptSecret("do-not-leak", options);
  const parts = value.split(":");
  const flip = (text) => text.slice(0, -1) + (text.endsWith("A") ? "B" : "A");
  const cases = [
    ["v2", ...parts.slice(1)].join(":"),
    [parts[0], flip(parts[1]), parts[2], parts[3]].join(":"),
    [parts[0], parts[1], flip(parts[2]), parts[3]].join(":"),
    [parts[0], parts[1], parts[2], flip(parts[3])].join(":"),
    "v1:not+base64:bad:bad",
  ];
  for (const candidate of cases) {
    assert.throws(() => decryptSecret(candidate, options), (error) => {
      assert.equal(error.message, "calendar secret authentication failed");
      assert.equal(error.message.includes("do-not-leak"), false);
      return true;
    });
  }
});

test("wrong or missing key fails without leaking key or plaintext", () => {
  const options = { coachId: COACH, column: "access_token_enc" };
  const value = encryptSecret("access-secret", options);
  for (const key of ["22".repeat(32), "short", undefined]) {
    if (key === undefined) delete process.env.CALENDAR_TOKEN_KEY;
    else process.env.CALENDAR_TOKEN_KEY = key;
    assert.throws(() => decryptSecret(value, options), (error) => {
      assert.equal(error.message, "calendar secret authentication failed");
      assert.equal(error.message.includes("access-secret"), false);
      assert.equal(error.message.includes(KEY), false);
      return true;
    });
  }
});

test("invalid plaintext and contexts are rejected before encryption", () => {
  assert.throws(() => encryptSecret("", { coachId: COACH, column: "refresh_token_enc" }), TypeError);
  assert.throws(() => encryptSecret("x", { coachId: "bad", column: "refresh_token_enc" }), TypeError);
  assert.throws(() => encryptSecret("x", { coachId: COACH, column: "google_email" }), TypeError);
});
