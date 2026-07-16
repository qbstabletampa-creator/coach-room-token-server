// Shared clip object-path validation. Both the app re-sign route and the Open
// API use this authorization primitive so stored URLs can never become a
// signing oracle.

const ROOM_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const CLIP_FILENAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

function resolveClipObjectPath(room, ref) {
  if (!ROOM_ID_RE.test(String(room || "")) || typeof ref !== "string" || !ref) return null;
  const base = ref.split("/").filter(Boolean).pop() || "";
  if (!CLIP_FILENAME_RE.test(base) || base === "." || base === "..") return null;
  return `${room}/${base}`;
}

function storedClipObjectPath(ref, bucket = process.env.CLIPS_BUCKET || "clips-private", allowedRooms) {
  if (typeof ref !== "string" || !ref) return null;
  let candidate = ref;
  try {
    const url = new URL(ref);
    const marker = `/object/sign/${bucket}/`;
    const at = url.pathname.indexOf(marker);
    if (at < 0) return null;
    candidate = decodeURIComponent(url.pathname.slice(at + marker.length));
  } catch {
    // A stored bare object path is the preferred representation.
  }
  const parts = candidate.split("/");
  if (parts.length !== 2) return null;
  if (Array.isArray(allowedRooms) && !allowedRooms.map(String).includes(parts[0])) return null;
  const resolved = resolveClipObjectPath(parts[0], parts[1]);
  return resolved === candidate ? resolved : null;
}

module.exports = { resolveClipObjectPath, storedClipObjectPath };
