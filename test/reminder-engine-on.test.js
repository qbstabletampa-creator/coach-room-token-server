const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRemindersHandler, REMINDER_WINDOWS, WINDOW_WIDTH_MS, windowForSlot } = require("../lib/reminders");
const { buildReminderRulesProvider, PRESETS, quietAt, render, localDate, isoWeek } = require("../lib/reminder-settings");

const COACH="11111111-1111-4111-8111-111111111111", ATHLETE="22222222-2222-4222-8222-222222222222", USER="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", TYPE="33333333-3333-4333-8333-333333333333";
const NOW=Date.parse("2026-07-16T12:00:00.000Z");
process.env.SUPABASE_URL="https://db.test"; process.env.SUPABASE_SERVICE_KEY="service"; process.env.CRON_SECRET="secret";
function response(v,status=200){return new Response(typeof v==="string"?v:JSON.stringify(v),{status});}
function row(p,extra={}){return{id:extra.id||"44444444-4444-4444-8444-444444444444",coach_id:COACH,...p,created_at:new Date(NOW).toISOString(),updated_at:new Date(NOW).toISOString(),...extra};}
function req(secret="secret"){return{headers:{"x-cron-secret":secret}};}
function res(){return{statusCode:200,body:null,status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}};}
async function withNow(fn){const real=Date.now;Date.now=()=>NOW;try{return await fn();}finally{Date.now=real;}}

test("real handler preserves legacy bytes, query, recipients, counters, and tolerant JSON",async()=>{
  const calls=[],sent=[],real=global.fetch;
  global.fetch=async(url,opts={})=>{calls.push([String(url),opts]);if(String(url).includes("bookable_slots"))return response([{id:"slot",coach_id:COACH,starts_at:new Date(NOW+86400000).toISOString(),session_id:"session",athlete:{user_id:USER,parent_email:"a@test",name:"Ada"}}]);if(String(url).includes("notification_log")&&(opts.method||"GET")==="GET")return response([]);return response([]);};
  try{const out=res();await withNow(()=>buildRemindersHandler({notify:async(x)=>sent.push(x)})(req(),out));assert.deepEqual(out.body,{scanned:1,sent:2});assert.equal(sent[0].title,"Session tomorrow");assert.equal(sent[0].body,"Your coaching session is coming up in about 24 hours.");assert.deepEqual(sent[0].data,{slotId:"slot",sessionId:"session",window:"24h"});assert.ok(calls[0][0].includes("session_id,athlete:"));assert.ok(!calls[0][0].includes("session_type_id"));assert.deepEqual(REMINDER_WINDOWS.map(x=>x.key),["24h","30m"]);assert.equal(windowForSlot(NOW+1800000,NOW).key,"30m");
    global.fetch=async()=>response("not-json");const tolerant=res();await withNow(()=>buildRemindersHandler({notify:async()=>{}})(req(),tolerant));assert.deepEqual(tolerant.body,{scanned:0,sent:0});
  }finally{global.fetch=real;}
});

test("real handler loads one plan instant, uses service-aware 1h window, filters recipient, then orders lifecycle/homework",async()=>{
  const order=[],sent=[],real=global.fetch;let loadArgs;
  const window={key:"1h",type:"session.reminder.1h",offsetMs:3600000,title:"{service} soon",body:"Hi {athlete} at {time}",ruleId:"rule",recipient:"athlete"};
  const rulesProvider={async load(args){order.push("load");loadArgs=args;return{scanWindows:[window],sessionWindowsFor(c,t){assert.equal(c,COACH);assert.equal(t,TYPE);return[window];},async runLifecycle(){order.push("lifecycle");return{scanned:2,sent:1};},async runHomeworkDue(){order.push("homework");return{scanned:3,sent:1};}};}};
  global.fetch=async(url,opts={})=>{const u=String(url);if(u.includes("bookable_slots")){order.push("slots");return response([{id:"slot",coach_id:COACH,session_type_id:TYPE,starts_at:new Date(NOW+3600000).toISOString(),timezone:"America/New_York",title:"Strength",athlete:{user_id:USER,name:"Ada",parent_email:"a@test"}}]);}if(u.includes("notification_log")&&(opts.method||"GET")==="GET")return response([]);return response([]);};
  try{const out=res();await withNow(()=>buildRemindersHandler({notify:async(x)=>sent.push(x),rulesProvider})(req(),out));assert.deepEqual(loadArgs,{nowMs:NOW,widthMs:WINDOW_WIDTH_MS});assert.deepEqual(order,["load","slots","lifecycle","homework"]);assert.deepEqual(out.body,{scanned:6,sent:3});assert.equal(sent.length,1);assert.equal(sent[0].userId,USER);assert.equal(sent[0].type,"session.reminder.1h");assert.equal(sent[0].data.ruleId,"rule");assert.equal(sent[0].data.href,"/athlete");assert.equal(sent[0].dedupeKey,"slot");assert.match(sent[0].body,/Hi Ada at/);
  }finally{global.fetch=real;}
});

