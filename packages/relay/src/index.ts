/**
 * D&D Voice Overlay - Relay server
 * --------------------------------
 *  - HTTP : serves campaign.json + portrait images, and a password-protected
 *           /admin page where players upload their own portrait + name.
 *  - WS   : receives speaking events from the host's discord-listener
 *           (role=source, token-gated) and fans them out to overlays
 *           (role=display, RECEIVE-ONLY).
 *
 * Two data modes:
 *  - Supabase mode (when SUPABASE_URL + SUPABASE_SERVICE_KEY are set): the
 *    character list lives in a Supabase table and portraits in Supabase
 *    Storage, so players can self-serve uploads that survive restarts.
 *  - File mode (fallback): reads config/campaign.json + config/portraits/.
 */
import http from "http";
import { readFile } from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { WebSocketServer, WebSocket, RawData } from "ws";

const PORT = Number(process.env.PORT ?? 8787);
const CONFIG_DIR = path.resolve(process.cwd(), process.env.CONFIG_DIR ?? "../../config");
const PORTRAITS_DIR = path.join(CONFIG_DIR, "portraits");
const RELAY_TOKEN = process.env.RELAY_TOKEN ?? "";

// Supabase (optional)
const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY ?? "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const CAMPAIGN_NAME = process.env.CAMPAIGN_NAME ?? "Campaign";
const BUCKET = "portraits";
const supabaseOn = !!(SUPABASE_URL && SUPABASE_KEY);

type SpeakingMessage = { type: "speaking"; userId: string; speaking: boolean; ts: number };
type SnapshotMessage = { type: "snapshot"; speaking: string[]; ts: number };

const speaking = new Set<string>();
const displays = new Set<WebSocket>();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const sbHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

