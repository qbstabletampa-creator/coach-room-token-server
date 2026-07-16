const test = require("node:test");
const assert = require("node:assert/strict");
const { buildWaitlistHandlers, decorateWaitlistBookPage } = require("../lib/waitlist");

const C="11111111-1111-4111-8111-111111111111", A="22222222-2222-4222-8222-222222222222", S="33333333-3333-4333-8333-333333333333", E="44444444-4444-4444-8444-444444444444", T="55555555-5555-4555-8555-555555555555";
function res(){return{statusCode:200,body:null,status(n){this.statusCode=n;return this},json(x){this.body=x;return this}}}
function req(x={}){return{body:{},query:{},params:{},headers:{"content-type":"application/json"},...x}}
function coach(){return async()=>({user:{id:C,app_metadata:{role:"coach"},user_metadata:{role:"athlete"}}})}
function response(body,status=200){return{ok:status>=200&&status<300,status,text:async()=>typeof body==="string"?body:JSON.stringify(body)}}

test("exports exact inert factory surface",()=>{
  let calls=0; const h=buildWaitlistHandlers({requireSupabaseUser(){calls++},notify(){calls++},now(){calls++},randomUUID(){calls++}});
  assert.deepEqual(Object.keys(h),["getPublicWaitlist","postPublicJoin","postPublicLeave","postPublicConverted","getCoachWaitlist","postCoachWaitlist","deleteCoachWaitlist","postCoachOffer","getWaitlistSettings","patchWaitlistSettings","tryFillFromWaitlist","expireWaitlistOffers"]);
  assert.equal(calls,0);
});

test("all protected shape checks precede identity",async()=>{
  let auths=0;const h=buildWaitlistHandlers({requireSupabaseUser:async()=>{auths++;return{error:"unauthorized",status:401}}});
  const cases=[[h.getCoachWaitlist,req({query:{status:["waiting"]}})],[h.postCoachWaitlist,req({body:{athlete_id:"bad"}})],[h.deleteCoachWaitlist,req({params:{id:"bad"}})],[h.postCoachOffer,req({params:{id:A},body:{slot_id:"bad"}})],[h.patchWaitlistSettings,req({body:{mode:"fast"}})]];
  for(const [fn,r] of cases){const o=res();await fn(r,o);assert.equal(o.statusCode,400)}assert.equal(auths,0);
});

test("role reads app_metadata only",async()=>{
  const h=buildWaitlistHandlers({requireSupabaseUser:async()=>({user:{id:C,app_metadata:{},user_metadata:{role:"coach"}}})});
  const o=res();await h.getWaitlistSettings(req(),o);assert.deepEqual([o.statusCode,o.body],[403,{error:"forbidden"}]);
});

test("fill validates caller shape before config",async()=>{
  const h=buildWaitlistHandlers({requireSupabaseUser:coach()});
  await assert.rejects(()=>h.tryFillFromWaitlist({coachId:C,slot:{id:"bad"}}),TypeError);
  await assert.rejects(()=>h.expireWaitlistOffers({limit:201}),TypeError);
});

test("decorator is pure, exact-anchor guarded, and uses safe URL encoding",()=>{
  const html='/* ---------- States: loading / error / empty ---------- */\n<div id="emptySlots" class="empty-slots" style="display:none">\n          No open times right now. Your coach adds new slots often, check back soon or ask them to open one.\n        </div>\nvar emptySlots = document.getElementById("emptySlots");\nfunction renderSlots(slots) {\nshow(emptySlots);\nshowSheetErr("That time was just taken. Pick another open slot.");\nshowSuccess(confirmed);';
  const out=decorateWaitlistBookPage(html);assert.match(out,/COMPARE_GAP:WAITLIST:BOOK_STYLE:BEGIN/);assert.match(out,/encodeURIComponent/);assert.doesNotMatch(out,/innerHTML/);assert.throws(()=>decorateWaitlistBookPage(html+html));
});

test("missing database configuration is deterministic",async()=>{
  const old=[process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY];delete process.env.SUPABASE_URL;delete process.env.SUPABASE_SERVICE_KEY;
  const h=buildWaitlistHandlers({requireSupabaseUser:coach()});const o=res();await h.getWaitlistSettings(req(),o);assert.deepEqual([o.statusCode,o.body],[503,{error:"not_configured"}]);
  [process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY]=old;
});

