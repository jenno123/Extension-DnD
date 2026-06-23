const DEFAULT_RELAY_URL = "https://extension-dnd.onrender.com";
const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;
let base = DEFAULT_RELAY_URL, code = "", joinPw = "", myChar = "";

function normalize(raw){ let b=(raw||"").trim().replace(/\/+$/,""); if(b&&!/^https?:\/\//i.test(b))b="http://"+b; return b; }
function relay(){ return normalize($("url").value) || DEFAULT_RELAY_URL; }
function curCode(){ return ($("code").value||"").trim().toUpperCase(); }
function setStatus(el,msg,ok){ el.textContent=msg; el.className=(el.id==="status"?"":"msg ")+(ok?"ok":"bad"); }
function applyRole(){ const dm=$("dm").checked; $("playerCard").style.display=dm?"none":"block"; $("dmCard").style.display=dm?"block":"none"; }

function load(){
  chrome.storage.local.get(["relayBaseUrl","campaignCode","joinPw","dmMode","myCharacterId"],(d)=>{
    base = d.relayBaseUrl || DEFAULT_RELAY_URL;
    code = (d.campaignCode||"").toUpperCase();
    joinPw = d.joinPw || "";
    myChar = d.myCharacterId || "";
    $("url").value = base; $("code").value = code; $("join").value = joinPw; $("dm").checked = !!d.dmMode;
    applyRole(); renderMyChar();
  });
}

function renderMyChar(){
  const box=$("myCharBox"); code=curCode();
  if(!code){ box.innerHTML='<div class="hint">Enter your campaign code above first.</div>'; return; }
  fetch(relay()+"/campaign.json?room="+enc(code),{cache:"no-store"}).then(r=>r.json()).then(c=>{
    const chars=(c&&c.characters)||{};
    if(myChar && chars[myChar]){
      const ch=chars[myChar];
      const src=/^https?:\/\//i.test(ch.portrait)?ch.portrait:relay()+"/portraits/"+enc(ch.portrait)+"?room="+enc(code);
      box.innerHTML="";
      const w=document.createElement("div"); w.className="mychar";
      const img=document.createElement("img"); img.src=src;
      const nm=document.createElement("div"); nm.className="nm"; nm.textContent=ch.name||myChar;
      const del=document.createElement("button"); del.className="danger"; del.style.flex="0 0 auto"; del.textContent="Remove"; del.onclick=removeMyChar;
      w.appendChild(img); w.appendChild(nm); w.appendChild(del); box.appendChild(w);
    } else { if(myChar){ myChar=""; chrome.storage.local.set({myCharacterId:""}); } box.innerHTML='<div class="hint">No character yet — add yours below.</div>'; }
  }).catch(()=>{ box.innerHTML=""; });
}

$("pcFile").onchange=(e)=>{ const f=e.target.files[0]; if(f){ $("pcPrev").src=URL.createObjectURL(f); $("pcPrev").style.display="block"; } };

$("pcSave").onclick=()=>{
  const name=$("pcName").value.trim(), f=$("pcFile").files[0], m=$("pcMsg"); code=curCode(); joinPw=$("join").value||"";
  if(!code) return setStatus(m,"Enter your campaign code first.",false);
  if(!name) return setStatus(m,"Enter your character name.",false);
  if(!f) return setStatus(m,"Choose a portrait image.",false);
  setStatus(m,"Uploading...",true);
  chrome.storage.local.set({campaignCode:code,joinPw}); // make sure the overlay uses this campaign
  const url=relay()+"/admin/upload?room="+enc(code)+"&"+new URLSearchParams({name,type:f.type||"image/png",kind:"pc"})+(joinPw?"&join="+enc(joinPw):"");
  fetch(url,{method:"POST",body:f}).then(r=>r.ok?r.json():r.text().then(t=>{throw new Error(t);})).then(j=>{
    const oldId=myChar; myChar=j.id; chrome.storage.local.set({myCharacterId:myChar});
    if(oldId && oldId!==myChar) fetch(relay()+"/admin/delete?room="+enc(code)+"&id="+enc(oldId)+(joinPw?"&join="+enc(joinPw):""),{method:"POST"}).catch(()=>{});
    setStatus(m,"✓ Saved your character.",true);
    $("pcName").value=""; $("pcFile").value=""; $("pcPrev").style.display="none"; renderMyChar();
  }).catch(e=>setStatus(m,"Failed: "+e.message,false));
};

function removeMyChar(){
  code=curCode(); joinPw=$("join").value||""; if(!myChar||!code) return;
  fetch(relay()+"/admin/delete?room="+enc(code)+"&id="+enc(myChar)+(joinPw?"&join="+enc(joinPw):""),{method:"POST"})
    .then(()=>{ myChar=""; chrome.storage.local.set({myCharacterId:""}); renderMyChar(); }).catch(()=>{});
}

$("dm").onchange=applyRole;

$("save").onclick=()=>{
  const b=relay(); code=curCode(); joinPw=$("join").value||"";
  chrome.storage.local.set({relayBaseUrl:b,campaignCode:code,joinPw,dmMode:$("dm").checked},()=>{
    base=b; setStatus($("status"),code?("Saved. Campaign "+code+($("dm").checked?" (DM)":"")):"Saved.",true); renderMyChar();
  });
};
$("test").onclick=()=>{ setStatus($("status"),"Testing...",true); fetch(relay()+"/health",{cache:"no-store"}).then(r=>r.json()).then(j=>setStatus($("status"),"Relay OK ("+(j.mode||"ok")+").",true)).catch(()=>setStatus($("status"),"Could not reach relay.",false)); };
$("console").onclick=()=>{ if(chrome.runtime.openOptionsPage)chrome.runtime.openOptionsPage(); else window.open(chrome.runtime.getURL("options.html")); };
$("pause").onclick=()=>{ chrome.runtime.sendMessage({type:"toggle-pause"}); setStatus($("status"),"Toggled pause on your screen.",true); };

load();
