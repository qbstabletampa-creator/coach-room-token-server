const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const templatePath = path.join(__dirname, "..", "views", "coach-page.html");

test("upgraded coach page template exists and avoids unsafe HTML sinks", () => {
  assert.equal(fs.existsSync(templatePath), true);
  const source = fs.readFileSync(templatePath, "utf8");

  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/i);
  assert.doesNotMatch(source, /\s+on[a-z]+\s*=/i);
  assert.doesNotMatch(source, /<(?:script|link|img)\b[^>]*(?:src|href)\s*=\s*["']https?:/i);
});

test("upgraded renderer references every public DTO field", () => {
  const source = fs.readFileSync(templatePath, "utf8");
  for (const field of [
    "headline", "years_experience", "languages", "reply_time", "how_i_work",
    "coach_page", "locations", "gallery", "socials", "sections",
  ]) assert.match(source, new RegExp(`\\b${field}\\b`));

  assert.match(source, /money\(t\.price_cents\)/);
  assert.match(source, /price_cents\s*===\s*0/);
  assert.match(source, /Start free/);
});

test("maps, gallery, and social links are constructed with safe DOM APIs", () => {
  const source = fs.readFileSync(templatePath, "utf8");
  assert.match(source, /https:\/\/www\.google\.com\/maps\/search\/\?api=1&query="\s*\+\s*encodeURIComponent\(address\)/);
  assert.match(source, /function httpsUrl[\s\S]*parsed\.protocol\s*===\s*"https:"/);

  const gallery = source.slice(source.indexOf("function renderGallery"), source.indexOf("function renderSocials"));
  assert.match(gallery, /document\.createElement\("img"\)/);
  assert.match(gallery, /document\.createElement\("figcaption"\)/);
  assert.match(gallery, /caption\.textContent\s*=/);
  assert.match(gallery, /img\.loading\s*=\s*"lazy"/);

  const socials = source.slice(source.indexOf("function renderSocials"), source.indexOf("function applySectionOrder"));
  assert.match(socials, /document\.createElement\("a"\)/);
  assert.match(socials, /link\.textContent\s*=\s*label/);
  assert.match(socials, /link\.target\s*=\s*"_blank"/);
  assert.match(socials, /link\.rel\s*=\s*"noopener noreferrer"/);
});
