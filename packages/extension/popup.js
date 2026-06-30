const DEFAULT_RELAY_URL = "https://extension-dnd.onrender.com";
const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;
let base = DEFAULT_RELAY_URL, code = "", joinPw = "", isDm = false;

function normalize(raw){ let b=(raw||"").trim().replace(/\/+$/,""); if(b&&!/^https?:\/\//i.test(b))b="http://"+b; return b; }
function relay(){ return normalize($("url").value) || DEFAULT_RELAY_URL; }
function curCode(){ return ($("code").value||"").trim().toUpperCase(); }
function setStatus(el,msg,ok){ el.textContent=msg; el.className=(el.id==="status"?"":"msg ")+(ok?"ok":"bad"); }

function applyView(){
  $("playerView").style.display = isDm ? "none" : "block";
  $("dmView").style.display = isDm ? "block" : "none";
  $("topStep").textContent = isDm ? "1 · Your campaign" : "1 · Join your game";
  $("codeLbl").textContent = isDm ? "Your campaign code" : "Campaign code (ask your DM)";
  if (isDm) renderCode();
}
function showWelcome(){ $("welcome").style.display="block"; $("main").style.display="none"; }
function showMain(dm){ isDm=!!dm; $("welcome").style.display="none"; $("main").style.display="block"; applyView(); if(isDm && !curCode()) $("createWrap").open=true; else if(!isDm) $("code").focus(); }

function load(){
  chrome.storage.local.get(["relayBaseUrl","campaignCode","joinPw","dmMode","myCharacterId"],(d)=>{
    base=d.relayBaseUrl||DEFAULT_RELAY_URL; code=(d.campaignCode||"").toUpperCase(); joinPw=d.joinPw||"";
    $("url").value=base; $("code").value=code; $("join").value=joinPw;
    if(code) showMain(!!d.dmMode); else showWelcome();
  });
}

$("bePlayer").onclick=()=>{ chrome.storage.local.set({dmMode:false}); showMain(false); };
$("beDm").onclick=()=>{ chrome.storage.local.set({dmMode:true}); showMain(true); };
$("back").onclick=showWelcome;

function renderCode(){
  const box=$("codeDisplay"); code=curCode();
  if(!code){ box.innerHTML='<div class="hint" style="margin:0">No campaign yet — create one below.</div>'; return; }
  box.innerHTML='<div class="hint" style="margin:0 0 4px">Send this code to your players:</div><div class="codebox"><span>'+code+'</span><button id="copyCode">Copy</button></div>';
  $("copyCode").onclick=()=>{ try{navigator.clipboard.writeText(code);}catch(e){} $("copyCode").textContent="Copied!"; setTimeout(()=>{$("copyCode").textContent="Copy";},1200); };
}

$("dmCreate").onclick=()=>{
  const name=$("dmName").value.trim(), jp=$("dmJoin").value, m=$("dmMsg");
  if(!name) return setStatus(m,"Enter a campaign name.",false);
  setStatus(m,"Creating...",true);
  const prm={name}; if(jp)prm.joinpw=jp;
  fetch(relay()+"/create?"+new URLSearchParams(prm),{method:"POST"}).then(r=>r.ok?r.json():r.text().then(t=>{throw new Error(t);})).then(j=>{
    code=j.room; joinPw=jp||""; chrome.storage.local.set({campaignCode:code,joinPw,dmMode:true});
    $("code").value=code; $("join").value=joinPw; setStatus(m,"✓ Campaign created.",true); $("createWrap").open=false; renderCode();
  }).catch(e=>setStatus(m,"Failed: "+e.message,false));
};

$("save").onclick=()=>{
  const b=relay(); code=curCode(); joinPw=$("join").value||"";
  chrome.storage.local.set({relayBaseUrl:b,campaignCode:code,joinPw,dmMode:isDm},()=>{
    base=b; setStatus($("status"),code?("Saved. Campaign "+code):"Saved.",true); applyView();
  });
};
$("test").onclick=()=>{ setStatus($("status"),"Testing...",true); fetch(relay()+"/health",{cache:"no-store"}).then(r=>r.json()).then(j=>setStatus($("status"),"Relay OK ("+(j.mode||"ok")+").",true)).catch(()=>setStatus($("status"),"Could not reach relay.",false)); };
$("console").onclick=()=>{ if(chrome.runtime.openOptionsPage)chrome.runtime.openOptionsPage(); else window.open(chrome.runtime.getURL("options.html")); };
$("pause").onclick=()=>{ chrome.runtime.sendMessage({type:"toggle-pause"}); setStatus($("status"),"Toggled pause on your screen.",true); };

load();