test("provider load failure returns sweep-failed without querying slots or notifying",async()=>{
  const sent=[],calls=[],real=global.fetch;global.fetch=async(...args)=>{calls.push(args);return response([]);};
  const errors=[],old=console.error;console.error=(...x)=>errors.push(x.join(" "));
  try{const out=res();await withNow(()=>buildRemindersHandler({notify:async(x)=>sent.push(x),rulesProvider:{load:async()=>{throw new Error("secret detail");}}})(req(),out));assert.deepEqual([out.statusCode,out.body],[500,{error:"reminder sweep failed"}]);assert.equal(sent.length,0);assert.equal(calls.length,0);}finally{global.fetch=real;console.error=old;}
});

test("provider-active booked-slot JSON is strict and lifecycle does not run after parse failure",async()=>{
  const order=[],real=global.fetch;global.fetch=async()=>response("bad");const plan={scanWindows:[{offsetMs:3600000}],sessionWindowsFor:()=>[],runLifecycle:async()=>{order.push("lifecycle");return{scanned:0,sent:0};},runHomeworkDue:async()=>{order.push("homework");return{scanned:0,sent:0};}};const old=console.error;console.error=()=>{};
  try{const out=res();await withNow(()=>buildRemindersHandler({notify:async()=>{},rulesProvider:{load:async()=>plan}})(req(),out));assert.equal(out.statusCode,500);assert.deepEqual(out.body,{error:"reminder sweep failed"});assert.deepEqual(order,[]);}finally{global.fetch=real;console.error=old;}
});

test("provider-active booked-slot 2xx object is not treated as an empty array",async()=>{
  const order=[],real=global.fetch;global.fetch=async()=>response({unexpected:"object"});const plan={scanWindows:[{offsetMs:3600000}],sessionWindowsFor:()=>[],runLifecycle:async()=>{order.push("lifecycle");return{scanned:0,sent:0};},runHomeworkDue:async()=>{order.push("homework");return{scanned:0,sent:0};}};const old=console.error;console.error=()=>{};
  try{const out=res();await withNow(()=>buildRemindersHandler({notify:async()=>{},rulesProvider:{load:async()=>plan}})(req(),out));assert.deepEqual([out.statusCode,out.body],[500,{error:"reminder sweep failed"}]);assert.deepEqual(order,[]);}finally{global.fetch=real;console.error=old;}
});

test("provider-active session notify failure logs no recipient-controlled detail",async()=>{
  const window={key:"1h",type:"session.reminder.1h",offsetMs:3600000,title:"Soon",body:"Soon",ruleId:"rule",recipient:"athlete"};const plan={scanWindows:[window],sessionWindowsFor:()=>[window],runLifecycle:async()=>({scanned:0,sent:0}),runHomeworkDue:async()=>({scanned:0,sent:0})};
  const real=global.fetch;global.fetch=async(url,opts={})=>String(url).includes("bookable_slots")?response([{id:"user-slot-secret",coach_id:COACH,starts_at:new Date(NOW+3600000).toISOString(),athlete:{user_id:USER,name:"Ada",parent_email:"contact-secret@example.test"}}]):response([]);const errors=[],old=console.error;console.error=(...x)=>errors.push(x.join(" "));
  try{const out=res();await withNow(()=>buildRemindersHandler({notify:async()=>{throw new Error("message-token-contact-secret");},rulesProvider:{load:async()=>plan}})(req(),out));assert.deepEqual(out.body,{scanned:1,sent:0});assert.deepEqual(errors,["[reminders] provider notification failed"]);for(const secret of [USER,"user-slot-secret","contact-secret","message-token-contact-secret"])assert.ok(errors.every(x=>!x.includes(secret)));}finally{global.fetch=real;console.error=old;}
});

