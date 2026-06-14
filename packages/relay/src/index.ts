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
import { WebSocketServer, WebSocket } from "ws";

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

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const role = url.searchParams.get("role") ?? "display";

  if (role === "source") {
    if (RELAY_TOKEN && url.searchParams.get("token") !== RELAY_TOKEN) {
      console.warn("[ws] rejected source: bad token");
      return ws.close(1008, "bad token");
    }
    console.log("[ws] source (discord-listener) connected");
    ws.on("message", (buf) => {
      let msg: SpeakingMessage;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (msg.type !== "speaking" || typeof msg.userId !== "string") return;
      if (msg.speaking) speaking.add(msg.userId); else speaking.delete(msg.userId);
      broadcastToDisplays({ type: "speaking", userId: msg.userId, speaking: !!msg.speaking, ts: Date.now() });
    });
    ws.on("close", () => console.log("[ws] source disconnected"));
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
