// Fixed, privacy-preserving shell for the no-login homework capability page.
// Assignment data is fetched at runtime and is inserted only with textContent.

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; font-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'">
  <title>Homework · CoachTime</title>
  <style>
    :root{color-scheme:light;--ink:#111113;--gold:#d4c36a;--muted:#67676c}
    *{box-sizing:border-box}body{margin:0;min-width:320px;background:#f4f4f5;color:var(--ink);font:16px/1.55 system-ui,-apple-system,sans-serif}
    main{width:min(560px,calc(100% - 32px));margin:48px auto;background:#fff;border:1px solid #e3e3e5;border-radius:16px;padding:32px}
    .brand{margin:0 0 28px;font-size:13px;font-weight:800;letter-spacing:.18em}h1{margin:0 0 12px;font-size:clamp(25px,8vw,36px);line-height:1.15}
    #detail{white-space:pre-wrap;color:var(--muted)}#status{min-height:25px}button{width:100%;margin-top:22px;border:0;border-radius:10px;background:var(--ink);color:#fff;padding:14px 18px;font:inherit;font-weight:750;cursor:pointer}
    button:disabled{opacity:.55;cursor:wait}button:focus-visible{outline:3px solid var(--gold);outline-offset:3px}.hidden{display:none}
    @media(max-width:380px){main{margin:16px auto;padding:23px}}
  </style>
</head>
<body><main><p class="brand">COACHTIME</p><h1 id="title">Loading homework…</h1><p id="detail" class="hidden"></p><p id="status" aria-live="polite"></p><button id="done" class="hidden" type="button">Mark done</button></main>
<script>
(()=>{'use strict';const title=document.getElementById('title'),detail=document.getElementById('detail'),status=document.getElementById('status'),button=document.getElementById('done');let busy=false;
const showUnavailable=()=>{title.textContent='Homework unavailable';detail.textContent='This link is unavailable or has expired.';detail.classList.remove('hidden');button.classList.add('hidden');status.textContent='';};
const showNetwork=()=>{title.textContent='Could not load homework';detail.textContent='Check your connection and refresh to try again.';detail.classList.remove('hidden');button.classList.add('hidden');status.textContent='Network error.';};
const showCompleted=()=>{title.textContent='Homework complete';detail.textContent='Nice work — your coach has been notified.';detail.classList.remove('hidden');button.classList.add('hidden');status.textContent='Completed.';};
const load=async()=>{try{const response=await fetch(location.pathname+'/data',{headers:{accept:'application/json'},cache:'no-store'});if(!response.ok){showUnavailable();return;}const data=await response.json();if(data.state==='completed'){showCompleted();return;}if(data.state!=='assigned'||!data.homework||typeof data.homework.title!=='string'){showUnavailable();return;}title.textContent=data.homework.title;detail.textContent=data.homework.detail||'';detail.classList.toggle('hidden',!data.homework.detail);button.classList.remove('hidden');status.textContent='Ready to mark done.';}catch(_){showNetwork();}};
button.addEventListener('click',async()=>{if(busy)return;busy=true;button.disabled=true;status.textContent='Marking done…';try{const response=await fetch(location.pathname+'/done',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:'{}'});if(response.ok){const data=await response.json();if(data.state==='completed'){showCompleted();return;}}if(response.status===404)showUnavailable();else{status.textContent='Could not mark done. Try again.';button.disabled=false;}}catch(_){status.textContent='Network error. Try again.';button.disabled=false;}finally{busy=false;}});load();})();
</script></body></html>`;

function sendAccountabilityPage(res) {
  res.set({
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  });
  return res.status(200).type("html").send(PAGE);
}

module.exports = { sendAccountabilityPage };