// ---- Supabase helpers ------------------------------------------------------
async function sbListCharacters(): Promise<Array<{ discord_id: string; name: string; portrait_url: string }>> {
  const url = `${SUPABASE_URL}/rest/v1/characters?select=discord_id,name,portrait_url&order=name`;
  const r = await fetch(url, { headers: sbHeaders });
  if (!r.ok) throw new Error(`supabase list ${r.status}`);
  return (await r.json()) as any;
}
async function sbGetPortraitUrl(id: string): Promise<string | null> {
  const url = `${SUPABASE_URL}/rest/v1/characters?select=portrait_url&discord_id=eq.${encodeURIComponent(id)}`;
  const r = await fetch(url, { headers: sbHeaders });
  if (!r.ok) return null;
  const rows = (await r.json()) as any[];
  return rows[0]?.portrait_url ?? null;
}
async function sbUpload(id: string, name: string, contentType: string, bytes: Buffer): Promise<string> {
  // 1) upload the image (upsert)
  const put = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { ...sbHeaders, "Content-Type": contentType || "image/png", "x-upsert": "true" },
    body: new Uint8Array(bytes),
  });
  if (!put.ok) throw new Error(`storage upload ${put.status}: ${await put.text()}`);
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${encodeURIComponent(id)}`;
  // 2) upsert the row
  const row = await fetch(`${SUPABASE_URL}/rest/v1/characters`, {
    method: "POST",
    headers: { ...sbHeaders, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ discord_id: id, name, portrait_url: publicUrl }),
  });
  if (!row.ok) throw new Error(`db upsert ${row.status}: ${await row.text()}`);
  return publicUrl;
}

function readBody(req: http.IncomingMessage, limit = 8 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
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
      return res.end(JSON.stringify({ ok: true, mode: supabaseOn ? "supabase" : "file", displays: displays.size, speaking: [...speaking] }));
    }

    if (url.pathname === "/campaign.json") {
      let payload: any;
      if (supabaseOn) {
        const rows = await sbListCharacters();
        const characters: Record<string, { name: string; portrait: string }> = {};
        for (const row of rows) characters[row.discord_id] = { name: row.name, portrait: row.discord_id };
        payload = { campaignName: CAMPAIGN_NAME, characters };
      } else {
        payload = JSON.parse(await readFile(path.join(CONFIG_DIR, "campaign.json"), "utf8"));
      }
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      return res.end(JSON.stringify(payload));
    }

    if (url.pathname.startsWith("/portraits/")) {
      const raw = path.basename(decodeURIComponent(url.pathname.slice("/portraits/".length)));
      if (supabaseOn) {
        const id = raw.replace(/\.(png|jpe?g|webp|gif)$/i, "");
        const purl = await sbGetPortraitUrl(id);
        if (!purl) { res.writeHead(404, CORS); return res.end("not found"); }
        const img = await fetch(purl);
        if (!img.ok) { res.writeHead(404, CORS); return res.end("not found"); }
        const buf = Buffer.from(await img.arrayBuffer());
        res.writeHead(200, { "Content-Type": img.headers.get("content-type") ?? "image/png", "Cache-Control": "public, max-age=300", ...CORS });
        return res.end(buf);
      }
      const file = path.join(PORTRAITS_DIR, raw);
      if (!file.startsWith(PORTRAITS_DIR)) { res.writeHead(403, CORS); return res.end("forbidden"); }
      const ext = path.extname(raw).toLowerCase();
      const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
        : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=3600", ...CORS });
      return createReadStream(file).on("error", () => { res.writeHead(404, CORS); res.end("not found"); }).pipe(res);
    }

    // ---- self-serve upload page ----
    if (url.pathname === "/admin" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...CORS });
      return res.end(ADMIN_HTML);
    }
    if (url.pathname === "/mic" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...CORS });
      return res.end(MIC_HTML);
    }
    if (url.pathname === "/admin/upload" && req.method === "POST") {
      if (!supabaseOn) { res.writeHead(503, CORS); return res.end("uploads not configured"); }
      const id = (url.searchParams.get("id") ?? "").trim();
      const name = (url.searchParams.get("name") ?? "").trim();
      const pass = url.searchParams.get("password") ?? "";
      const type = url.searchParams.get("type") ?? "image/png";
      if (!ADMIN_PASSWORD || pass !== ADMIN_PASSWORD) { res.writeHead(401, CORS); return res.end("wrong password"); }
      if (!/^\d{5,25}$/.test(id)) { res.writeHead(400, CORS); return res.end("invalid Discord ID"); }
      if (!name) { res.writeHead(400, CORS); return res.end("name required"); }
      const bytes = await readBody(req);
      if (!bytes.length) { res.writeHead(400, CORS); return res.end("no image"); }
      await sbUpload(id, name, type, bytes);
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      return res.end(JSON.stringify({ ok: true }));
    }

    res.writeHead(404, CORS); res.end("not found");
  } catch (err) {
    console.error("[http] error:", (err as Error).message);
    res.writeHead(500, CORS); res.end("server error");
  }
});

// ---- WebSocket -------------------------------------------------------------
const wss = new WebSocketServer({ server });

function broadcastToDisplays(msg: SpeakingMessage) {
  const data = JSON.stringify(msg);
  for (const ws of displays) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

function applySpeaking(userId: string, isSpeaking: boolean): void {
  if (isSpeaking) speaking.add(userId); else speaking.delete(userId);
  broadcastToDisplays({ type: "speaking", userId, speaking: isSpeaking, ts: Date.now() });
}

function onSpeakingMessage(buf: RawData): void {
  let msg: SpeakingMessage;
  try { msg = JSON.parse(buf.toString()); } catch { return; }
  if (msg.type !== "speaking" || typeof msg.userId !== "string") return;
  applySpeaking(msg.userId, !!msg.speaking);
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const role = url.searchParams.get("role") ?? "display";

  if (role === "source") {
    if (RELAY_TOKEN && url.searchParams.get("token") !== RELAY_TOKEN) {
      console.warn("[ws] rejected source: bad token");
      return ws.close(1008, "bad token");
    }
    console.log("[ws] source (discord-listener) connected");
    ws.on("message", onSpeakingMessage);
    ws.on("close", () => console.log("[ws] source disconnected"));
    return;
  }

  if (role === "reporter") {
    // A player's own browser (the /mic page) reporting their mic activity.
    // Gated by the group password so only your players can report.
    if (!ADMIN_PASSWORD || url.searchParams.get("password") !== ADMIN_PASSWORD) {
      return ws.close(1008, "bad password");
    }
    console.log("[ws] reporter (mic) connected");
    ws.on("message", onSpeakingMessage);
    ws.on("close", () => console.log("[ws] reporter disconnected"));
    return;
  }

  // display: RECEIVE-ONLY (no inbound message handler -> cannot be abused)
  displays.add(ws);
  console.log(`[ws] display connected (${displays.size} total)`);
  const snapshot: SnapshotMessage = { type: "snapshot", speaking: [...speaking], ts: Date.now() };
  ws.send(JSON.stringify(snapshot));
  ws.on("close", () => { displays.delete(ws); console.log(`[ws] display disconnected (${displays.size} total)`); });
});

setInterval(() => { for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 30_000);

server.listen(PORT, () => {
  console.log(`Relay listening on :${PORT}  (mode: ${supabaseOn ? "supabase" : "file"})`);
  console.log(`  campaign : /campaign.json`);
  console.log(`  upload   : /admin ${supabaseOn ? "" : "(disabled - set SUPABASE_* + ADMIN_PASSWORD)"}`);
});

// ---- Admin upload page (inline) -------------------------------------------
const ADMIN_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Add your character portrait</title>
<style>
 body{font-family:system-ui,Segoe UI,sans-serif;max-width:440px;margin:40px auto;padding:0 18px;color:#1d1d1f}
 h1{font-size:20px} label{display:block;margin:14px 0 4px;font-size:13px;color:#444;font-weight:600}
 input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #ccc;border-radius:8px;font-size:14px}
 button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:8px;background:#5865F2;color:#fff;font-size:15px;font-weight:700;cursor:pointer}
 #msg{margin-top:14px;font-size:14px;min-height:20px}.ok{color:#1e8e3e}.bad{color:#c0392b}
 .hint{font-size:12px;color:#888;margin-top:4px;line-height:1.4}
 img#prev{max-width:140px;margin-top:10px;border-radius:8px;display:none}
</style></head><body>
<h1>🎭 Add your character portrait</h1>
<p class="hint">Your portrait will appear over Roll20 when you talk in Discord voice. Best result: a PNG with a transparent background.</p>
<label>Your Discord User ID</label>
<input id="id" inputmode="numeric" placeholder="e.g. 140888573543972864">
<p class="hint">In Discord: Settings → Advanced → Developer Mode on, then right-click your name → Copy User ID.</p>
<label>Character name</label>
<input id="name" placeholder="e.g. Medvind">
<label>Portrait image</label>
<input id="file" type="file" accept="image/*">
<img id="prev">
<label>Group password</label>
<input id="pw" type="password" placeholder="ask your host">
<button id="go">Upload</button>
<div id="msg"></div>
<script>
 const $=id=>document.getElementById(id);
 $('file').onchange=e=>{const f=e.target.files[0];if(f){const u=URL.createObjectURL(f);$('prev').src=u;$('prev').style.display='block';}};
 $('go').onclick=async()=>{
   const id=$('id').value.trim(),name=$('name').value.trim(),pw=$('pw').value,f=$('file').files[0];
   const m=$('msg');m.className='';m.textContent='Uploading...';
   if(!/^[0-9]{5,25}$/.test(id)){m.className='bad';m.textContent='Enter a valid Discord User ID (numbers only).';return;}
   if(!name){m.className='bad';m.textContent='Enter a character name.';return;}
   if(!f){m.className='bad';m.textContent='Choose an image file.';return;}
   try{
     const q=new URLSearchParams({id,name,password:pw,type:f.type||'image/png'});
     const r=await fetch('/admin/upload?'+q.toString(),{method:'POST',body:f});
     if(r.ok){m.className='ok';m.textContent='✓ Saved! Your portrait is live. Reload your Roll20 tab to see it.';}
     else{m.className='bad';m.textContent='Failed: '+(await r.text());}
   }catch(err){m.className='bad';m.textContent='Error: '+err.message;}
 };
</script></body></html>`;