test("provider plan is executable, service overrides suppress global rebook, and refund anchors a new low-credit episode",async()=>{
  const globalRebook=row({...PRESETS[1],enabled:true});const disabled=row({...PRESETS[1],is_preset:false,preset_key:null,enabled:false,session_type_id:TYPE},{id:"55555555-5555-4555-8555-555555555555"});
  const low=row({...PRESETS[3],enabled:true},{id:"66666666-6666-4666-8666-666666666666"});const calls=[],delivered=[];
  const fetchImpl=async(url,opts={})=>{const u=String(url);calls.push([u,opts]);if(u.includes("reminder_rules"))return response([globalRebook,disabled,low]);if(u.includes("coach_reminder_settings"))return response([]);if(u.includes("coaches?"))return response([{id:COACH,low_balance_threshold:2}]);if(u.includes("athletes?"))return response([{id:ATHLETE,user_id:USER,name:"Ada",parent_email:"a@test",created_at:"2026-01-01T00:00:00Z"}]);if(u.includes("bookable_slots?")&&u.includes("ends_at="))return response([{id:"slot",coach_id:COACH,booked_by:ATHLETE,ends_at:"2026-07-15T00:00:00Z",session_type_id:TYPE,athlete:{user_id:USER,name:"Ada"}}]);if(u.includes("package_purchases"))return response([{id:"purchase",status:"active",credits_remaining:1,created_at:"2026-07-01T00:00:00Z"}]);if(u.includes("credit_deductions"))return response([{id:"refund-new",created_at:"2026-07-15T00:00:00Z"}]);if(u.includes("notification_log")&&(opts.method||"GET")==="GET")return response([]);return response([]);};
  const plan=await buildReminderRulesProvider({fetchImpl}).load({nowMs:NOW,widthMs:WINDOW_WIDTH_MS});const result=await plan.runLifecycle({notify:async(x)=>delivered.push(x)});assert.equal(result.scanned,1);assert.equal(delivered.length,1);assert.equal(delivered[0].type,"reminder.low_credits");assert.equal(delivered[0].userId,USER);assert.match(delivered[0].dedupeKey,/low-episode:refund-new$/);assert.ok(calls.some(([u])=>u.includes("credit_deductions?")&&u.includes(`coach_id=eq.${COACH}`)&&u.includes(`purchase.athlete_id=eq.${ATHLETE}`)));assert.ok(!calls.some(([,o])=>["PATCH","DELETE"].includes(o.method)));
});

test("non-array low-credit coach representation fails the sweep",async()=>{
  const low=row({...PRESETS[3],enabled:true});const real=global.fetch;const old=console.error;console.error=()=>{};
  global.fetch=async(url)=>{const u=String(url);if(u.includes("reminder_rules"))return response([low]);if(u.includes("coach_reminder_settings"))return response([]);if(u.includes("bookable_slots"))return response([]);if(u.includes("coaches?"))return response({unexpected:"object"});return response([]);};
  try{const provider=buildReminderRulesProvider();const out=res();await withNow(()=>buildRemindersHandler({notify:async()=>{},rulesProvider:provider})(req(),out));assert.deepEqual([out.statusCode,out.body],[500,{error:"reminder sweep failed"}]);}finally{global.fetch=real;console.error=old;}
});

test("homework pass filters and rejects an embedded athlete owned by another coach",async()=>{
  const foreignCoach="77777777-7777-4777-8777-777777777777";const homework=row({...PRESETS[4],enabled:true});const calls=[],delivered=[];
  const fetchImpl=async(url,opts={})=>{const u=String(url);calls.push(u);if(u.includes("reminder_rules"))return response([homework]);if(u.includes("coach_reminder_settings"))return response([]);if(u.includes("homework?"))return response([{id:"homework",coach_id:COACH,athlete_id:ATHLETE,title:"Drill",due_date:"2026-07-16",athlete:{user_id:USER,name:"Ada",parent_email:"a@test",coach_id:foreignCoach}}]);return response([]);};
  const plan=await buildReminderRulesProvider({fetchImpl}).load({nowMs:NOW,widthMs:WINDOW_WIDTH_MS});const result=await plan.runHomeworkDue({notify:async(x)=>delivered.push(x)});assert.deepEqual(result,{scanned:0,sent:0});assert.equal(delivered.length,0);const query=calls.find(x=>x.includes("homework?"));assert.ok(query.includes(`athlete.coach_id=eq.${COACH}`));assert.ok(query.includes("athlete:athlete_id!inner"));
});

test("time helpers pin quiet/DST-safe local boundaries, dates, weeks, templates, and auth/config",async()=>{
  assert.equal(quietAt(Date.parse("2026-07-16T01:00:00Z"),"UTC","21:00","08:00"),true);assert.equal(quietAt(Date.parse("2026-07-16T08:00:00Z"),"UTC","21:00","08:00"),false);assert.equal(localDate(Date.parse("2026-03-08T06:59:00Z"),"America/New_York"),"2026-03-08");assert.equal(isoWeek(Date.parse("2026-01-01T12:00:00Z"),"UTC"),"2026-W01");assert.equal(render("Hi {athlete}\u0001",{athlete:"Ada"},120),"Hi Ada");
  let out=res();await buildRemindersHandler({notify:async()=>{}})(req("wrong"),out);assert.deepEqual([out.statusCode,out.body],[401,{error:"unauthorized"}]);const key=process.env.SUPABASE_SERVICE_KEY;delete process.env.SUPABASE_SERVICE_KEY;try{out=res();await buildRemindersHandler({notify:async()=>{}})(req(),out);assert.deepEqual(out.body,{scanned:0,sent:0});}finally{process.env.SUPABASE_SERVICE_KEY=key;}
});
