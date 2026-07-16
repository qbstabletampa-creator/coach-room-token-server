// Async video-review handler factory. Route registration and feature gating live
// in index.js; this module deliberately has no import-time environment reads.

const crypto = require("node:crypto");
const { storedClipObjectPath } = require("./clip-storage");

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const STATUSES = new Set(["submitted", "in_review", "answered", "declined"]);
const PENDING = new Set(["submitted", "in_review"]);
const AUDIO_TYPES = new Set([
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "application/octet-stream",
]);
const REVIEW_SELECT =
  "id,coach_id,athlete_id,video_id,session_id,ask,status,created_at,answered_at," +
  "athletes(id,name,user_id),videos(id,title,duration_s,created_at,url,athlete_id,session_id)," +
  "coaches(full_name)";
const ANNOTATION_SELECT =
  "id,coach_id,review_id,reel,audio_path,duration_s,created_at,shared_at";

class DbError extends Error {
  constructor(method, status, detail) {
    super(`supabase ${method} ${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

function dbErrorPayload(err) {
  if (!(err instanceof DbError) || typeof err.detail !== "string") return null;
  try {
    const value = JSON.parse(err.detail);
    return value && typeof value === "object" ? value : null;
  } catch (_) {
    return null;
  }
}

function isReviewIdUniqueViolation(err) {
  const payload = dbErrorPayload(err);
  if (!payload || payload.code !== "23505") return false;
  return /(?:\breview_id\b|\(review_id\))/i.test(
    `${payload.details || ""} ${payload.message || ""}`,
  );
}

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

async function dbJson(resp, method) {
  if (!resp.ok) {
    throw new DbError(method, resp.status, await resp.text().catch(() => ""));
  }
  return resp.json().catch(() => []);
}

async function sbGet(s, path) {
  return dbJson(await fetch(`${s.url}/rest/v1/${path}`, { headers: s.headers }), "GET");
}

async function sbPost(s, path, body) {
  return dbJson(await fetch(`${s.url}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...s.headers, prefer: "return=representation" },
    body: JSON.stringify(body),
  }), "POST");
}

