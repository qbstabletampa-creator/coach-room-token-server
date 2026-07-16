// Waitlist v1 factory. Registration, feature flags, and scheduling hooks live in index.js.
const crypto = require("node:crypto");
const { brandedEmailShell, buildPlainText, escapeHtml, sendTransactionalEmail } = require("./email-shell");

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const MODES = new Set(["instant_book", "first_in_line", "revenue_max"]);
const STATUSES = new Set(["waiting", "offered", "booked", "cancelled"]);
const WINDOWS = new Set([5, 10, 30]);
const DAY = 86400000;

class DbError extends Error {
  constructor(method, status, detail) { super(`supabase ${method} ${status}: ${detail}`); this.status = status; this.detail = detail; }
}
function sb() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  return url && key ? { url, headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" } } : null;
}
async function db(s, method, path, body) {
  let response;
  try { response = await fetch(`${s.url}/rest/v1/${path}`, { method, headers: method === "GET" ? s.headers : { ...s.headers, prefer: "return=representation" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch (_) { throw new DbError(method, 0, "transport failure"); }
  let text;
  try { text = await response.text(); } catch (_) { throw new DbError(method, response.status, "response failure"); }
  if (!response.ok) throw new DbError(method, response.status, text);
  let value;
  try { value = JSON.parse(text); } catch (_) { throw new DbError(method, response.status, "invalid JSON response"); }
  if (!Array.isArray(value)) throw new DbError(method, response.status, "invalid response shape");
  return value;
}
const get = (s, p) => db(s, "GET", p);
const post = (s, p, b) => db(s, "POST", p, b);
const patch = (s, p, b) => db(s, "PATCH", p, b);
const one = (rows) => Array.isArray(rows) && rows.length ? rows[0] : null;
const rel = (v) => Array.isArray(v) ? v[0] || null : v || null;
const enc = encodeURIComponent;
const validUuid = (v) => typeof v === "string" && UUID_RE.test(v);
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => keys.includes(k));
const send = (res, status, value) => res.status(status).json(value);
const fail = (res, status, code) => send(res, status, { error: code });
function payload(err) { try { return err instanceof DbError ? JSON.parse(err.detail) : null; } catch (_) { return null; } }
function unexpected(res, err) {
  if (err instanceof DbError && (err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504)) return fail(res, 502, "upstream_unavailable");
  if (err instanceof DbError && err.status === 401) return fail(res, 502, "upstream_unavailable");
  return fail(res, 500, "internal_error");
}
function dateOnly(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y,m,d] = v.split("-").map(Number), x = new Date(Date.UTC(y,m-1,d));
  return y >= 1 && x.getUTCFullYear() === y && x.getUTCMonth() === m-1 && x.getUTCDate() === d;
}
const timeOnly = (v) => typeof v === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v);
function parsePreference(body, coachAdd) {
  const keys = [...(coachAdd ? ["athlete_id"] : []), "session_type_id", "desired_date", "desired_start", "desired_end"];
  if (!exact(body, keys) || (coachAdd && !validUuid(body.athlete_id))) return null;
  const st = body.session_type_id == null ? null : body.session_type_id;
  const date = body.desired_date == null ? null : body.desired_date;
  const start = body.desired_start == null ? null : body.desired_start;
  const end = body.desired_end == null ? null : body.desired_end;
  if (st !== null && !validUuid(st)) return null;
  if (date !== null && !dateOnly(date)) return null;
  if ((start === null) !== (end === null) || (start !== null && (!timeOnly(start) || !timeOnly(end) || end <= start))) return null;
  return { session_type_id: st && st.toLowerCase(), desired_date: date, desired_start: start, desired_end: end };
}
function boundedPreference(pref, instant) {
  if (!pref.desired_date) return true;
  const today = instant.toISOString().slice(0,10), max = new Date(instant.getTime() + 365*DAY).toISOString().slice(0,10);
  return pref.desired_date >= today && pref.desired_date <= max;
}
const scopeKey = (p) => `st:${p.session_type_id || "*"}|d:${p.desired_date || "*"}|w:${p.desired_start ? `${p.desired_start}-${p.desired_end}` : "*"}`;
function entryDto(r) { return { id:r.id, status:r.status, preference:{ session_type_id:r.session_type_id||null, desired_date:r.desired_date||null, desired_start:r.desired_start ? String(r.desired_start).slice(0,5):null, desired_end:r.desired_end ? String(r.desired_end).slice(0,5):null }, offer_expires_at:r.offer_expires_at||null }; }
function coachEntryDto(r) {
  const a=rel(r.athletes)||{}, st=rel(r.session_types), slot=rel(r.bookable_slots);
  return { ...entryDto(r), athlete:{id:a.id||r.athlete_id,name:a.name||""}, session_type:st?{id:st.id,name:st.name||""}:null, offered_slot:slot?slotDto(slot):null, created_at:r.created_at };
}
function slotDto(r) { return { id:r.id, starts_at:r.starts_at, ends_at:r.ends_at, timezone:r.timezone, title:r.title||null, session_type_id:r.session_type_id||null }; }
function offerDto(r) { return { id:r.id, slot_id:r.slot_id, expires_at:r.expires_at, status:r.status }; }
function validEmail(v) { return typeof v === "string" && v.trim().length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()); }
function instant(clock) { const d=clock(); if (!(d instanceof Date) || !Number.isFinite(d.getTime())) throw new TypeError("invalid clock"); return d; }
function epoch(v) { const n = new Date(v).getTime(); return Number.isFinite(n) ? n : NaN; }
function localParts(value, zone) {
  const d=new Date(value); if (!Number.isFinite(d.getTime())) throw new DbError("SHAPE",500,"invalid timestamp");
  let parts; try { parts=new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(d); } catch (_) { throw new DbError("SHAPE",500,"invalid timezone"); }
  const out=Object.fromEntries(parts.map(x=>[x.type,x.value])); return {date:`${out.year}-${out.month}-${out.day}`,time:`${out.hour}:${out.minute}`};
}
function matches(entry, slot) {
  if (entry.session_type_id && entry.session_type_id !== slot.session_type_id) return false;
  const a=localParts(slot.starts_at,slot.timezone), b=localParts(slot.ends_at,slot.timezone);
  if (entry.desired_date && entry.desired_date !== a.date) return false;
  return !entry.desired_start || (a.time < entry.desired_end && b.time > entry.desired_start);
}