test("public malformed capability is normalized and lookup miss is uniform",async()=>{
  process.env.SUPABASE_URL="https://db.test";process.env.SUPABASE_SERVICE_KEY="k";const old=global.fetch,calls=[];
  global.fetch=async(url)=>{calls.push(String(url));return{ok:true,status:200,text:async()=>"[]"}};
  try{const h=buildWaitlistHandlers({});for(const token of ["bad",S]){const o=res();await h.getPublicWaitlist(req({params:{inviteToken:token}}),o);assert.deepEqual([o.statusCode,o.body],[404,{error:"not_found"}]);}assert.match(calls[0],/token=eq.00000000-0000-0000-0000-000000000000/);}finally{global.fetch=old}
});

test("2xx invalid JSON and storage rejection never become raw 500 TypeErrors",async()=>{
  process.env.SUPABASE_URL="https://db.test";process.env.SUPABASE_SERVICE_KEY="k";const old=global.fetch;const h=buildWaitlistHandlers({});
  try{global.fetch=async()=>({ok:true,status:200,text:async()=>"no"});let o=res();await h.getPublicWaitlist(req({params:{inviteToken:S}}),o);assert.equal(o.statusCode,500);global.fetch=async()=>{throw new TypeError("secret")};o=res();await h.getPublicWaitlist(req({params:{inviteToken:S}}),o);assert.deepEqual([o.statusCode,o.body],[502,{error:"upstream_unavailable"}]);}finally{global.fetch=old}
});

test("fill re-reads authoritative slot and pending_approval never reaches waiter work",async()=>{process.env.SUPABASE_URL="https://db.test";process.env.SUPABASE_SERVICE_KEY="k";const old=global.fetch,calls=[];global.fetch=async url=>{calls.push(String(url));return response([])};try{const h=buildWaitlistHandlers({now:()=>new Date("2026-07-16T12:00:00Z")});const x=await h.tryFillFromWaitlist({coachId:C,slot:{id:S,status:"open",starts_at:"2099-01-01T00:00:00Z"}});assert.deepEqual(x,{fill_round:null,mode:null,matched:0,offered:0,disposition:"slot_not_open"});assert.equal(calls.length,1);assert.match(calls[0],/coach_id=eq\./);assert.match(calls[0],/status=eq.open/)}finally{global.fetch=old}});

test("protection card lookup outage fails the whole fill closed",async()=>{process.env.SUPABASE_URL="https://db.test";process.env.SUPABASE_SERVICE_KEY="k";const old=global.fetch;global.fetch=async url=>{url=String(url);if(url.includes("bookable_slots?"))return response([{id:S,coach_id:C,status:"open",starts_at:"2026-07-17T12:00:00Z",ends_at:"2026-07-17T13:00:00Z",timezone:"UTC",title:null,session_type_id:null,waitlist_fill_round:4}]);if(url.includes("coaches?"))return response([{id:C,waitlist_mode:"instant_book",waitlist_offer_window_min:10}]);if(url.includes("waitlist_entries?"))return response([{id:E,coach_id:C,athlete_id:A,status:"waiting",session_type_id:null,desired_date:null,desired_start:null,desired_end:null,last_offered_round:null,created_at:"2026-07-01T00:00:00Z"}]);if(url.includes("athlete_payment_methods?"))return response({code:"PGRST"},503);throw new Error("offer work must not run")};try{const h=buildWaitlistHandlers({now:()=>new Date("2026-07-16T12:00:00Z"),protectionEnabled:true,notify:()=>{throw new Error("must not notify")}});const x=await h.tryFillFromWaitlist({coachId:C,slot:{id:S}});assert.equal(x.disposition,"card_check_unavailable");assert.equal(x.offered,0)}finally{global.fetch=old}});