async function sbPatch(s, path, body) {
  return dbJson(await fetch(`${s.url}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...s.headers, prefer: "return=representation" },
    body: JSON.stringify(body),
  }), "PATCH");
}

async function sbDelete(s, path) {
  return dbJson(await fetch(`${s.url}/rest/v1/${path}`, {
    method: "DELETE",
    headers: { ...s.headers, prefer: "return=representation" },
  }), "DELETE");
}

function one(rows) {
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function relation(value) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function reviewDto(row) {
  const athlete = relation(row.athletes) || {};
  const video = relation(row.videos) || {};
  return {
    id: row.id,
    athlete: { id: athlete.id || row.athlete_id, name: athlete.name || "" },
    video: {
      id: video.id || row.video_id,
      title: video.title || "",
      duration_s: Number.isFinite(video.duration_s) ? video.duration_s : null,
      created_at: video.created_at,
    },
    session_id: row.session_id || null,
    ask: row.ask || null,
    status: row.status,
    created_at: row.created_at,
    answered_at: row.answered_at || null,
  };
}

function annotationDto(row) {
  return {
    id: row.id,
    review_id: row.review_id,
    reel: row.reel,
    has_audio: row.audio_path != null,
    duration_s: row.duration_s,
    created_at: row.created_at,
    shared_at: row.shared_at,
  };
}

function send(res, status, data) {
  return res.status(status).json(data);
}

function error(res, status, code) {
  return send(res, status, { error: code });
}

function exactKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function point(value) {
  return exactKeys(value, ["x", "y"]) &&
    Number.isFinite(value.x) && Number.isFinite(value.y);
}

function validPenPath(value) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 65536) {
    return false;
  }
  if (!/^[\sMLml0-9+.,eE-]+$/.test(value)) return false;
  const numbers = value.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) || [];
  return numbers.length >= 2 && numbers.every((n) => Number.isFinite(Number(n)));
}

function validShape(shape) {
  if (!shape || typeof shape !== "object" || Array.isArray(shape)) return false;
  const base = ["id", "tool", "cs", "color", "width"];
  const geometry = {
    pen: ["d"],
    line: ["from", "to"],
    arrow: ["from", "to"],
    circle: ["center", "r"],
    angle: ["p1", "p2", "p3"],
  };
  const keys = geometry[shape.tool];
  if (!keys || !exactKeys(shape, [...base, ...keys])) return false;
  if (typeof shape.id !== "string" || !shape.id || shape.id.length > 128) return false;
  if (shape.cs !== 1 || !/^#[0-9a-fA-F]{6}$/.test(shape.color || "")) return false;
  if (!Number.isFinite(shape.width) || shape.width < 0.5 || shape.width > 32) return false;
  if (shape.tool === "pen") return validPenPath(shape.d);
  if (shape.tool === "circle") return point(shape.center) && Number.isFinite(shape.r);
  return keys.every((key) => point(shape[key]));
}

function validReel(reel, answerDuration, videoDuration, checkVideoPosition = true) {
  if (!Array.isArray(reel) || reel.length > 5000) return false;
  let previous = 0;
  for (const event of reel) {
    if (!event || typeof event !== "object" || Array.isArray(event)) return false;
    if (!Number.isFinite(event.t) || event.t < 0 || event.t < previous ||
        event.t > answerDuration + 0.25) return false;
    previous = event.t;
    if (event.kind === "shape") {
      if (!exactKeys(event, ["t", "kind", "shape"]) || !validShape(event.shape)) return false;
    } else if (event.kind === "undo" || event.kind === "clear") {
      if (!exactKeys(event, ["t", "kind"])) return false;
    } else if (["play", "pause", "seek"].includes(event.kind)) {
      const limit = Number.isFinite(videoDuration) ? videoDuration + 1 : 3600;
      if (!exactKeys(event, ["t", "kind", "pos"]) ||
          !Number.isFinite(event.pos) || event.pos < 0 ||
          (checkVideoPosition && event.pos > limit)) return false;
    } else if (event.kind === "rate") {
      if (!exactKeys(event, ["t", "kind", "rate"]) ||
          ![0.1, 0.25, 0.5, 1].includes(event.rate)) return false;
    } else {
      return false;
    }
  }
  return true;
}

function structuralEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((value, i) => structuralEqual(value, b[i]));
  }
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, i) =>
    key === bk[i] && structuralEqual(a[key], b[key]));
}

function sameAnswer(annotation, reel, audioPath, duration) {
  return annotation && annotation.audio_path === audioPath &&
    annotation.duration_s === duration && structuralEqual(annotation.reel, reel);
}

function trustedStoredClipObjectPath(ref, supabaseUrl, allowedRooms) {
  let parsed;
  try {
    parsed = new URL(ref);
  } catch (_) {
    // Bare object paths are the preferred stored representation.
  }
  if (parsed) {
    let storageOrigin;
    try { storageOrigin = new URL(supabaseUrl).origin; } catch (_) { return null; }
    if (parsed.origin !== storageOrigin) return null;
  }
  return storedClipObjectPath(
    ref,
    process.env.CLIPS_BUCKET || "clips-private",
    allowedRooms,
  );
}

function sourcePath(row, supabaseUrl) {
  const video = relation(row.videos);
  if (!video) return null;
  return trustedStoredClipObjectPath(
    video.url,
    supabaseUrl,
    [video.athlete_id, video.session_id].filter(Boolean),
  );
}

function audioPathFor(coachId, reviewId, value) {
  if (typeof value !== "string") return null;
  const prefix = `reviews/${coachId}/${reviewId}/`;
  if (!value.startsWith(prefix)) return null;
  const name = value.slice(prefix.length);
  const match = /^([0-9a-fA-F-]{36})\.m4a$/.exec(name);
  return match && validUuid(match[1]) ? value : null;
}

async function storageObjectExists(s, path) {
  const bucket = process.env.CLIPS_BUCKET || "clips-private";
  const slash = path.lastIndexOf("/");
  const prefix = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  let resp;
  try {
    resp = await fetch(`${s.url}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      headers: s.headers,
      body: JSON.stringify({ prefix, limit: 100, offset: 0, search: name }),
    });
  } catch (err) {
    throw new DbError("STORAGE", 502, err && err.message || "network failure");
  }
  if (!resp.ok) throw new DbError("STORAGE", resp.status, await resp.text().catch(() => ""));
  const rows = await resp.json().catch(() => null);
  if (!Array.isArray(rows)) throw new DbError("STORAGE", 502, "invalid list response");
  return rows.some((row) => row && row.name === name);
}