function decorateWaitlistBookPage(html, enabled=true) {
  if (typeof html !== "string") throw new TypeError("html required");
  if (!enabled) return html;
  const emptyStart='<div id="emptySlots" class="empty-slots" style="display:none">';
  if (html.split(emptyStart).length !== 2) throw new Error("waitlist book anchor mismatch");
  const emptyAt=html.indexOf(emptyStart), emptyEnd=html.indexOf("</div>",emptyAt);
  if (emptyEnd<0) throw new Error("waitlist book anchor mismatch");
  const emptyMarkup=html.slice(emptyAt,emptyEnd+6);
  const race='showSheetErr("That time was just taken. Pick another open slot.");';
  const success="showSuccess(confirmed);";
  const anchors=["/* ---------- States: loading / error / empty ---------- */",emptyMarkup,'var emptySlots = document.getElementById("emptySlots");',"function renderSlots(slots) {","show(emptySlots);",race,success];
  for (const a of anchors) if (html.split(a).length !== 2) throw new Error("waitlist book anchor mismatch");
  let out=html.replace(anchors[0],`/* COMPARE_GAP:WAITLIST:BOOK_STYLE:BEGIN */\n.wl-panel{padding:16px;border:1px solid #ddd}.wl-error{color:#8b1e1e}\n/* COMPARE_GAP:WAITLIST:BOOK_STYLE:END */\n${anchors[0]}`);
  out=out.replace(anchors[1],anchors[1]+`\n<!-- COMPARE_GAP:WAITLIST:BOOK_MARKUP:BEGIN -->\n<div id="wlPanel" class="wl-panel" style="display:none"><p id="wlStatus" aria-live="polite"></p><button id="wlJoin" type="button" style="display:none">Join the waitlist</button><button id="wlLeave" type="button" style="display:none">Leave the waitlist</button></div>\n<!-- COMPARE_GAP:WAITLIST:BOOK_MARKUP:END -->`);
  const refs=`\n/* COMPARE_GAP:WAITLIST:BOOK_REFS:BEGIN */\nvar wlPanel=document.getElementById('wlPanel'),wlStatus=document.getElementById('wlStatus'),wlJoin=document.getElementById('wlJoin'),wlLeave=document.getElementById('wlLeave'),wlState=null,wlBusy=false;\n/* COMPARE_GAP:WAITLIST:BOOK_REFS:END */`;
  out=out.replace(anchors[2],anchors[2]+refs);
  const logic=`/* COMPARE_GAP:WAITLIST:BOOK_LOGIC:BEGIN */
function wlEntry(v){if(v===null)return null;if(!v||typeof v.id!=='string'||!['waiting','offered','booked','cancelled'].includes(v.status)||!v.preference||typeof v.preference!=='object')throw 0;return{id:v.id,status:v.status,preference:{session_type_id:v.preference.session_type_id||null,desired_date:v.preference.desired_date||null,desired_start:v.preference.desired_start||null,desired_end:v.preference.desired_end||null},offer_expires_at:v.offer_expires_at||null}}
function renderWaitlist(){if(!wlState)return;show(wlPanel);hide(wlJoin);hide(wlLeave);if(wlState.entry){wlStatus.textContent=wlState.entry.status==='offered'?'A time is available. Book it before the offer expires.':'You are on the waitlist. This is not a reservation.';if(['waiting','offered'].includes(wlState.entry.status))show(wlLeave)}else if(wlState.can_join){wlStatus.textContent='No times fit right now. Join the waitlist to hear when one opens.';show(wlJoin)}else wlStatus.textContent='Open times are available above.'}
async function loadWaitlist(){try{var r=await fetch('/schedule/'+encodeURIComponent(inviteToken)+'/waitlist'),j=await r.json();if(!r.ok||!j||typeof j.enabled!=='boolean'||typeof j.can_join!=='boolean')throw 0;wlState={enabled:j.enabled,can_join:j.can_join,entry:wlEntry(j.entry)};renderWaitlist()}catch(_){wlState=null;wlStatus.textContent='Waitlist is unavailable.';show(wlPanel)}}
async function mutateWaitlist(path,body){if(wlBusy)return;wlBusy=true;wlJoin.disabled=true;wlLeave.disabled=true;try{var r=await fetch('/schedule/'+encodeURIComponent(inviteToken)+'/waitlist'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),j=await r.json();if(!r.ok||!j.entry)throw 0;wlState.entry=wlEntry(j.entry);renderWaitlist()}catch(_){wlStatus.textContent='Could not update the waitlist. Try again.'}finally{wlBusy=false;wlJoin.disabled=false;wlLeave.disabled=false}}
wlJoin.addEventListener('click',function(){mutateWaitlist('',{})});wlLeave.addEventListener('click',function(){if(wlState&&wlState.entry)mutateWaitlist('/leave',{entry_id:wlState.entry.id})});
/* COMPARE_GAP:WAITLIST:BOOK_LOGIC:END */
`;
  out=out.replace(anchors[3],logic+anchors[3]);
  out=out.replace(anchors[4],anchors[4]+"\n/* COMPARE_GAP:WAITLIST:BOOK_EMPTY:BEGIN */\nloadWaitlist();\n/* COMPARE_GAP:WAITLIST:BOOK_EMPTY:END */");
  out=out.replace(anchors[5],anchors[5]+"\n/* COMPARE_GAP:WAITLIST:BOOK_RACE:BEGIN */\nif(wlState&&wlState.entry&&wlState.entry.status==='offered')showSheetErr(\"That time was just booked. You’re still on the waitlist.\");\n/* COMPARE_GAP:WAITLIST:BOOK_RACE:END */");
  out=out.replace(anchors[6],"/* COMPARE_GAP:WAITLIST:BOOK_SUCCESS:BEGIN */\nif(wlState&&wlState.entry)fetch('/schedule/'+encodeURIComponent(inviteToken)+'/waitlist/converted',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).catch(function(){});\n/* COMPARE_GAP:WAITLIST:BOOK_SUCCESS:END */\n"+anchors[6]);
  return out;
}

