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
import { createHash } from "crypto";
function sha256(x: string): string { return createHash("sha256").update(x).digest("hex"); }

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
interface Campaign { exists: boolean; name?: string | null; joinHash?: string | null; dmHash?: string | null; }
async function sbGetCampaign(room: string): Promise<Campaign> {
  if (!supabaseOn) return room === "DEFAULT" ? { exists: true, name: "Default", joinHash: null, dmHash: null } : { exists: false };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/campaigns?room=eq.${encodeURIComponent(room)}&select=room,name,join_hash,dm_key`, { headers: sbHeaders });
  if (!r.ok) return { exists: false };
  const rows = (await r.json()) as any[];
  if (!rows.length) return { exists: false };
  return { exists: true, name: rows[0].name, joinHash: rows[0].join_hash ?? null, dmHash: rows[0].dm_key ?? null };
}
async function sbListCharacters(room: string): Promise<Array<{ char_id: string; name: string; portrait_url: string; kind: string }>> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/characters?room=eq.${encodeURIComponent(room)}&select=char_id,name,portrait_url,kind&order=name`, { headers: sbHeaders });
  if (!r.ok) throw new Error(`list ${r.status}`);
  return (await r.json()) as any;
}
async function sbUpload(room: string, id: string, name: string, contentType: string, bytes: Buffer, kind: string): Promise<string> {
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
    body: JSON.stringify({ room, char_id: id, name, portrait_url: publicUrl, kind }),
  });
  if (!row.ok) throw new Error(`db ${row.status}: ${await row.text()}`);
  return publicUrl;
}
async function sbDelete(room: string, id: string): Promise<void> {
  const key = `${encodeURIComponent(room)}/${encodeURIComponent(id)}`;
  await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${key}`, { method: "DELETE", headers: sbHeaders }).catch(() => {});
  const r = await fetch(`${SUPABASE_URL}/rest/v1/characters?room=eq.${encodeURIComponent(room)}&char_id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: sbHeaders });
  if (!r.ok) throw new Error(`delete ${r.status}: ${await r.text()}`);
}
async function sbCreateRoom(name: string, joinHash: string | null): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genRoomCode();
    const r = await fetch(`${SUPABASE_URL}/rest/v1/campaigns`, {
      method: "POST",
      headers: { ...sbHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ room: code, name, join_hash: joinHash }),
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
      return res.end(JSON.stringify({ ok: true, mode: supabaseOn ? "supabase" : "file", admin: !!ADMIN_PASSWORD, rooms: rooms.size }));
    }

    if ((url.pathname === "/" || url.pathname === "/mic" || url.pathname === "/create") && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...CORS });
      return res.end(PORTAL_HTML);
    }
    if (url.pathname === "/room") {
      const room = roomOf(url);
      const join = url.searchParams.get("join") ?? "";
      const camp = await sbGetCampaign(room);
      const joinRequired = !!camp.joinHash;
      const joinOk = !camp.joinHash || (!!join && sha256(join) === camp.joinHash);
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      return res.end(JSON.stringify({ exists: camp.exists, name: camp.name ?? null, joinRequired, joinOk }));
    }
    if (url.pathname === "/create" && req.method === "POST") {
      if (!supabaseOn) { res.writeHead(503, CORS); return res.end("not configured"); }
      const pass = url.searchParams.get("password") ?? "";
      const name = (url.searchParams.get("name") ?? "").trim();
      // Creation is OPEN unless an operator lock (ADMIN_PASSWORD) is configured.
      if (ADMIN_PASSWORD && pass !== ADMIN_PASSWORD) { res.writeHead(401, CORS); return res.end("wrong admin password"); }
      if (!name) { res.writeHead(400, CORS); return res.end("name required"); }
      const joinpw = url.searchParams.get("joinpw") ?? "";
      const joinHash = joinpw ? sha256(joinpw) : null;
      const room = await sbCreateRoom(name, joinHash);
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      return res.end(JSON.stringify({ ok: true, room }));
    }

    if (url.pathname === "/campaign.json") {
      const room = roomOf(url);
      let payload: any = { campaignName: room, characters: {} };
      if (supabaseOn) {
        const rows = await sbListCharacters(room);
        for (const row of rows) payload.characters[row.char_id] = { name: row.name, portrait: row.portrait_url, kind: row.kind || "pc" };
      }
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      return res.end(JSON.stringify(payload));
    }

    if (url.pathname === "/admin/upload" && req.method === "POST") {
      if (!supabaseOn) { res.writeHead(503, CORS); return res.end("uploads not configured"); }
      const room = roomOf(url);
      const camp = await sbGetCampaign(room);
      if (!camp.exists) { res.writeHead(404, CORS); return res.end("unknown campaign code"); }
      if (camp.joinHash && sha256(url.searchParams.get("join") ?? "") !== camp.joinHash) { res.writeHead(401, CORS); return res.end("join password required"); }
      const rawId = (url.searchParams.get("id") ?? "").trim();
      const name = (url.searchParams.get("name") ?? "").trim();
      const type = url.searchParams.get("type") ?? "image/png";
      if (!name) { res.writeHead(400, CORS); return res.end("name required"); }
      const id = /^[A-Za-z0-9_-]{3,40}$/.test(rawId) ? rawId : slugify(name);
      if (!id) { res.writeHead(400, CORS); return res.end("invalid name"); }
      const bytes = await readBody(req);
      if (!bytes.length) { res.writeHead(400, CORS); return res.end("no image"); }
      const kind = url.searchParams.get("kind") === "npc" ? "npc" : "pc";
      await sbUpload(room, id, name, type, bytes, kind);
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      return res.end(JSON.stringify({ ok: true, id }));
    }

    if (url.pathname === "/admin/delete" && req.method === "POST") {
      if (!supabaseOn) { res.writeHead(503, CORS); return res.end("not configured"); }
      const room = roomOf(url);
      const camp = await sbGetCampaign(room);
      if (!camp.exists) { res.writeHead(404, CORS); return res.end("unknown campaign code"); }
      if (camp.joinHash && sha256(url.searchParams.get("join") ?? "") !== camp.joinHash) { res.writeHead(401, CORS); return res.end("join password required"); }
      const id = (url.searchParams.get("id") ?? "").trim();
      if (!id) { res.writeHead(400, CORS); return res.end("id required"); }
      await sbDelete(room, id);
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
function broadcast(room: Room, msg: unknown) {
  const data = JSON.stringify(msg);
  for (const ws of room.displays) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}
function onSpeaking(room: Room, buf: RawData) {
  let msg: any;
  try { msg = JSON.parse(buf.toString()); } catch { return; }
  if (typeof msg.userId !== "string") return;
  if (msg.type === "level") {
    const lvl = Math.max(0, Math.min(1, Number(msg.level) || 0));
    broadcast(room, { type: "level", userId: msg.userId, level: lvl, ts: Date.now() });
    return;
  }
  if (msg.type !== "speaking") return;
  if (msg.speaking) room.speaking.add(msg.userId); else room.speaking.delete(msg.userId);
  broadcast(room, { type: "speaking", userId: msg.userId, speaking: !!msg.speaking, ts: Date.now() });
}

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const code = roomOf(url);
  const role = url.searchParams.get("role") ?? "display";

  const camp = await sbGetCampaign(code);
  if (!camp.exists) { return ws.close(1008, "unknown room"); }
  const room = getRoom(code);

  if (role === "source") {
    if (RELAY_TOKEN && url.searchParams.get("token") !== RELAY_TOKEN) return ws.close(1008, "bad token");
    ws.on("message", (b) => onSpeaking(room, b));
    return;
  }
  if (role === "reporter") {
    if (camp.joinHash && sha256(url.searchParams.get("join") ?? "") !== camp.joinHash) return ws.close(1008, "join password required");
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

// ---- Unified portal (dark theme, join/create, roster, upload, mic, DM mode) -
const PORTAL_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>D&D Voice Overlay</title>
<style>
 :root{--gold:#e4c478;--bg1:#13111c;--bg2:#1b1530;--card:#241c3a;--ink:#f4ecd2;--mut:#a99fc4;--line:rgba(228,196,120,.22)}
 *{box-sizing:border-box}
 body{font-family:"Trebuchet MS",system-ui,Segoe UI,sans-serif;color:var(--ink);margin:0;min-height:100vh;
   background:radial-gradient(1200px 600px at 50% -10%,#2a2147 0%,var(--bg2) 40%,var(--bg1) 100%)}
 .wrap{max-width:520px;margin:0 auto;padding:30px 18px 70px}
 h1{font-size:23px;margin:0 0 4px;letter-spacing:.3px}
 .sub{color:var(--mut);font-size:13px;margin:0 0 20px}
 label{display:block;margin:16px 0 5px;font-size:12px;color:var(--mut);font-weight:700;text-transform:uppercase;letter-spacing:.5px}
 input,select{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;font-size:14px;background:#150f24;color:var(--ink)}
 input::placeholder{color:#6b6385}
 input[type=range]{padding:0;border:0;background:none}
 input[type=file]{padding:8px}
 button{margin-top:14px;width:100%;padding:13px;border:0;border-radius:11px;font-weight:800;font-size:15px;cursor:pointer;
   background:linear-gradient(180deg,#f0d291,#d8b15e);color:#231a06;box-shadow:0 4px 14px rgba(0,0,0,.35)}
 button:active{transform:translateY(1px)}
 button.stop{background:linear-gradient(180deg,#e06b5f,#c0392b);color:#fff}
 button.ghost{background:rgba(255,255,255,.07);color:var(--ink);box-shadow:none;border:1px solid var(--line);font-weight:700}
 .hint{font-size:12px;color:var(--mut);margin-top:6px;line-height:1.5}.bad{color:#ff9a8f}.ok{color:#8ee6a0}.live{color:#8ee6a0}.idle{color:var(--mut)}
 details{margin-top:14px;border:1px solid var(--line);border-radius:12px;padding:10px 14px;background:rgba(255,255,255,.03)}
 summary{cursor:pointer;font-size:13px;font-weight:700;color:var(--ink)}
 img#prev{max-width:120px;border-radius:10px;margin-top:10px;display:none}
 #meterWrap{height:16px;background:#150f24;border:1px solid var(--line);border-radius:9px;overflow:hidden;margin-top:8px}
 #meter{height:100%;width:0%;background:linear-gradient(90deg,#7bd88f,#2ecc71)}
 #state{margin-top:14px;font-size:15px;font-weight:800;min-height:22px}
 .hdr{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:2px}
 .pill{background:#0e0a1c;color:var(--gold);border:1px solid var(--line);border-radius:999px;padding:5px 14px;font-size:13px;font-weight:800;letter-spacing:1px}
 .switch{font-size:12px;color:var(--gold);cursor:pointer;text-decoration:underline;background:none;border:0;width:auto;margin:0 0 8px;padding:0;box-shadow:none}
 .seg{display:flex;gap:6px;background:#150f24;border:1px solid var(--line);border-radius:11px;padding:5px;margin-top:14px}
 .seg button{margin:0;background:none;color:var(--mut);box-shadow:none;font-weight:800;padding:9px;border-radius:8px}
 .seg button.on{background:linear-gradient(180deg,#f0d291,#d8b15e);color:#231a06}
 .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px}
 .npc{position:relative;border-radius:12px;overflow:hidden;cursor:pointer;border:2px solid transparent;background:var(--card);aspect-ratio:3/4}
 .npc img{width:100%;height:100%;object-fit:cover;display:block;opacity:.5;transition:opacity .15s,transform .15s}
 .npc.active{border-color:var(--gold);box-shadow:0 0 0 2px rgba(228,196,120,.25),0 8px 22px rgba(0,0,0,.55)}
 .npc.active img{opacity:1;transform:scale(1.03)}
 .npc .nm{position:absolute;left:0;right:0;bottom:0;padding:8px 6px;background:linear-gradient(transparent,rgba(0,0,0,.85));font-size:12px;font-weight:800;text-align:center}
 .npc .kbd{position:absolute;top:6px;left:6px;background:rgba(0,0,0,.65);color:var(--gold);border-radius:6px;padding:1px 8px;font-size:12px;font-weight:800}
 .card{border:1px solid var(--line);background:rgba(255,255,255,.04);border-radius:12px;padding:14px;margin-top:14px;font-size:13px;color:var(--mut)}
 code{background:#0e0a1c;color:var(--gold);padding:2px 8px;border-radius:6px;font-size:13px}
</style></head><body><div class="wrap">

<div id="joinView">
 <h1>🎭 D&D Voice Overlay</h1>
 <p class="sub">Your character lights up on Roll20 when you talk — your own mic, no Discord.</p>
 <label>Campaign code</label>
 <input id="code" type="text" placeholder="e.g. RAVEN7" style="text-transform:uppercase">
 <div id="joinPwRow" style="display:none"><label>Campaign join password</label><input id="joinPw" type="password" placeholder="password from your host"></div>
 <button id="joinBtn">Join campaign</button>
 <div id="joinMsg" class="hint"></div>
 <details>
  <summary>I'm the Game Master — create a new campaign</summary>
  <label>Campaign name</label><input id="cName" type="text" placeholder="e.g. Curse of Strahd">
  <label>Join password <span style="text-transform:none;font-weight:400;color:#8a82a6">(optional &mdash; leave blank for open join)</span></label><input id="cJoinPw" type="password" placeholder="optional">
  <label id="cPwLabel" style="display:none">Admin password</label><input id="cPw" type="password" placeholder="admin password (only if your server requires it)" style="display:none">
  <button id="createBtn" class="ghost">Create campaign</button>
  <div id="createMsg" class="hint"></div>
 </details>
</div>

<div id="playView" style="display:none">
 <div class="hdr"><h1 style="font-size:20px;margin:0">🎭 Voice Overlay</h1><span class="pill" id="pill"></span></div>
 <button class="switch" id="switchBtn">switch campaign</button>

 <details id="hostBox" style="display:none"><summary>👑 Invite players</summary><div class="hint" id="shareInfo"></div></details>

 <label style="display:flex;align-items:center;gap:9px;margin-top:16px;cursor:pointer;font-size:14px;color:var(--ink);text-transform:none;letter-spacing:0"><input type="checkbox" id="dmChk" style="width:auto;margin:0"> 👑 I'm the DM &mdash; control all characters</label>

 <div id="playerPane">
  <label>I'm playing</label>
  <select id="char"><option value="">Loading...</option></select>
 </div>

 <div id="dmPane" style="display:none">
  <label>Tap a character (or press 1-9) to make them the active speaker</label>
  <div class="grid" id="board"></div>
 </div>

 <details><summary>+ Add or update a character</summary>
  <label>Character name</label><input id="newName" type="text" placeholder="e.g. Medvind">
  <label>Portrait image (transparent PNG looks best)</label><input id="newFile" type="file" accept="image/*">
  <img id="prev"><button id="add" class="ghost">Save portrait</button><div id="addMsg" class="hint"></div>
 </details>

 <label>Sensitivity (fill the bar only when you talk)</label>
 <input id="sens" type="range" min="1" max="40" value="6"><div id="meterWrap"><div id="meter"></div></div>
 <label>Hold (ms) — stays lit through short pauses</label><input id="holdNum" type="number" value="1200" min="200" max="4000" step="100">
 <button id="go">Start microphone</button>
 <div id="state" class="idle">Stopped</div>

 <p class="hint" style="margin-top:18px">To see the portraits, install the Roll20 overlay extension and enter this campaign code in its popup. Keep this tab open while you play.</p>
</div>

</div><script>
(function(){
 var $=function(i){return document.getElementById(i);};
 var room='', mode='player', dmActive='', boardIds=[], chars={}, adminRequired=false, dmKeyVal='', joinPwVal='';
 fetch('/health').then(function(r){return r.json();}).then(function(j){
   adminRequired=!!j.admin;
   if(adminRequired){$('cPwLabel').style.display='block';$('cPw').style.display='block';}
 }).catch(function(){});
 var ws=null,ac=null,an=null,sp=null,stream=null,raf=null,running=false,speaking=false,stopTimer=null,lastLevel=0,lastLoud=0;
 var state=$('state'),meter=$('meter');
 function api(p){return p+(p.indexOf('?')<0?'?':'&')+'room='+encodeURIComponent(room)+(joinPwVal?('&join='+encodeURIComponent(joinPwVal)):'');}

 function showJoin(){$('joinView').style.display='block';$('playView').style.display='none';}
function renderShare(){
   var plink=location.origin+'/?room='+room;
   $('shareInfo').innerHTML='<b>You are the DM 👑</b> &mdash; players you invite can only control their own character.<br><br><b>Send your players this one link:</b><br><code id="plink">'+plink+'</code> <button id="copyP" class="ghost" style="width:auto;margin-top:8px;padding:6px 14px">Copy link</button><br><span style="color:#8a82a6">(or they enter code <b>'+room+'</b> in the overlay extension)</span>';
   var cp=$('copyP'); if(cp)cp.onclick=function(){try{navigator.clipboard.writeText(plink);}catch(e){} cp.textContent='Copied!'; setTimeout(function(){cp.textContent='Copy link';},1500);};
 }
 function applyDmMode(on){
   $('dmChk').checked=on;
   $('hostBox').style.display=on?'block':'none';
   if(on)renderShare();
   setMode(on?'dm':'player');
 }
 function enter(code,name,asDm){
   room=code.toUpperCase(); try{localStorage.setItem('dndRoom',room);}catch(e){}
   $('pill').textContent=room;
   applyDmMode(!!asDm);
   $('joinView').style.display='none'; $('playView').style.display='block'; loadChars();
 }
 $('dmChk').onchange=function(){applyDmMode($('dmChk').checked);};
  $('joinBtn').onclick=function(){
   var code=($('code').value||'').trim().toUpperCase(),m=$('joinMsg');m.className='hint';
   if(!code){m.className='bad';m.textContent='Enter a campaign code.';return;}
   m.textContent='Checking...';
   var jp=$('joinPw').value||''; if(!jp){try{jp=localStorage.getItem('dndJoin_'+code)||'';}catch(e){}}
   var q='/room?room='+encodeURIComponent(code)+(jp?('&join='+encodeURIComponent(jp)):'');
   fetch(q).then(function(r){return r.json();}).then(function(j){
     if(!j.exists){m.className='bad';m.textContent='No campaign with that code.';return;}
     if(j.joinRequired&&!j.joinOk){
       $('joinPwRow').style.display='block';
       m.className=jp?'bad':'hint'; m.textContent=jp?'Wrong join password.':'This campaign needs a join password.';
       return;
     }
     joinPwVal=jp; if(jp){try{localStorage.setItem('dndJoin_'+code,jp);}catch(e){}}
     m.textContent=''; enter(code,j.name,false);
   }).catch(function(){m.className='bad';m.textContent='Could not reach server.';});
 };
 $('createBtn').onclick=function(){
   var name=($('cName').value||'').trim(),joinpw=($('cJoinPw').value||''),pw=$('cPw').value,m=$('createMsg');m.className='hint';
   if(!name){m.className='bad';m.textContent='Enter a campaign name.';return;}
   if(adminRequired&&!pw){m.className='bad';m.textContent='This server requires an admin password.';return;}
   m.textContent='Creating...';
   var prm={name:name}; if(joinpw)prm.joinpw=joinpw; if(adminRequired)prm.password=pw;
   fetch('/create?'+new URLSearchParams(prm),{method:'POST'})
   .then(function(r){if(!r.ok)return r.text().then(function(t){throw new Error(t);});return r.json();})
   .then(function(j){try{if(joinpw)localStorage.setItem('dndJoin_'+j.room,joinpw);}catch(e){}joinPwVal=joinpw;m.className='ok';m.textContent='Created code '+j.room;enter(j.room,name,true);})
   .catch(function(e){m.className='bad';m.textContent='Failed: '+e.message;});
 };
 $('switchBtn').onclick=function(){if(running)stopMic();try{localStorage.removeItem('dndRoom');}catch(e){}room='';showJoin();};

 // mode toggle
 function setMode(m){
   if(speaking)setSpeaking(false);
   mode=m;
   $('playerPane').style.display=m==='player'?'block':'none';
   $('dmPane').style.display=m==='dm'?'block':'none';
   if(m==='dm'&&!dmActive&&boardIds.length){setDmActive(boardIds[0]);}
 }

 function loadChars(sel){return fetch(api('/campaign.json'),{cache:'no-store'}).then(function(r){return r.json();}).then(function(c){
   chars=(c&&c.characters)||{}; boardIds=Object.keys(chars);
   // player dropdown
   var s=$('char');
   s.innerHTML=boardIds.length?'<option value="">- choose your character -</option>':'<option value="">(none yet - add below)</option>';
   boardIds.forEach(function(id){var o=document.createElement('option');o.value=id;o.textContent=chars[id].name||id;if(id===sel)o.selected=true;s.appendChild(o);});
   // DM board
   var b=$('board'); b.innerHTML='';
   boardIds.forEach(function(id,i){
     var d=document.createElement('div'); d.className='npc'; d.dataset.id=id;
     var img=document.createElement('img'); img.src=chars[id].portrait||''; img.alt=chars[id].name||'';
     var nm=document.createElement('div'); nm.className='nm'; nm.textContent=chars[id].name||id;
     d.appendChild(img); d.appendChild(nm);
     if(i<9){var k=document.createElement('div');k.className='kbd';k.textContent=(i+1);d.appendChild(k);}
     d.onclick=function(){setDmActive(id);};
     b.appendChild(d);
   });
   if(mode==='dm'){ if(boardIds.indexOf(dmActive)<0) dmActive=''; if(!dmActive&&boardIds.length)setDmActive(boardIds[0]); else highlightBoard(); }
 }).catch(function(){$('char').innerHTML='<option value="">(could not load)</option>';});}

 function highlightBoard(){var cards=$('board').children;for(var i=0;i<cards.length;i++){cards[i].className='npc'+(cards[i].dataset.id===dmActive?' active':'');}}
 function setDmActive(id){
   if(mode==='dm'&&speaking&&dmActive!==id){ rawSend(dmActive,false); rawSend(id,true); }
   dmActive=id; highlightBoard();
 }
 document.addEventListener('keydown',function(e){
   if(mode!=='dm'||$('playView').style.display==='none')return;
   if(e.target&&/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName))return;
   var n=parseInt(e.key,10); if(n>=1&&n<=9&&boardIds[n-1])setDmActive(boardIds[n-1]);
 });

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

 function curId(){return mode==='dm'?dmActive:$('char').value;}
 function wsUrl(){var p=location.protocol==='https:'?'wss://':'ws://';return p+location.host+'/?role=reporter&room='+encodeURIComponent(room)+(joinPwVal?('&join='+encodeURIComponent(joinPwVal)):'');}
 function rawSend(id,on){if(ws&&ws.readyState===1&&id)ws.send(JSON.stringify({type:'speaking',userId:id,speaking:on}));}
 function setSpeaking(on){if(on===speaking)return;speaking=on;rawSend(curId(),on);state.className=on?'live':'idle';state.textContent=on?'🔊 Speaking - portrait is lit':'Listening...';}
 // Visual meter only (may pause when tab is hidden - that's fine).
 function meterLoop(){if(!running)return;meter.style.width=(lastLevel*100).toFixed(0)+'%';raf=requestAnimationFrame(meterLoop);}
 // Voice detection runs on the AUDIO thread via a ScriptProcessor, so it keeps
 // working even when this tab is in the background.
 function onAudio(e){
   if(!running)return;
   var d=e.inputBuffer.getChannelData(0),s=0;for(var i=0;i<d.length;i++)s+=d[i]*d[i];
   var level=Math.min(1,Math.sqrt(s/d.length)*4);lastLevel=level;
   var thr=parseInt($('sens').value,10)/100,hold=Math.max(200,parseInt($('holdNum').value,10)||1200),now=Date.now();
   if(level>thr){lastLoud=now;if(!speaking)setSpeaking(true);}
   else if(speaking&&now-lastLoud>hold){setSpeaking(false);}
 }
 function startMic(){
   if(mode==='player'&&!$('char').value){state.className='bad';state.textContent='Pick your character first.';return;}
   if(mode==='dm'&&!dmActive){state.className='bad';state.textContent='Tap a character first.';return;}
   navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false}).then(function(st){
     stream=st;ac=new (window.AudioContext||window.webkitAudioContext)();var sn=ac.createMediaStreamSource(st);
     sp=ac.createScriptProcessor(2048,1,1);sp.onaudioprocess=onAudio;sn.connect(sp);sp.connect(ac.destination);
     ws=new WebSocket(wsUrl());ws.onopen=function(){running=true;lastLoud=Date.now();state.className='idle';state.textContent='Listening...';meterLoop();};
     ws.onclose=function(){if(running){state.className='bad';state.textContent='Disconnected.';stopMic();}};
     $('go').textContent='Stop microphone';$('go').className='stop';
   }).catch(function(e){state.className='bad';state.textContent='Mic denied: '+e.message;});}
 function stopMic(){running=false;if(raf)cancelAnimationFrame(raf);setSpeaking(false);
   if(sp){try{sp.disconnect();sp.onaudioprocess=null;}catch(e){}sp=null;}
   if(ws){try{ws.close();}catch(e){}ws=null;}if(stream){stream.getTracks().forEach(function(t){t.stop();});stream=null;}if(ac){try{ac.close();}catch(e){}ac=null;}
   meter.style.width='0%';$('go').textContent='Start microphone';$('go').className='';state.className='idle';state.textContent='Stopped';}
 $('go').onclick=function(){running?stopMic():startMic();};

 var params=new URLSearchParams(location.search);
 var urlRoom=(params.get('room')||'').toUpperCase(), saved='';
 try{saved=(localStorage.getItem('dndRoom')||'').toUpperCase();}catch(e){}
 var initial=urlRoom||saved;
 if(initial){
   var jp=params.get('join')||''; if(!jp){try{jp=localStorage.getItem('dndJoin_'+initial)||'';}catch(e){}}
   var q='/room?room='+encodeURIComponent(initial)+(jp?('&join='+encodeURIComponent(jp)):'');
   fetch(q).then(function(r){return r.json();}).then(function(j){
     if(!j.exists){showJoin();return;}
     if(j.joinRequired&&!j.joinOk){ $('code').value=initial; $('joinPwRow').style.display='block'; showJoin(); return; }
     joinPwVal=jp||''; enter(initial,j.name,false);
   }).catch(showJoin);
 } else showJoin();
})();
</script></body></html>`;