async function uploadAudio(s, path, body) {
  const bucket = process.env.CLIPS_BUCKET || "clips-private";
  let resp;
  try {
    resp = await fetch(`${s.url}/storage/v1/object/${bucket}/${path}`, {
      method: "POST",
      headers: {
        apikey: s.key,
        authorization: `Bearer ${s.key}`,
        "content-type": "audio/mp4",
        "x-upsert": "false",
      },
      body,
    });
  } catch (err) {
    throw new DbError("STORAGE", 502, err && err.message || "network failure");
  }
  if (!resp.ok) throw new DbError("STORAGE", resp.status, await resp.text().catch(() => ""));
}

async function deleteStoredObject(s, path) {
  const bucket = process.env.CLIPS_BUCKET || "clips-private";
  try {
    await fetch(`${s.url}/storage/v1/object/${bucket}/${path}`, {
      method: "DELETE",
      headers: {
        apikey: s.key,
        authorization: `Bearer ${s.key}`,
      },
    });
  } catch (_) {
    // Upload cleanup is best-effort; the terminal review state still wins.
  }
}

function buildVideoReviewHandlers(deps) {
  const { requireSupabaseUser, notify, signClipUrl } = deps || {};

  async function identity(req, res, allowed) {
    const authd = await requireSupabaseUser(req);
    if (authd.error) {
      error(res, authd.status || 401, authd.error);
      return null;
    }
    const user = authd.user || {};
    if (user.app_metadata && user.app_metadata.role === "coach") {
      if (!allowed.includes("coach")) {
        error(res, 403, "forbidden");
        return null;
      }
      return { role: "coach", coachId: user.id, user };
    }
    if (!allowed.includes("athlete")) {
      error(res, 403, "forbidden");
      return null;
    }
    const s = sb();
    if (!s) {
      error(res, 503, "not_configured");
      return null;
    }
    const rows = await sbGet(s,
      `athletes?user_id=eq.${encodeURIComponent(user.id)}&select=id,coach_id,name,user_id&limit=2`);
    if (!Array.isArray(rows) || rows.length !== 1) {
      error(res, 403, "forbidden");
      return null;
    }
    return {
      role: "athlete",
      coachId: rows[0].coach_id,
      athleteId: rows[0].id,
      athlete: rows[0],
      user,
    };
  }

  function configured(res, needsSigner = false) {
    const s = sb();
    if (!s || (needsSigner && typeof signClipUrl !== "function")) {
      error(res, 503, "not_configured");
      return null;
    }
    return s;
  }

  async function ownedReview(s, id, who) {
    let path = `video_reviews?id=eq.${encodeURIComponent(id)}` +
      `&coach_id=eq.${encodeURIComponent(who.coachId)}`;
    if (who.role === "athlete") path += `&athlete_id=eq.${encodeURIComponent(who.athleteId)}`;
    return one(await sbGet(s, `${path}&select=${REVIEW_SELECT}&limit=1`));
  }

  async function annotation(s, reviewId, coachId) {
    return one(await sbGet(s,
      `review_annotations?review_id=eq.${encodeURIComponent(reviewId)}` +
      `&coach_id=eq.${encodeURIComponent(coachId)}&select=${ANNOTATION_SELECT}&limit=1`));
  }

  async function deleteAnnotationBestEffort(s, reviewId, coachId) {
    try {
      await sbDelete(s,
        `review_annotations?review_id=eq.${encodeURIComponent(reviewId)}` +
        `&coach_id=eq.${encodeURIComponent(coachId)}`);
    } catch (_) {
      // A declined review is hidden at read time even if cleanup cannot complete.
    }
  }

  async function safeNotify(payload) {
    if (typeof notify !== "function") return;
    try { await notify(payload); } catch (err) {
      console.error("[video-review] notify failed (non-fatal):", err);
    }
  }

  async function postReview(req, res) {
    try {
      const body = req.body;
      if (!exactKeys(body, ["video_id", "ask", "session_id"])) return error(res, 400, "invalid_body");
      if (!validUuid(body.video_id) ||
          (body.session_id != null && !validUuid(body.session_id))) return error(res, 400, "invalid_body");
      let ask = body.ask == null ? null : body.ask;
      if (ask != null && typeof ask !== "string") return error(res, 400, "invalid_ask");
      if (typeof ask === "string") ask = ask.trim() || null;
      if (ask && Array.from(ask).length > 500) return error(res, 400, "invalid_ask");
      const who = await identity(req, res, ["athlete"]);
      if (!who) return;
      const s = configured(res);
      if (!s) return;
      const video = one(await sbGet(s,
        `videos?id=eq.${encodeURIComponent(body.video_id)}` +
        `&coach_id=eq.${encodeURIComponent(who.coachId)}` +
        `&athlete_id=eq.${encodeURIComponent(who.athleteId)}` +
        "&select=id,coach_id,athlete_id,session_id,url,title,duration_s,source,kind,created_at&limit=1"));
      if (!video || video.source !== "live-clip" || video.kind !== "rep" ||
          !trustedStoredClipObjectPath(video.url, s.url,
            [video.athlete_id, video.session_id].filter(Boolean))) {
        return error(res, 404, "not_found");
      }
      if (body.session_id !== undefined && body.session_id !== video.session_id) {
        return error(res, 400, "session_mismatch");
      }
      const inserted = one(await sbPost(s, "video_reviews", {
        coach_id: who.coachId,
        athlete_id: who.athleteId,
        video_id: video.id,
        session_id: video.session_id || null,
        ask,
        status: "submitted",
      }));
      if (!inserted) throw new Error("review insert returned no row");
      const row = { ...inserted, athletes: who.athlete, videos: video };
      await safeNotify({
        userId: who.coachId,
        type: "review.submitted",
        title: "New film review",
        body: `${who.athlete.name} sent ${video.title || "a clip"} for review.`,
        data: { reviewId: inserted.id, athleteId: who.athleteId, videoId: video.id,
          href: `/reviews/${inserted.id}` },
        dedupeKey: `review.submitted:${inserted.id}`,
      });
      return send(res, 201, { review: reviewDto(row) });
    } catch (err) { return unexpected(res, "postReview", err); }
  }

  async function getReviews(req, res) {
    try {
      const query = req.query || {};
      if (!exactKeys(query, ["status"]) || Array.isArray(query.status) ||
          (query.status !== undefined &&
           (typeof query.status !== "string" || query.status.includes(",") || !STATUSES.has(query.status)))) {
        return error(res, 400, "invalid_status");
      }
      const who = await identity(req, res, ["coach", "athlete"]);
      if (!who) return;
      const s = configured(res);
      if (!s) return;
      let path = `video_reviews?coach_id=eq.${encodeURIComponent(who.coachId)}`;
      if (who.role === "athlete") path += `&athlete_id=eq.${encodeURIComponent(who.athleteId)}`;
      if (query.status) path += `&status=eq.${query.status}`;
      else if (who.role === "coach") path += "&status=in.(submitted,in_review)";
      const oldest = who.role === "coach" && (!query.status || PENDING.has(query.status));
      path += `&select=${REVIEW_SELECT}&order=created_at.${oldest ? "asc" : "desc"}`;
      const rows = await sbGet(s, path);
      return send(res, 200, { reviews: (Array.isArray(rows) ? rows : []).map(reviewDto) });
    } catch (err) { return unexpected(res, "getReviews", err); }
  }

  async function getReview(req, res) {
    try {
      if (!validUuid(req.params && req.params.id)) return error(res, 400, "invalid_id");
      const who = await identity(req, res, ["coach", "athlete"]);
      if (!who) return;
      const s = configured(res, true);
      if (!s) return;
      const row = await ownedReview(s, req.params.id, who);
      if (!row) return error(res, 404, "not_found");
      if (row.status === "declined") return send(res, 200, { review: reviewDto(row), source_url: null });
      const path = sourcePath(row, s.url);
      if (!path) return error(res, 404, "not_found");
      const url = await safeSign(path);
      if (!url) return error(res, 502, "signing_failed");
      return send(res, 200, { review: reviewDto(row), source_url: url });
    } catch (err) { return unexpected(res, "getReview", err); }
  }

  async function postAudio(req, res) {
    try {
      if (!validUuid(req.params && req.params.id)) return error(res, 400, "invalid_id");
      const who = await identity(req, res, ["coach"]);
      if (!who) return;
      const s = configured(res);
      if (!s) return;
      const row = await ownedReview(s, req.params.id, who);
      if (!row) return error(res, 404, "not_found");
      if (row.status === "declined") {
        await deleteAnnotationBestEffort(s, row.id, who.coachId);
        return error(res, 409, "review_declined");
      }
      if (row.status === "answered") return error(res, 409, "already_answered");
      const body = req.body;
      if (!Buffer.isBuffer(body) || !body.length) return error(res, 415, "invalid_audio");
      if (body.length > 25 * 1024 * 1024) return error(res, 413, "audio_too_large");
      const type = String((req.headers && req.headers["content-type"]) || "").split(";", 1)[0].toLowerCase();
      if (!AUDIO_TYPES.has(type) || body.length < 8 || body.toString("ascii", 4, 8) !== "ftyp") {
        return error(res, 415, "invalid_audio");
      }
      const path = `reviews/${who.coachId}/${row.id}/${crypto.randomUUID()}.m4a`;
      await uploadAudio(s, path, body);
      const stillPending = one(await sbGet(s,
        `video_reviews?id=eq.${encodeURIComponent(row.id)}` +
        `&coach_id=eq.${encodeURIComponent(who.coachId)}` +
        "&status=in.(submitted,in_review)&select=id&limit=1"));
      if (!stillPending) {
        const fresh = await ownedReview(s, row.id, who);
        await deleteStoredObject(s, path);
        if (fresh && fresh.status === "declined") return error(res, 409, "review_declined");
        if (!fresh) return error(res, 404, "not_found");
        return error(res, 409, "already_answered");
      }
      return send(res, 201, { audio_path: path });
    } catch (err) {
      if (err instanceof DbError && err.message.includes("STORAGE")) return error(res, 502, "storage_failed");
      return unexpected(res, "postAudio", err);
    }
  }

  async function notifyAnswered(row) {
    const athlete = relation(row.athletes);
    if (!athlete || !athlete.user_id) {
      console.warn(`[video-review] answer notification skipped: athlete user missing for ${row.id}`);
      return;
    }
    const coach = relation(row.coaches);
    await safeNotify({
      userId: athlete.user_id,
      type: "review.answered",
      title: "Your film review is ready",
      body: `${(coach && coach.full_name) || "Your coach"} sent your annotated review.`,
      data: { reviewId: row.id, href: `/reviews/${row.id}/watch` },
      dedupeKey: `review.answered:${row.id}`,
    });
  }

  async function postAnswer(req, res) {
    try {
      if (!validUuid(req.params && req.params.id)) return error(res, 400, "invalid_id");
      const body = req.body;
      if (!exactKeys(body, ["reel", "audio_path", "duration_s"])) return error(res, 400, "invalid_body");
      if (!Number.isInteger(body.duration_s) || body.duration_s < 0 || body.duration_s > 900) {
        return error(res, 400, "invalid_reel");
      }
      // Validate every request-only reel constraint before auth can perform an athlete lookup.
      if (!validReel(body.reel, body.duration_s, null, false)) {
        return error(res, 400, "invalid_reel");
      }
      const who = await identity(req, res, ["coach"]);
      if (!who) return;
      const s = configured(res);
      if (!s) return;
      const audioPath = body.audio_path == null ? null :
        audioPathFor(who.coachId, req.params.id, body.audio_path);
      if (body.audio_path != null && !audioPath) return error(res, 400, "invalid_audio_path");
      let row = await ownedReview(s, req.params.id, who);
      if (!row) return error(res, 404, "not_found");
      if (row.status === "declined") {
        await deleteAnnotationBestEffort(s, row.id, who.coachId);
        return error(res, 409, "review_declined");
      }
      const video = relation(row.videos);
      if (!validReel(body.reel, body.duration_s, video && video.duration_s)) {
        return error(res, 400, "invalid_reel");
      }
      if (row.status === "answered") {
        const existing = await annotation(s, row.id, who.coachId);
        if (!sameAnswer(existing, body.reel, audioPath, body.duration_s)) {
          return error(res, 409, "already_answered");
        }
        await notifyAnswered(row);
        return send(res, 200, { review: reviewDto(row), annotation: annotationDto(existing) });
      }
      if (audioPath && !(await storageObjectExists(s, audioPath))) {
        return error(res, 400, "invalid_audio_path");
      }
      const sharedAt = new Date().toISOString();
      let ann;
      let inserted = true;
      try {
        ann = one(await sbPost(s, "review_annotations", {
          coach_id: who.coachId,
          review_id: row.id,
          reel: body.reel,
          audio_path: audioPath,
          duration_s: body.duration_s,
          shared_at: sharedAt,
        }));
      } catch (err) {
        if (!(err instanceof DbError && err.status === 409)) throw err;
        const payload = dbErrorPayload(err);
        if (payload && payload.code === "23503") {
          const fresh = await ownedReview(s, row.id, who);
          if (!fresh) return error(res, 404, "not_found");
          throw err;
        }
        if (!isReviewIdUniqueViolation(err)) throw err;
        inserted = false;
        ann = await annotation(s, row.id, who.coachId);
        if (!sameAnswer(ann, body.reel, audioPath, body.duration_s)) {
          return error(res, 409, "already_answered");
        }
      }
      if (!ann) throw new Error("annotation insert returned no row");
      let transitioned;
      try {
        transitioned = one(await sbPatch(s,
          `video_reviews?id=eq.${encodeURIComponent(row.id)}` +
          `&coach_id=eq.${encodeURIComponent(who.coachId)}` +
          "&status=in.(submitted,in_review)",
          { status: "answered", answered_at: ann.shared_at }));
      } catch (err) {
        // Contract §1.6 deliberately retains this partial state so an equal retry
        // can win the unique-conflict path and repair the pending review status.
        throw err;
      }
      if (!transitioned) {
        const fresh = await ownedReview(s, row.id, who);
        if (fresh && fresh.status === "declined") {
          if (inserted) await deleteAnnotationBestEffort(s, row.id, who.coachId);
          return error(res, 409, "review_declined");
        }
        if (!fresh) {
          if (inserted) await deleteAnnotationBestEffort(s, row.id, who.coachId);
          return error(res, 404, "not_found");
        }
        if (fresh.status === "answered") {
          await notifyAnswered(fresh);
          return send(res, 200, { review: reviewDto(fresh), annotation: annotationDto(ann) });
        }
        throw new Error("answer status patch returned no row");
      }
      row = { ...row, ...transitioned, athletes: row.athletes, videos: row.videos, coaches: row.coaches };
      await notifyAnswered(row);
      return send(res, inserted ? 201 : 200, {
        review: reviewDto(row), annotation: annotationDto(ann),
      });
    } catch (err) {
      if (err instanceof DbError && err.message.includes("STORAGE")) return error(res, 502, "storage_failed");
      return unexpected(res, "postAnswer", err);
    }
  }

  async function getAnnotation(req, res) {
    try {
      if (!validUuid(req.params && req.params.id)) return error(res, 400, "invalid_id");
      const who = await identity(req, res, ["coach", "athlete"]);
      if (!who) return;
      const s = configured(res, true);
      if (!s) return;
      const row = await ownedReview(s, req.params.id, who);
      if (!row) return error(res, 404, "not_found");
      if (PENDING.has(row.status)) return error(res, 409, "review_not_answered");
      if (row.status === "declined") {
        // Contract §1.7: an owned declined review reads as 409 review_declined.
        // The orphan annotation is still cleaned and never served.
        await deleteAnnotationBestEffort(s, row.id, who.coachId);
        return error(res, 409, "review_declined");
      }
      const ann = await annotation(s, row.id, who.coachId);
      if (!ann) return error(res, 500, "annotation_missing");
      const source = sourcePath(row, s.url);
      const audio = ann.audio_path == null ? null : audioPathFor(who.coachId, row.id, ann.audio_path);
      if (!source) return error(res, 404, "not_found");
      if (ann.audio_path != null && !audio) return error(res, 502, "signing_failed");
      const sourceUrl = await safeSign(source);
      const audioUrl = audio ? await safeSign(audio) : null;
      if (!sourceUrl || (audio && !audioUrl)) return error(res, 502, "signing_failed");
      return send(res, 200, {
        review: reviewDto(row), annotation: annotationDto(ann),
        source_url: sourceUrl, audio_url: audioUrl,
      });
    } catch (err) { return unexpected(res, "getAnnotation", err); }
  }

  async function postDecline(req, res) {
    try {
      if (!validUuid(req.params && req.params.id)) return error(res, 400, "invalid_id");
      const who = await identity(req, res, ["coach"]);
      if (!who) return;
      const s = configured(res);
      if (!s) return;
      if (!exactKeys(req.body, []) || Object.keys(req.body).length) return error(res, 400, "invalid_body");
      let row = await ownedReview(s, req.params.id, who);
      if (!row) return error(res, 404, "not_found");
      if (row.status === "answered") return error(res, 409, "already_answered");
      if (row.status !== "declined") {
        const patched = one(await sbPatch(s,
          `video_reviews?id=eq.${encodeURIComponent(row.id)}` +
          `&coach_id=eq.${encodeURIComponent(who.coachId)}` +
          "&status=in.(submitted,in_review)", { status: "declined" }));
        if (!patched) {
          row = await ownedReview(s, req.params.id, who);
          if (!row) return error(res, 404, "not_found");
          if (row.status === "answered") return error(res, 409, "already_answered");
          if (row.status !== "declined") throw new Error("decline patch returned no row");
        } else {
          row = { ...row, ...patched, athletes: row.athletes, videos: row.videos, coaches: row.coaches };
        }
      }
      const athlete = relation(row.athletes);
      if (athlete && athlete.user_id) {
        await safeNotify({
          userId: athlete.user_id,
          type: "review.declined",
          title: "Film review declined",
          body: "Your coach couldn't review this clip. Choose another clip and try again.",
          data: { reviewId: row.id, href: "/athlete/film" },
          dedupeKey: `review.declined:${row.id}`,
        });
      } else {
        console.warn(`[video-review] decline notification skipped: athlete user missing for ${row.id}`);
      }
      return send(res, 200, { review: reviewDto(row) });
    } catch (err) { return unexpected(res, "postDecline", err); }
  }

  function unexpected(res, operation, err) {
    console.error(`[video-review] ${operation} failed:`, err);
    return error(res, 500, "internal_error");
  }

  async function safeSign(path) {
    try { return await signClipUrl(path); } catch { return null; }
  }

  return { postReview, getReviews, getReview, postAudio, postAnswer, getAnnotation, postDecline };
}

module.exports = { buildVideoReviewHandlers };