function buildWaitlistHandlers(deps) {
  const { requireSupabaseUser, notify, sendEmail=sendTransactionalEmail, getBookBaseUrl,
    now=()=>new Date(), randomUUID=()=>crypto.randomUUID(), protectionEnabled=false } = deps||{};
  async function auth(req,res){
    if(typeof requireSupabaseUser!=="function"){fail(res,503,"not_configured");return null;}
    const x=await requireSupabaseUser(req); if(!x||x.error){fail(res,x&&x.status||401,x&&x.error||"unauthorized");return null;}
    const u=x.user||{}; if(!u.app_metadata||u.app_metadata.role!=="coach"){fail(res,403,"forbidden");return null;} return u.id;
  }
  async function capability(s, raw, accepted=false) {
    const token=validUuid(raw)?raw.toLowerCase():ZERO_UUID;
    const row=one(await get(s,`booking_invites?token=eq.${enc(token)}&select=token,coach_id,athlete_id,slot_id,email,status,expires_at&limit=1`));
    const ok=row&&row.athlete_id&&row.status===(accepted?"accepted":"pending")&&epoch(row.expires_at)>instant(now).getTime(); return ok?row:null;
  }
  async function service(s,coachId,id,requireEnabled){
    if(!id)return null; const r=one(await get(s,`session_types?id=eq.${enc(id)}&coach_id=eq.${enc(coachId)}&active=eq.true&select=id,name,price_cents,waitlist_enabled&limit=1`));
    return r&&(!requireEnabled||r.waitlist_enabled!==false)?r:null;
  }
  async function athlete(s,coachId,id){return one(await get(s,`athletes?id=eq.${enc(id)}&coach_id=eq.${enc(coachId)}&select=id,coach_id,name,user_id,parent_email&limit=1`));}
  async function reachable(s,coachId,id,fallback){const a=await athlete(s,coachId,id); if(!a)return null; if(!a.user_id&&!validEmail(a.parent_email)&&!validEmail(fallback))return false; return {...a,parent_email:validEmail(a.parent_email)?a.parent_email.trim():(validEmail(fallback)?fallback.trim():null)};}
  async function activeEntry(s,coachId,athleteId,key){return one(await get(s,`waitlist_entries?coach_id=eq.${enc(coachId)}&athlete_id=eq.${enc(athleteId)}&scope_key=eq.${enc(key)}&status=in.(waiting,offered)&select=*&limit=1`));}
  async function openCapacity(s,coachId,date,at){let p=`bookable_slots?coach_id=eq.${enc(coachId)}&status=eq.open&starts_at=gt.${enc(at.toISOString())}&select=id,starts_at,timezone&limit=100`; const rows=await get(s,p); if(!date)return rows.length>0; return rows.some(r=>localParts(r.starts_at,r.timezone).date===date);}
  async function createEntry(s,coachId,a,pref,source,allowCapacity) {
    const key=scopeKey(pref), old=await activeEntry(s,coachId,a.id,key); if(old)return {row:old,created:false};
    if(!allowCapacity&&await openCapacity(s,coachId,pref.desired_date,instant(now)))return {error:"slots_available"};
    const st=await service(s,coachId,pref.session_type_id,!allowCapacity); if(pref.session_type_id&&!st)return {notFound:true};
    let rows; try { rows=await post(s,"waitlist_entries",{coach_id:coachId,athlete_id:a.id,session_type_id:pref.session_type_id,desired_date:pref.desired_date,desired_start:pref.desired_start,desired_end:pref.desired_end,scope_key:key,source,status:"waiting",priority_cents:st&&Number.isInteger(st.price_cents)?st.price_cents:null}); }
    catch(err){const p=payload(err); if(err.status===409&&p&&p.code==="23505"&&/waitlist_entries_active_scope_uidx/.test(`${p.constraint||""} ${p.message||""} ${p.details||""}`)){const same=await activeEntry(s,coachId,a.id,key);if(same)return {row:same,created:false};return {error:"conflict"};} throw err;}
    const row=one(rows); if(!row||!row.id)throw new DbError("POST",500,"missing representation"); return {row,created:true};
  }
  async function getPublicWaitlist(req,res){try{if(!exact(req.query||{},[])||!exact(req.body||{},[]))return fail(res,400,"invalid_request");const s=sb();if(!s)return fail(res,503,"not_configured");const cap=await capability(s,req.params&&req.params.inviteToken);if(!cap)return fail(res,404,"not_found");const row=one(await get(s,`waitlist_entries?coach_id=eq.${enc(cap.coach_id)}&athlete_id=eq.${enc(cap.athlete_id)}&status=in.(waiting,offered)&select=*&order=created_at.asc&limit=1`));const can=!(await openCapacity(s,cap.coach_id,null,instant(now)));return send(res,200,{enabled:true,can_join:can,entry:row?entryDto(row):null});}catch(e){return unexpected(res,e);}}
  async function postPublicJoin(req,res){try{const pref=parsePreference(req.body,false);if(!pref||!exact(req.query||{},[])||!boundedPreference(pref,instant(now)))return fail(res,400,"invalid_body");const s=sb();if(!s)return fail(res,503,"not_configured");const cap=await capability(s,req.params&&req.params.inviteToken);if(!cap)return fail(res,404,"not_found");const a=await reachable(s,cap.coach_id,cap.athlete_id,cap.email);if(!a)return fail(res,a===false?409:404,a===false?"waiter_unreachable":"not_found");const out=await createEntry(s,cap.coach_id,a,pref,"athlete",false);if(out.notFound)return fail(res,404,"not_found");if(out.error)return fail(res,409,out.error);return send(res,out.created?201:200,{entry:entryDto(out.row)});}catch(e){return unexpected(res,e);}}
  async function postPublicLeave(req,res){try{if(!exact(req.body,["entry_id"])||!validUuid(req.body.entry_id)||!exact(req.query||{},[]))return fail(res,400,"invalid_body");const s=sb();if(!s)return fail(res,503,"not_configured");const cap=await capability(s,req.params&&req.params.inviteToken);if(!cap)return fail(res,404,"not_found");let row=one(await get(s,`waitlist_entries?id=eq.${enc(req.body.entry_id)}&coach_id=eq.${enc(cap.coach_id)}&athlete_id=eq.${enc(cap.athlete_id)}&select=*&limit=1`));if(!row)return fail(res,404,"not_found");if(row.status==="waiting"||row.status==="offered"){const changed=one(await patch(s,`waitlist_entries?id=eq.${enc(row.id)}&coach_id=eq.${enc(cap.coach_id)}&athlete_id=eq.${enc(cap.athlete_id)}&status=in.(waiting,offered)`,{status:"cancelled",offer_expires_at:null}));if(changed)row=changed;else row=one(await get(s,`waitlist_entries?id=eq.${enc(row.id)}&coach_id=eq.${enc(cap.coach_id)}&athlete_id=eq.${enc(cap.athlete_id)}&select=*&limit=1`));}if(!row)return fail(res,404,"not_found");return send(res,200,{entry:entryDto(row)});}catch(e){return unexpected(res,e);}}
  async function postPublicConverted(req,res){try{if(!exact(req.body,[])||!exact(req.query||{},[]))return fail(res,400,"invalid_body");const s=sb();if(!s)return fail(res,503,"not_configured");const cap=await capability(s,req.params&&req.params.inviteToken,true);if(!cap)return fail(res,404,"not_found");let offer=one(await get(s,`waitlist_offers?booking_invite_token=eq.${enc(cap.token)}&coach_id=eq.${enc(cap.coach_id)}&slot_id=eq.${enc(cap.slot_id)}&select=*&limit=1`));if(!offer)return fail(res,404,"not_found");if(offer.status!=="booked"){const booked=one(await get(s,`bookable_slots?id=eq.${enc(offer.slot_id)}&coach_id=eq.${enc(cap.coach_id)}&booked_by=eq.${enc(cap.athlete_id)}&status=eq.booked&select=id&limit=1`));if(!booked)return fail(res,409,"conflict");await patch(s,`waitlist_offers?id=eq.${enc(offer.id)}&coach_id=eq.${enc(cap.coach_id)}&entry_id=eq.${enc(offer.entry_id)}&status=in.(pending,notified)`,{status:"booked"});await patch(s,`waitlist_entries?id=eq.${enc(offer.entry_id)}&coach_id=eq.${enc(cap.coach_id)}&athlete_id=eq.${enc(cap.athlete_id)}&offered_slot_id=eq.${enc(offer.slot_id)}&status=in.(waiting,offered)`,{status:"booked",offer_expires_at:null});}return send(res,200,{state:"booked"});}catch(e){return unexpected(res,e);}}
  async function getCoachWaitlist(req,res){try{const q=req.query||{};if(!exact(q,["status"])||(Object.hasOwn(q,"status")&&(!STATUSES.has(q.status)||typeof q.status!=="string"))||!exact(req.body||{},[]))return fail(res,400,"invalid_query");const coachId=await auth(req,res);if(!coachId)return;const s=sb();if(!s)return fail(res,503,"not_configured");const filter=q.status?`eq.${q.status}`:"in.(waiting,offered)";const rows=await get(s,`waitlist_entries?coach_id=eq.${enc(coachId)}&status=${filter}&select=*,athletes(id,name),session_types(id,name),bookable_slots:offered_slot_id(id,starts_at,ends_at,timezone,title,session_type_id)&order=desired_date.asc.nullslast,created_at.asc`);const slots=await get(s,`bookable_slots?coach_id=eq.${enc(coachId)}&status=eq.open&starts_at=gt.${enc(instant(now).toISOString())}&select=id,starts_at,ends_at,timezone,title,session_type_id&order=starts_at.asc&limit=100`);return send(res,200,{entries:rows.map(coachEntryDto),open_slots:slots.map(slotDto)});}catch(e){return unexpected(res,e);}}
  async function postCoachWaitlist(req,res){try{const pref=parsePreference(req.body,true);if(!pref||!exact(req.query||{},[])||!boundedPreference(pref,instant(now)))return fail(res,400,"invalid_body");const coachId=await auth(req,res);if(!coachId)return;const s=sb();if(!s)return fail(res,503,"not_configured");const a=await reachable(s,coachId,req.body.athlete_id);if(!a)return fail(res,a===false?409:404,a===false?"waiter_unreachable":"not_found");if(pref.session_type_id&&!await service(s,coachId,pref.session_type_id,false))return fail(res,404,"not_found");const out=await createEntry(s,coachId,a,pref,"coach",true);if(out.error)return fail(res,409,out.error);return send(res,out.created?201:200,{entry:entryDto(out.row)});}catch(e){return unexpected(res,e);}}
  async function deleteCoachWaitlist(req,res){try{if(!validUuid(req.params&&req.params.id)||!exact(req.query||{},[])||!exact(req.body||{},[]))return fail(res,400,"invalid_id");const coachId=await auth(req,res);if(!coachId)return;const s=sb();if(!s)return fail(res,503,"not_configured");let row=one(await get(s,`waitlist_entries?id=eq.${enc(req.params.id)}&coach_id=eq.${enc(coachId)}&select=*&limit=1`));if(!row)return fail(res,404,"not_found");if(row.status==="waiting"||row.status==="offered")row=one(await patch(s,`waitlist_entries?id=eq.${enc(row.id)}&coach_id=eq.${enc(coachId)}&status=in.(waiting,offered)`,{status:"cancelled",offer_expires_at:null}))||one(await get(s,`waitlist_entries?id=eq.${enc(row.id)}&coach_id=eq.${enc(coachId)}&select=*&limit=1`));if(!row)return fail(res,404,"not_found");return send(res,200,{entry:entryDto(row)});}catch(e){return unexpected(res,e);}}
  async function settings(s,coachId){const c=one(await get(s,`coaches?id=eq.${enc(coachId)}&select=id,waitlist_mode,waitlist_offer_window_min&limit=1`));if(!c)return null;const services=await get(s,`session_types?coach_id=eq.${enc(coachId)}&active=eq.true&select=id,name,waitlist_enabled&order=name.asc`);return {mode:c.waitlist_mode,offer_window_min:c.waitlist_offer_window_min,services:services.map(x=>({id:x.id,name:x.name||"",waitlist_enabled:x.waitlist_enabled!==false}))};}
  async function getWaitlistSettings(req,res){try{if(!exact(req.query||{},[])||!exact(req.body||{},[]))return fail(res,400,"invalid_request");const coachId=await auth(req,res);if(!coachId)return;const s=sb();if(!s)return fail(res,503,"not_configured");const dto=await settings(s,coachId);return dto?send(res,200,dto):fail(res,404,"not_found");}catch(e){return unexpected(res,e);}}
  async function patchWaitlistSettings(req,res){try{const b=req.body;if(!exact(b,["mode","offer_window_min","services"])||!Object.keys(b).length||(Object.hasOwn(b,"mode")&&!MODES.has(b.mode))||(Object.hasOwn(b,"offer_window_min")&&!WINDOWS.has(b.offer_window_min))||(Object.hasOwn(b,"services")&&(!Array.isArray(b.services)||b.services.length>100||b.services.some(x=>!exact(x,["id","enabled"])||!validUuid(x.id)||typeof x.enabled!=="boolean")||new Set(b.services.map(x=>x.id.toLowerCase())).size!==b.services.length)))return fail(res,400,"invalid_body");const coachId=await auth(req,res);if(!coachId)return;const s=sb();if(!s)return fail(res,503,"not_configured");if(b.services)for(const x of b.services)if(!await service(s,coachId,x.id,false))return fail(res,404,"not_found");const coachPatch={};if(Object.hasOwn(b,"mode"))coachPatch.waitlist_mode=b.mode;if(Object.hasOwn(b,"offer_window_min"))coachPatch.waitlist_offer_window_min=b.offer_window_min;if(Object.keys(coachPatch).length&&!one(await patch(s,`coaches?id=eq.${enc(coachId)}`,coachPatch)))return fail(res,404,"not_found");if(b.services)for(const x of b.services){if(!one(await patch(s,`session_types?id=eq.${enc(x.id)}&coach_id=eq.${enc(coachId)}&active=eq.true`,{waitlist_enabled:x.enabled})))return fail(res,404,"not_found");}const dto=await settings(s,coachId);return dto?send(res,200,dto):fail(res,404,"not_found");}catch(e){return unexpected(res,e);}}
  async function protectedOn(){return typeof protectionEnabled==="function"?!!(await protectionEnabled()):!!protectionEnabled;}
  async function hasCard(s,coachId,athleteId){return !!one(await get(s,`athlete_payment_methods?coach_id=eq.${enc(coachId)}&athlete_id=eq.${enc(athleteId)}&status=eq.active&select=id&limit=1`));}
  async function safeNotify(x){if(typeof notify==="function")try{await notify(x);}catch(_) {}}
  async function safeEmail(x){if(typeof sendEmail!=="function")return false;try{await sendEmail(x);return true;}catch(_){return false;}}
  function offerEvent(a,e,slot,url,round){return {userId:a.user_id,type:"waitlist.offer",title:"A session opened up",body:"A time you wanted is open. First confirmed booking gets it.",data:{entryId:e.id,slotId:slot.id,href:url},dedupeKey:`waitlist.offer:${slot.id}:${round}:${e.id}`,...(a.parent_email?{email:a.parent_email}:{})};}
  async function makeOffer(s,coachId,e,slot,mode,window,manual=false){
    const at=instant(now), minutes=mode==="instant_book"?1440:window, expiry=new Date(Math.min(epoch(slot.starts_at),at.getTime()+minutes*60000));
    if(!Number.isFinite(expiry.getTime())||expiry.getTime()<=at.getTime())return {error:"slot_not_open"};
    const token=randomUUID();if(!validUuid(token))throw new TypeError("randomUUID returned invalid UUID");
    const a=await reachable(s,coachId,e.athlete_id);if(!a)return {error:a===false?"waiter_unreachable":"not_found"};
    let offer,created=true;try{
      const inv=one(await post(s,"booking_invites",{token,coach_id:coachId,athlete_id:e.athlete_id,slot_id:slot.id,email:a.parent_email||null,status:"pending",expires_at:expiry.toISOString()}));if(!inv)throw new DbError("POST",500,"missing invite");
      offer=one(await post(s,"waitlist_offers",{coach_id:coachId,entry_id:e.id,slot_id:slot.id,fill_round:slot.waitlist_fill_round,booking_invite_token:token,status:"pending",expires_at:expiry.toISOString()}));if(!offer)throw new DbError("POST",500,"missing offer");
    }catch(err){const p=payload(err);if(err.status===409&&p&&p.code==="23505"&&/waitlist_offers_entry_slot_round_uidx/.test(`${p.constraint||""} ${p.message||""} ${p.details||""}`)){offer=one(await get(s,`waitlist_offers?coach_id=eq.${enc(coachId)}&entry_id=eq.${enc(e.id)}&slot_id=eq.${enc(slot.id)}&fill_round=eq.${slot.waitlist_fill_round}&select=*&limit=1`));created=false;if(!offer)return {error:"conflict"};}else throw err;}
    const url=`${String(typeof getBookBaseUrl==="function"?getBookBaseUrl():process.env.SCHEDULING_PUBLIC_URL||"https://coachtime.app").replace(/\/+$/g,"")}/book/${offer.booking_invite_token}`;
    if(mode!=="instant_book"){const moved=one(await patch(s,`waitlist_entries?id=eq.${enc(e.id)}&coach_id=eq.${enc(coachId)}&athlete_id=eq.${enc(e.athlete_id)}&status=eq.waiting`,{status:"offered",offered_slot_id:slot.id,offer_expires_at:offer.expires_at,last_offered_round:slot.waitlist_fill_round}));if(!moved&&!created){const live=one(await get(s,`waitlist_entries?id=eq.${enc(e.id)}&coach_id=eq.${enc(coachId)}&select=*&limit=1`));if(!live||live.offered_slot_id!==slot.id||Number(live.last_offered_round)!==Number(slot.waitlist_fill_round))return {error:"entry_not_waiting"};}else if(!moved)return {error:"entry_not_waiting"};e=moved||e;}
    if(a.user_id)await safeNotify(offerEvent(a,e,slot,url,slot.waitlist_fill_round));else if(!offer.notified_at){if(await safeEmail({to:a.parent_email,subject:"A session opened up",html:brandedEmailShell(`<tr><td><p>A time you wanted is open. <a href="${escapeHtml(url)}">Book it</a>.</p></td></tr>`),text:buildPlainText(["A time you wanted is open.",url])}))offer=one(await patch(s,`waitlist_offers?id=eq.${enc(offer.id)}&coach_id=eq.${enc(coachId)}&notified_at=is.null`,{status:"notified",notified_at:at.toISOString()}))||offer;}
    else offer=one(await patch(s,`waitlist_offers?id=eq.${enc(offer.id)}&coach_id=eq.${enc(coachId)}&status=eq.pending`,{status:"notified",notified_at:at.toISOString()}))||offer;
    return {entry:e,offer,created};
  }
  async function fillCore(s,coachId,slot){
    const base={fill_round:null,mode:null,matched:0,offered:0};
    const live=one(await get(s,`bookable_slots?id=eq.${enc(slot.id)}&coach_id=eq.${enc(coachId)}&status=eq.open&select=id,coach_id,status,starts_at,ends_at,timezone,title,session_type_id,waitlist_fill_round&limit=1`));if(!live)return {...base,disposition:"slot_not_open"};
    const cfg=one(await get(s,`coaches?id=eq.${enc(coachId)}&select=id,waitlist_mode,waitlist_offer_window_min&limit=1`));if(!cfg||!MODES.has(cfg.waitlist_mode)||!WINDOWS.has(cfg.waitlist_offer_window_min))throw new DbError("GET",500,"invalid settings");base.fill_round=Number(live.waitlist_fill_round);base.mode=cfg.waitlist_mode;
    if(live.session_type_id){const st=await service(s,coachId,live.session_type_id,false);if(!st||st.waitlist_enabled===false)return {...base,disposition:"service_disabled"};}
    let rows=await get(s,`waitlist_entries?coach_id=eq.${enc(coachId)}&status=eq.waiting&select=*,athletes(id,name,user_id,parent_email)&order=created_at.asc,id.asc`);rows=rows.filter(e=>(e.last_offered_round==null||Number(e.last_offered_round)!==base.fill_round)&&matches(e,live));
    if(await protectedOn()){try{const kept=[];for(const e of rows)if(await hasCard(s,coachId,e.athlete_id))kept.push(e);rows=kept;}catch(_){return {...base,disposition:"card_check_unavailable"};}}
    if(cfg.waitlist_mode==="revenue_max")rows.sort((a,b)=>(b.priority_cents||0)-(a.priority_cents||0)||String(a.created_at).localeCompare(String(b.created_at))||String(a.id).localeCompare(String(b.id)));
    base.matched=rows.length;if(!rows.length)return {...base,disposition:"no_match"};const chosen=cfg.waitlist_mode==="instant_book"?rows:rows.slice(0,1);for(const e of chosen){const x=await makeOffer(s,coachId,e,live,cfg.waitlist_mode,cfg.waitlist_offer_window_min);if(!x.error)base.offered++;}return {...base,disposition:base.offered?"offered":"no_match"};
  }
  async function tryFillFromWaitlist(args){if(!exact(args,["coachId","slot"])||!validUuid(args.coachId)||!args.slot||!exact(args.slot,["id","status","starts_at","ends_at","timezone","session_type_id"])||!validUuid(args.slot.id))throw new TypeError("invalid waitlist fill arguments");const s=sb();if(!s)throw new DbError("CONFIG",503,"not configured");return fillCore(s,args.coachId,args.slot);}
  async function postCoachOffer(req,res){try{if(!validUuid(req.params&&req.params.id)||!exact(req.body,["slot_id"])||!validUuid(req.body.slot_id)||!exact(req.query||{},[]))return fail(res,400,"invalid_body");const coachId=await auth(req,res);if(!coachId)return;const s=sb();if(!s)return fail(res,503,"not_configured");const e=one(await get(s,`waitlist_entries?id=eq.${enc(req.params.id)}&coach_id=eq.${enc(coachId)}&select=*&limit=1`));if(!e)return fail(res,404,"not_found");if(e.status!=="waiting")return fail(res,409,"entry_not_waiting");const slot=one(await get(s,`bookable_slots?id=eq.${enc(req.body.slot_id)}&coach_id=eq.${enc(coachId)}&select=id,coach_id,status,starts_at,ends_at,timezone,title,session_type_id,waitlist_fill_round&limit=1`));if(!slot)return fail(res,404,"not_found");if(slot.status!=="open"||epoch(slot.starts_at)<=instant(now).getTime())return fail(res,409,"slot_not_open");if(!matches(e,slot))return fail(res,409,"preference_mismatch");if(await protectedOn()){try{if(!await hasCard(s,coachId,e.athlete_id))return fail(res,409,"needs_card");}catch(_){return fail(res,502,"upstream_unavailable");}}const cfg=await settings(s,coachId);const x=await makeOffer(s,coachId,e,slot,"first_in_line",cfg.offer_window_min,true);if(x.error)return fail(res,409,x.error);return send(res,x.created?201:200,{entry:entryDto(x.entry),offer:offerDto(x.offer)});}catch(e){return unexpected(res,e);}}
  async function expireWaitlistOffers(args={}){if(!exact(args,["now","limit"]))throw new TypeError("invalid expiry arguments");const limit=args.limit===undefined?100:args.limit;if(!Number.isInteger(limit)||limit<1||limit>200)throw new TypeError("invalid expiry limit");const at=args.now===undefined?instant(now):(args.now instanceof Date?args.now:new Date(args.now));if(!Number.isFinite(at.getTime()))throw new TypeError("invalid expiry now");const s=sb();if(!s)throw new DbError("CONFIG",503,"not configured");const rows=await get(s,`waitlist_offers?status=in.(pending,notified)&expires_at=lte.${enc(at.toISOString())}&select=*&order=expires_at.asc&limit=${limit}`);const out={examined:rows.length,expired:0,rolled:0};for(const o of rows){const changed=one(await patch(s,`waitlist_offers?id=eq.${enc(o.id)}&coach_id=eq.${enc(o.coach_id)}&expires_at=eq.${enc(o.expires_at)}&status=in.(pending,notified)`,{status:"expired"}));if(!changed)continue;out.expired++;if(o.booking_invite_token)await patch(s,`booking_invites?token=eq.${enc(o.booking_invite_token)}&coach_id=eq.${enc(o.coach_id)}&status=eq.pending`,{status:"expired"});await patch(s,`waitlist_entries?id=eq.${enc(o.entry_id)}&coach_id=eq.${enc(o.coach_id)}&offered_slot_id=eq.${enc(o.slot_id)}&last_offered_round=eq.${o.fill_round}&status=eq.offered`,{status:"waiting",offer_expires_at:null});const r=await fillCore(s,o.coach_id,{id:o.slot_id});if(r.disposition==="offered")out.rolled++;}return out;}
  return {getPublicWaitlist,postPublicJoin,postPublicLeave,postPublicConverted,getCoachWaitlist,postCoachWaitlist,deleteCoachWaitlist,postCoachOffer,getWaitlistSettings,patchWaitlistSettings,tryFillFromWaitlist,expireWaitlistOffers};
}

module.exports = { buildWaitlistHandlers, decorateWaitlistBookPage };
