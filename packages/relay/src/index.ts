/**
 * D&D Voice Overlay - Relay server (multi-tenant)
 * -----------------------------------------------
 * Each group plays in a "room" identified by a short code. The code is the
 * access credential (like a meeting link): knowing it lets you join, report
 * mic activity, and upload portraits for that campaign. Creating a campaign is
 * gated by the global ADMIN_PASSWORD so only the operator can make rooms.
 *
 *  HTTP
 *   GET  /health
 *   GET  /create                 host page to make a campaign
 *   POST /create?password&name   -> { room }
 *   GET  /mic?room=CODE          player page: pick char, upload, mic VAD
 *   GET  /campaign.json?room=CODE
 *   POST /admin/upload?room=CODE&name&type   (body = image bytes)
 *   GET  /portraits/<id>?room=CODE
 *
 *  WebSocket  ?room=CODE&role=display|reporter|source
 *   - display : receive-only, gets this room's speaking events
 *   - reporter: a player's /mic page reporting their own speech
 *   - source  : optional Discord listener (token-gated)
 */
import http from "http";
import path from "path";
import { WebSocketServer, WebSocket, RawData } from "ws";

const PORT = Number(process.env.PORT ?? 8787);
const RELAY_TOKEN = process.env.RELAY_TOKEN ?? "";
const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY ?? "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const BUCKET = "portraits";
const supabaseOn = !!(SUPABASE_URL && SUPABASE_KEY);

type SpeakingMessage = { type: "speaking"; userId: string; speaking: boolean; ts: number };

// One Room per campaign code.
interface Room { speaking: Set<string>; displays: Set<WebSocket>; }
const rooms = new Map<string, Room>();
function getRoom(code: string): Room {
  let r = rooms.get(code);
  if (!r) { r = { speaking: new Set(), displays: new Set() }; rooms.set(code, r); }
  return r;
}
function roomOf(url: URL): string {
  return (url.searchParams.get("room") || "default").trim().toUpperCase();
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};
const sbHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

// ---- helpers ---------------------------------------------------------------
function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
function genRoomCode(): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let s = "";
  for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

const roomExistsCache = new Set<string>(["DEFAULT"]);
async function roomExists(room: string): Promise<boolean> {
  if (!supabaseOn) return room === "DEFAULT";
  if (roomExistsCache.has(room)) return true;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/campaigns?room=eq.${encodeURIComponent(room)}&select=room`, { headers: sbHeaders });
  if (!r.ok) return false;
  const rows = (await r.json()) as any[];
  if (rows.length) { roomExistsCache.add(room); return true; }
  return false;
}
async function sbListCharacters(room: string): Promise<Array<{ char_id: string; name: string; portrait_url: string }>> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/characters?room=eq.${encodeURIComponent(room)}&select=char_id,name,portrait_url&order=name`, { headers: sbHeaders });
  if (!r.ok) throw new Error(`list ${r.status}`);
  return (await r.json()) as any;
}
async function sbUpload(room: string, id: string, name: string, contentType: string, bytes: Buffer): Promise<string> {
  const key = `${encodeURIComponent(room)}/${encodeURIComponent(id)}`;
  const put = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${key}`, {
    method: "POST",
    headers: { ...sbHeaders, "Content-Type": contentType || "image/png", "x-upsert": "true" },
    body: new Uint8Array(bytes),
  });
  if (!put.ok) throw new Error(`storage ${put.status}: ${await put.text()}`);
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${key}`;
  const row = await fetch(`${SUPABASE_URL}/rest/v1/characters`, {
    method: "POST",
    headers: { ...sbHeaders, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ room, char_id: id, name, portrait_url: publicUrl }),
  });
  if (!row.ok) throw new Error(`db ${row.status}: ${await row.text()}`);
  return publicUrl;
}
async function sbCreateRoom(name: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genRoomCode();
    const r = await fetch(`${SUPABASE_URL}/rest/v1/campaigns`, {
      method: "POST",
      headers: { ...sbHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ room: code, name }),
    });
    if (r.ok) { roomExistsCache.add(code); return code; }
    if (r.status !== 409) throw new Error(`create ${r.status}: ${await r.text()}`); // 409 = code clash, retry
  }
  throw new Error("could not allocate room code");
}
function readBody(req: http.IncomingMessage, limit = 8 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---- HTTP ------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  try {
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      return res.end(JSON.stringify({ ok: true, mode: supabaseOn ? "supabase" : "file", rooms: rooms.size }));
    }

    if (url.pathname === "/create" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...CORS });
      return res.end(CREATE_HTML);
    }
    if (url.pathname === "/create" && req.method === "POST") {
      if (!supabaseOn) { res.writeHead(503, CORS); return res.end("not configured"); }
      const pass = url.searchParams.get("password") ?? "";
      const name = (url.searchParams.get("name") ?? "").trim();
      if (!ADMIN_PASSWORD || pass !== ADMIN_PASSWORD) { res.writeHead(401, CORS); return res.end("wrong admin password"); }
      if (!name) { res.writeHead(400, CORS); return res.end("name required"); }
      const room = await sbCreateRoom(name);
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      return res.end(JSON.stringify({ ok: true, room }));
    }

    if (url.pathname === "/mic" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...CORS });
      return res.end(MIC_HTML);
    }

    if (url.pathname === "/campaign.json") {
      const room = roomOf(url);
      let payload: any = { campaignName: room, characters: {} };
      if (supabaseOn) {
        const rows = await sbListCharacters(room);
        for (const row of rows) payload.characters[row.char_id] = { name: row.name, portrait: row.portrait_url };
      }
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      return res.end(JSON.stringify(payload));
    }

    if (url.pathname === "/admin/upload" && req.method === "POST") {
      if (!supabaseOn) { res.writeHead(503, CORS); return res.end("uploads not configured"); }
      const room = roomOf(url);
      if (!(await roomExists(room))) { res.writeHead(404, CORS); return res.end("unknown campaign code"); }
      const rawId = (url.searchParams.get("id") ?? "").trim();
      const name = (url.searchParams.get("name") ?? "").trim();
      const type = url.searchParams.get("type") ?? "image/png";
      if (!name) { res.writeHead(400, CORS); return res.end("name required"); }
      const id = /^[A-Za-z0-9_-]{3,40}$/.test(rawId) ? rawId : slugify(name);
      if (!id) { res.writeHead(400, CORS); return res.end("invalid name"); }
      const bytes = await readBody(req);
      if (!bytes.length) { res.writeHead(400, CORS); return res.end("no image"); }
      await sbUpload(room, id, name, type, bytes);
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      return res.end(JSON.stringify({ ok: true, id }));
    }

    res.writeHead(404, CORS); res.end("not found");
  } catch (err) {
    console.error("[http] error:", (err as Error).message);
    res.writeHead(500, CORS); res.end("server error");
  }
});

