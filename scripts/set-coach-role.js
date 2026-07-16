#!/usr/bin/env node
// set-coach-role.js — mark a Supabase user as a coach for CoachTime.
//
// Phase 1 hardening (S1): the token server derives the LiveKit coach- identity
// from app_metadata.role === "coach" ONLY. app_metadata is server-controlled
// (writable exclusively with the SERVICE key), unlike user_metadata which the
// end user can set themselves. So a real coach's account must have
// app_metadata.role = "coach" written here BEFORE the S1 change ships, or the
// coach's own token would mint as an athlete- identity.
//
// CJ-GATED — DO NOT RUN against production without CJ's approval. It mutates a
// live auth user via the Supabase Admin API. It is committed as the sanctioned
// tool, not run by any agent.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/set-coach-role.js coach@email.com
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_KEY from the environment (never hardcode
// or print the service key). Takes exactly one arg: the coach's email.

"use strict";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const email = (process.argv[2] || "").trim();

function die(msg) {
  console.error(`[set-coach-role] ${msg}`);
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  die("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in the environment.");
}
if (!email || !email.includes("@")) {
  die("usage: node scripts/set-coach-role.js <coach-email>");
}

const admin = {
  apikey: SUPABASE_SERVICE_KEY,
  authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "content-type": "application/json",
};

async function main() {
  // 1. Find the user by email via the Admin API (service key required).
  const listResp = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?` +
      new URLSearchParams({ page: "1", per_page: "200" }).toString(),
    { headers: admin },
  );
  if (!listResp.ok) {
    die(`admin user lookup failed: ${listResp.status} ${await listResp.text().catch(() => "")}`);
  }
  const payload = await listResp.json();
  const users = Array.isArray(payload) ? payload : payload.users || [];
  const user = users.find(
    (u) => (u.email || "").toLowerCase() === email.toLowerCase(),
  );
  if (!user) {
    die(`no auth user found for ${email} (first 200 users scanned).`);
  }

  // 2. Merge role:'coach' into app_metadata (server-controlled field).
  const mergedAppMeta = { ...(user.app_metadata || {}), role: "coach" };
  const updResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
    method: "PUT",
    headers: admin,
    body: JSON.stringify({ app_metadata: mergedAppMeta }),
  });
  if (!updResp.ok) {
    die(`update failed: ${updResp.status} ${await updResp.text().catch(() => "")}`);
  }
  console.log(`[set-coach-role] ${email} (${user.id}) now has app_metadata.role='coach'.`);
}

main().catch((err) => die(err && err.message ? err.message : String(err)));