// ---- Mic reporter page (Option B: client-side voice-activity detection) ----
const MIC_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>D&D Voice Overlay - Microphone</title>
<style>
 body{font-family:system-ui,Segoe UI,sans-serif;max-width:460px;margin:36px auto;padding:0 18px;color:#1d1d1f}
 h1{font-size:20px} label{display:block;margin:14px 0 4px;font-size:13px;color:#444;font-weight:600}
 select,input[type=password]{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #ccc;border-radius:8px;font-size:14px}
 input[type=range]{width:100%}
 button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:8px;background:#5865F2;color:#fff;font-size:15px;font-weight:700;cursor:pointer}
 button.stop{background:#c0392b}
 .hint{font-size:12px;color:#888;margin-top:4px;line-height:1.4}
 #meterWrap{height:18px;background:#eee;border-radius:9px;overflow:hidden;margin-top:8px}
 #meter{height:100%;width:0%;background:#2ecc71;transition:width 60ms linear}
 #thr{height:100%;}
 #state{margin-top:14px;font-size:15px;font-weight:700;min-height:22px}
 .live{color:#1e8e3e}.idle{color:#888}.bad{color:#c0392b}
 .row{display:flex;gap:6px;align-items:center}
</style></head><body>
<h1>🎙️ D&D Voice Overlay - your microphone</h1>
<p class="hint">This lights up your character on everyone's Roll20 when you talk - using your own mic, no Discord needed. Audio never leaves your device; only an on/off signal is sent. Keep this tab open while you play.</p>

<label>I'm playing</label>
<select id="char"><option value="">Loading characters...</option></select>

<label>Group password</label>
<input id="pw" type="password" placeholder="ask your host">

<label>Sensitivity (move the slider so the bar fills only when you talk)</label>
<input id="sens" type="range" min="1" max="40" value="6">
<div id="meterWrap"><div id="meter"></div></div>
<p class="hint">The green bar is your live mic level. The portrait triggers when it passes your sensitivity threshold.</p>

<label>Hold (ms) - keeps you "speaking" through short pauses</label>
<input id="hold" type="password" style="display:none">
<input id="holdNum" type="number" value="1200" min="200" max="4000" step="100" style="width:120px;padding:8px;border:1px solid #ccc;border-radius:8px">

<button id="go">Start microphone</button>
<div id="state" class="idle">Stopped</div>

<script>
(function(){
 var $=function(id){return document.getElementById(id);};
 var ws=null, ac=null, an=null, stream=null, raf=null, running=false;
 var speaking=false, stopTimer=null;
 var state=$('state'), meter=$('meter');

 // load characters
 fetch('/campaign.json',{cache:'no-store'}).then(function(r){return r.json();}).then(function(c){
   var sel=$('char'); sel.innerHTML='';
   var chars=(c&&c.characters)||{};
   var ids=Object.keys(chars);
   if(!ids.length){ sel.innerHTML='<option value="">(no characters yet - upload at /admin)</option>'; return; }
   sel.innerHTML='<option value="">- choose your character -</option>';
   ids.forEach(function(id){
     var o=document.createElement('option'); o.value=id; o.textContent=chars[id].name||id; sel.appendChild(o);
   });
 }).catch(function(){ $('char').innerHTML='<option value="">(could not load characters)</option>'; });

 function wsUrl(pw){
   var proto = location.protocol==='https:' ? 'wss://' : 'ws://';
   return proto+location.host+'/?role=reporter&password='+encodeURIComponent(pw);
 }
 function send(isSpeaking){
   var id=$('char').value;
   if(ws && ws.readyState===1 && id){ ws.send(JSON.stringify({type:'speaking',userId:id,speaking:isSpeaking})); }
 }
 function setSpeaking(on){
   if(on===speaking) return;
   speaking=on; send(on);
   state.className = on ? 'live' : 'idle';
   state.textContent = on ? '🔊 Speaking - portrait is lit' : 'Listening...';
 }
 function loop(){
   if(!running) return;
   var buf=new Uint8Array(an.fftSize); an.getByteTimeDomainData(buf);
   var sum=0; for(var i=0;i<buf.length;i++){ var x=(buf[i]-128)/128; sum+=x*x; }
   var rms=Math.sqrt(sum/buf.length);
   var level=Math.min(1, rms*4);
   meter.style.width=(level*100).toFixed(0)+'%';
   var threshold=parseInt($('sens').value,10)/100; // 0.01 .. 0.40
   var hold=Math.max(200, parseInt($('holdNum').value,10)||1200);
   if(level>threshold){
     if(stopTimer){ clearTimeout(stopTimer); stopTimer=null; }
     setSpeaking(true);
   } else if(speaking && !stopTimer){
     stopTimer=setTimeout(function(){ stopTimer=null; setSpeaking(false); }, hold);
   }
   raf=requestAnimationFrame(loop);
 }
 function start(){
   var pw=$('pw').value, id=$('char').value;
   if(!id){ state.className='bad'; state.textContent='Pick your character first.'; return; }
   if(!pw){ state.className='bad'; state.textContent='Enter the group password.'; return; }
   navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false})
   .then(function(s){
     stream=s; ac=new (window.AudioContext||window.webkitAudioContext)();
     var srcNode=ac.createMediaStreamSource(s); an=ac.createAnalyser(); an.fftSize=512; srcNode.connect(an);
     ws=new WebSocket(wsUrl(pw));
     ws.onopen=function(){ running=true; state.className='idle'; state.textContent='Listening...'; loop(); };
     ws.onclose=function(){ if(running){ state.className='bad'; state.textContent='Disconnected (wrong password?).'; stop(); } };
     ws.onerror=function(){};
     $('go').textContent='Stop microphone'; $('go').className='stop';
   }).catch(function(e){ state.className='bad'; state.textContent='Mic access denied: '+e.message; });
 }
 function stop(){
   running=false; if(raf)cancelAnimationFrame(raf);
   if(stopTimer){clearTimeout(stopTimer);stopTimer=null;}
   setSpeaking(false);
   if(ws){try{ws.close();}catch(e){} ws=null;}
   if(stream){stream.getTracks().forEach(function(t){t.stop();});stream=null;}
   if(ac){try{ac.close();}catch(e){} ac=null;}
   meter.style.width='0%';
   $('go').textContent='Start microphone'; $('go').className='';
   state.className='idle'; state.textContent='Stopped';
 }
 $('go').onclick=function(){ running?stop():start(); };
})();
</script></body></html>`;