// ---- WebSocket -------------------------------------------------------------
const wss = new WebSocketServer({ server });
function broadcast(room: Room, msg: SpeakingMessage) {
  const data = JSON.stringify(msg);
  for (const ws of room.displays) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}
function onSpeaking(room: Room, buf: RawData) {
  let msg: SpeakingMessage;
  try { msg = JSON.parse(buf.toString()); } catch { return; }
  if (msg.type !== "speaking" || typeof msg.userId !== "string") return;
  if (msg.speaking) room.speaking.add(msg.userId); else room.speaking.delete(msg.userId);
  broadcast(room, { type: "speaking", userId: msg.userId, speaking: !!msg.speaking, ts: Date.now() });
}

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const code = roomOf(url);
  const role = url.searchParams.get("role") ?? "display";

  if (!(await roomExists(code))) { return ws.close(1008, "unknown room"); }
  const room = getRoom(code);

  if (role === "source") {
    if (RELAY_TOKEN && url.searchParams.get("token") !== RELAY_TOKEN) return ws.close(1008, "bad token");
    ws.on("message", (b) => onSpeaking(room, b));
    return;
  }
  if (role === "reporter") {
    ws.on("message", (b) => onSpeaking(room, b));
    return;
  }
  // display: receive-only
  room.displays.add(ws);
  ws.send(JSON.stringify({ type: "snapshot", speaking: [...room.speaking], ts: Date.now() }));
  ws.on("close", () => room.displays.delete(ws));
});