test("round-zero fill treats null last_offered_round as distinct and retry reuses the durable offer",async()=>{process.env.SUPABASE_URL="https://db.test";process.env.SUPABASE_SERVICE_KEY="k";const old=global.fetch,events=[];let offerPosts=0;const offer={id:"66666666-6666-4666-8666-666666666666",coach_id:C,entry_id:E,slot_id:S,fill_round:0,booking_invite_token:T,status:"pending",expires_at:"2026-07-17T12:00:00Z",notified_at:null};global.fetch=async(url,opt={})=>{url=String(url);const method=opt.method||"GET";if(url.includes("bookable_slots?"))return response([{id:S,coach_id:C,status:"open",starts_at:"2026-07-17T12:00:00Z",ends_at:"2026-07-17T13:00:00Z",timezone:"UTC",title:null,session_type_id:null,waitlist_fill_round:0}]);if(url.includes("coaches?"))return response([{id:C,waitlist_mode:"instant_book",waitlist_offer_window_min:10}]);if(url.includes("waitlist_entries?"))return response([{id:E,coach_id:C,athlete_id:A,status:"waiting",session_type_id:null,desired_date:null,desired_start:null,desired_end:null,last_offered_round:null,created_at:"2026-07-01T00:00:00Z"}]);if(url.includes("athletes?"))return response([{id:A,coach_id:C,name:"Avery",user_id:A,parent_email:"parent@example.com"}]);if(url.endsWith("/booking_invites")&&method==="POST")return response([{token:T}]);if(url.endsWith("/waitlist_offers")&&method==="POST"){offerPosts++;return offerPosts===1?response([offer]):response({code:"23505",message:"waitlist_offers_entry_slot_round_uidx"},409)}if(url.includes("waitlist_offers?"))return response([offer]);throw new Error(`unexpected ${method} ${url}`)};try{const h=buildWaitlistHandlers({now:()=>new Date("2026-07-16T12:00:00Z"),randomUUID:()=>T,notify:async x=>{events.push(x)}});for(let i=0;i<2;i++){const x=await h.tryFillFromWaitlist({coachId:C,slot:{id:S}});assert.equal(x.disposition,"offered")}assert.equal(events.length,2);assert.equal(new Set(events.map(x=>x.dedupeKey)).size,1);assert.equal(events[0].dedupeKey,`waitlist.offer:${S}:0:${E}`);assert.deepEqual(events[0].data,{entryId:E,slotId:S,href:`https://coachtime.app/book/${T}`})}finally{global.fetch=old}});

test("manual offer distinguishes needs_card from waiter_unreachable",async()=>{process.env.SUPABASE_URL="https://db.test";process.env.SUPABASE_SERVICE_KEY="k";const old=global.fetch,entry={id:E,coach_id:C,athlete_id:A,status:"waiting",session_type_id:null,desired_date:null,desired_start:null,desired_end:null},slot={id:S,coach_id:C,status:"open",starts_at:"2026-07-17T12:00:00Z",ends_at:"2026-07-17T13:00:00Z",timezone:"UTC",title:null,session_type_id:null,waitlist_fill_round:1};global.fetch=async url=>{url=String(url);if(url.includes("waitlist_entries?"))return response([entry]);if(url.includes("bookable_slots?"))return response([slot]);if(url.includes("athlete_payment_methods?"))return response([]);if(url.includes("coaches?"))return response([{id:C,waitlist_mode:"first_in_line",waitlist_offer_window_min:10}]);if(url.includes("session_types?"))return response([]);if(url.includes("athletes?"))return response([{id:A,coach_id:C,name:"Avery",user_id:null,parent_email:null}]);throw new Error(`unexpected ${url}`)};try{let h=buildWaitlistHandlers({requireSupabaseUser:coach(),now:()=>new Date("2026-07-16T12:00:00Z"),protectionEnabled:true}),o=res();await h.postCoachOffer(req({params:{id:E},body:{slot_id:S}}),o);assert.deepEqual([o.statusCode,o.body],[409,{error:"needs_card"}]);h=buildWaitlistHandlers({requireSupabaseUser:coach(),now:()=>new Date("2026-07-16T12:00:00Z"),protectionEnabled:false});o=res();await h.postCoachOffer(req({params:{id:E},body:{slot_id:S}}),o);assert.deepEqual([o.statusCode,o.body],[409,{error:"waiter_unreachable"}])}finally{global.fetch=old}});