setInterval(() => { for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 30_000);
server.listen(PORT, () => console.log(`Relay on :${PORT} (mode: ${supabaseOn ? "supabase" : "file"})`));

// ---- Host page: create a campaign -----------------------------------------
const CREATE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Create campaign</title>
<style>body{font-family:system-ui,Segoe UI,sans-serif;max-width:460px;margin:36px auto;padding:0 18px;color:#1d1d1f}
h1{font-size:20px}label{display:block;margin:14px 0 4px;font-size:13px;color:#444;font-weight:600}
input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #ccc;border-radius:8px;font-size:14px}
button{margin-top:16px;width:100%;padding:12px;border:0;border-radius:8px;background:#5865F2;color:#fff;font-weight:700;font-size:15px;cursor:pointer}
.hint{font-size:12px;color:#888;margin-top:6px;line-height:1.4}.bad{color:#c0392b}
#out{margin-top:18px;padding:14px;border:1px solid #e3dcc0;background:#fbf7e9;border-radius:10px;display:none}
code{background:#eee;padding:2px 6px;border-radius:5px;font-size:15px}</style></head><body>
<h1>🎲 Create a campaign</h1>
<p class="hint">For the host. Creates a private room code you share with your players.</p>
<label>Campaign name</label><input id="name" placeholder="e.g. Curse of Strahd">
<label>Admin password</label><input id="pw" type="password" placeholder="your ADMIN_PASSWORD">
<button id="go">Create campaign</button>
<div id="out"></div>
<script>
var $=function(i){return document.getElementById(i);};
$('go').onclick=function(){
 var name=$('name').value.trim(),pw=$('pw').value,out=$('out');
 if(!name||!pw){out.style.display='block';out.innerHTML='<span class="bad">Enter a name and the admin password.</span>';return;}
 fetch('/create?'+new URLSearchParams({name:name,password:pw}),{method:'POST'}).then(function(r){
   if(!r.ok)return r.text().then(function(t){throw new Error(t);});return r.json();
 }).then(function(j){
   var base=location.origin;
   out.style.display='block';
   out.innerHTML='<b>Campaign code:</b> <code>'+j.room+'</code><br><br>'+
     'Players go to:<br><code>'+base+'/mic?room='+j.room+'</code><br><br>'+
     'In the Roll20 overlay extension popup, enter this same code as the <b>Campaign code</b>.';
 }).catch(function(e){out.style.display='block';out.innerHTML='<span class="bad">Failed: '+e.message+'</span>';});
};
</script></body></html>`;

// ---- Player page: pick char, upload, mic VAD ------------------------------
const MIC_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>D&D Voice Overlay - Mic</title>
<style>body{font-family:system-ui,Segoe UI,sans-serif;max-width:460px;margin:34px auto;padding:0 18px;color:#1d1d1f}
h1{font-size:20px}label{display:block;margin:14px 0 4px;font-size:13px;color:#444;font-weight:600}
select,input[type=text],input[type=number],input[type=file]{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #ccc;border-radius:8px;font-size:14px}
input[type=range]{width:100%}
button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:8px;background:#5865F2;color:#fff;font-weight:700;font-size:15px;cursor:pointer}
button.stop{background:#c0392b}button.sec{background:#3a3a3a;margin-top:10px;padding:10px}
.hint{font-size:12px;color:#888;margin-top:4px;line-height:1.4}.bad{color:#c0392b}.ok{color:#1e8e3e}.live{color:#1e8e3e}.idle{color:#888}
#meterWrap{height:18px;background:#eee;border-radius:9px;overflow:hidden;margin-top:8px}#meter{height:100%;width:0%;background:#2ecc71;transition:width 60ms linear}
#state{margin-top:14px;font-size:15px;font-weight:700;min-height:22px}
details{margin-top:12px;border:1px solid #eee;border-radius:8px;padding:8px 12px}summary{cursor:pointer;font-size:13px;font-weight:600;color:#444}
img#prev{max-width:120px;border-radius:8px;margin-top:8px;display:none}#banner{font-size:13px;color:#666;margin-bottom:6px}</style></head><body>
<h1>🎙️ D&D Voice Overlay</h1>
<div id="banner"></div>
<p class="hint">Lights up your character on Roll20 when you talk - your own mic, no Discord. Audio never leaves your device; only an on/off signal is sent. Keep this tab open while you play.</p>

<label>I'm playing</label>
<select id="char"><option value="">Loading...</option></select>

<details><summary>+ Add or update my character</summary>
 <label>Character name</label><input id="newName" type="text" placeholder="e.g. Medvind">
 <label>Portrait image (transparent PNG looks best)</label><input id="newFile" type="file" accept="image/*">
 <img id="prev"><button id="add" class="sec">Save my portrait</button><div id="addMsg" class="hint"></div>
</details>

<label>Sensitivity (fill the bar only when you talk)</label>
<input id="sens" type="range" min="1" max="40" value="6"><div id="meterWrap"><div id="meter"></div></div>
<label>Hold (ms) - stays lit through short pauses</label><input id="holdNum" type="number" value="1200" min="200" max="4000" step="100">
<button id="go">Start microphone</button>
<div id="state" class="idle">Stopped</div>
<script>
(function(){
 var $=function(i){return document.getElementById(i);};
 var room=(new URLSearchParams(location.search).get('room')||'DEFAULT').toUpperCase();
 $('banner').textContent='Campaign: '+room;
 var ws=null,ac=null,an=null,stream=null,raf=null,running=false,speaking=false,stopTimer=null;
 var state=$('state'),meter=$('meter');
 function api(p){return p+(p.indexOf('?')<0?'?':'&')+'room='+encodeURIComponent(room);}
 function loadChars(sel){return fetch(api('/campaign.json'),{cache:'no-store'}).then(function(r){return r.json();}).then(function(c){
   var s=$('char'),chars=(c&&c.characters)||{},ids=Object.keys(chars);
   s.innerHTML=ids.length?'<option value="">- choose your character -</option>':'<option value="">(none yet - add yourself below)</option>';
   ids.forEach(function(id){var o=document.createElement('option');o.value=id;o.textContent=chars[id].name||id;if(id===sel)o.selected=true;s.appendChild(o);});
 }).catch(function(){$('char').innerHTML='<option value="">(could not load)</option>';});}
 loadChars();
 $('newFile').onchange=function(e){var f=e.target.files[0];if(f){$('prev').src=URL.createObjectURL(f);$('prev').style.display='block';}};
 $('add').onclick=function(){
   var name=$('newName').value.trim(),f=$('newFile').files[0],m=$('addMsg');m.className='hint';
   if(!name){m.className='bad';m.textContent='Enter a character name.';return;}
   if(!f){m.className='bad';m.textContent='Choose an image.';return;}
   m.textContent='Uploading...';
   fetch(api('/admin/upload')+'&'+new URLSearchParams({name:name,type:f.type||'image/png'}),{method:'POST',body:f})
   .then(function(r){if(!r.ok)return r.text().then(function(t){throw new Error(t);});return r.json();})
   .then(function(j){m.className='ok';m.textContent='✓ Saved!';return loadChars(j.id);})
   .catch(function(e){m.className='bad';m.textContent='Failed: '+e.message;});
 };
 function wsUrl(){var p=location.protocol==='https:'?'wss://':'ws://';return p+location.host+'/?role=reporter&room='+encodeURIComponent(room);}
 function send(on){var id=$('char').value;if(ws&&ws.readyState===1&&id)ws.send(JSON.stringify({type:'speaking',userId:id,speaking:on}));}
 function setSpeaking(on){if(on===speaking)return;speaking=on;send(on);state.className=on?'live':'idle';state.textContent=on?'🔊 Speaking - portrait is lit':'Listening...';}
 function loop(){if(!running)return;var b=new Uint8Array(an.fftSize);an.getByteTimeDomainData(b);var s=0;for(var i=0;i<b.length;i++){var x=(b[i]-128)/128;s+=x*x;}
   var level=Math.min(1,Math.sqrt(s/b.length)*4);meter.style.width=(level*100).toFixed(0)+'%';
   var thr=parseInt($('sens').value,10)/100,hold=Math.max(200,parseInt($('holdNum').value,10)||1200);
   if(level>thr){if(stopTimer){clearTimeout(stopTimer);stopTimer=null;}setSpeaking(true);}
   else if(speaking&&!stopTimer){stopTimer=setTimeout(function(){stopTimer=null;setSpeaking(false);},hold);}
   raf=requestAnimationFrame(loop);}
 function start(){var id=$('char').value;if(!id){state.className='bad';state.textContent='Pick your character first.';return;}
   navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false}).then(function(st){
     stream=st;ac=new (window.AudioContext||window.webkitAudioContext)();var sn=ac.createMediaStreamSource(st);an=ac.createAnalyser();an.fftSize=512;sn.connect(an);
     ws=new WebSocket(wsUrl());ws.onopen=function(){running=true;state.className='idle';state.textContent='Listening...';loop();};
     ws.onclose=function(){if(running){state.className='bad';state.textContent='Disconnected (unknown code?).';stop();}};
     $('go').textContent='Stop microphone';$('go').className='stop';
   }).catch(function(e){state.className='bad';state.textContent='Mic denied: '+e.message;});}
 function stop(){running=false;if(raf)cancelAnimationFrame(raf);if(stopTimer){clearTimeout(stopTimer);stopTimer=null;}setSpeaking(false);
   if(ws){try{ws.close();}catch(e){}ws=null;}if(stream){stream.getTracks().forEach(function(t){t.stop();});stream=null;}if(ac){try{ac.close();}catch(e){}ac=null;}
   meter.style.width='0%';$('go').textContent='Start microphone';$('go').className='';state.className='idle';state.textContent='Stopped';}
 $('go').onclick=function(){running?stop():start();};
})();
</script></body></html>`;
