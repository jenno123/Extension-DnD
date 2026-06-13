/**
 * D&D Voice Overlay - Relay server
 * --------------------------------
 * One process that does two jobs on a single port:
 *
 *  1. HTTP  - serves the campaign config and portrait PNGs to the browser
 *             extensions (with permissive CORS so any player's Roll20 tab can
 *             fetch them).
 *  2. WS    - receives speaking events from the host's discord-listener
 *             (role=source) and fans them out to every connected overlay
 *             (role=display).
 *
 * The relay holds the current "who is speaking" set so a player who joins or
 * refreshes mid-session immediately sees the correct lit portrait.
 */

import http from "http";
import { readFile } from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT ?? 8787);
const CONFIG_DIR = path.resolve(
  process.cwd(),
  process.env.CONFIG_DIR ?? "../../config"
);
const PORTRAITS_DIR = path.join(CONFIG_DIR, "portraits");
const RELAY_TOKEN = process.env.RELAY_TOKEN ?? "";

// ---- Shared message shape (mirrored in the extension) ----------------------
type SpeakingMessage = {
  type: "speaking";
  userId: string;
  speaking: boolean;
  ts: number;
};
type SnapshotMessage = { type: "snapshot"; speaking: string[]; ts: number };

// Currently-speaking Discord user IDs.
const speaking = new Set<string>();
const displays = new Set<WebSocket>();

// ---- HTTP ------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  try {
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      return res.end(
        JSON.stringify({ ok: true, displays: displays.size, speaking: [...speaking] })
      );
    }

    if (url.pathname === "/campaign.json") {
      const raw = await readFile(path.join(CONFIG_DIR, "campaign.json"), "utf8");
      // Parse + re-stringify so a malformed file fails loudly here, not in the browser.
      const parsed = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      return res.end(JSON.stringify(parsed));
    }

    if (url.pathname.startsWith("/portraits/")) {
      // Strip the prefix and block path traversal.
      const name = path.basename(decodeURIComponent(url.pathname.slice("/portraits/".length)));
      const file = path.join(PORTRAITS_DIR, name);
      if (!file.startsWith(PORTRAITS_DIR)) {
        res.writeHead(403, CORS);
        return res.end("forbidden");
      }
      const ext = path.extname(name).toLowerCase();
      const mime =
        ext === ".png" ? "image/png" :
        ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
        ext === ".webp" ? "image/webp" :
        ext === ".gif" ? "image/gif" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=3600", ...CORS });
      return createReadStream(file).on("error", () => {
        res.writeHead(404, CORS);
        res.end("not found");
      }).pipe(res);
    }

    res.writeHead(404, CORS);
    res.end("not found");
  } catch (err) {
    console.error("[http] error:", (err as Error).message);
    res.writeHead(500, CORS);
    res.end("server error");
  }
});

// ---- WebSocket -------------------------------------------------------------
const wss = new WebSocketServer({ server });

function broadcastToDisplays(msg: SpeakingMessage) {
  const data = JSON.stringify(msg);
  for (const ws of displays) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const role = url.searchParams.get("role") ?? "display";

  if (role === "source") {
    if (RELAY_TOKEN && url.searchParams.get("token") !== RELAY_TOKEN) {
      console.warn("[ws] rejected source: bad token");
      ws.close(1008, "bad token");
      return;
    }
    console.log("[ws] source (discord-listener) connected");

    ws.on("message", (buf) => {
      let msg: SpeakingMessage;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (msg.type !== "speaking" || typeof msg.userId !== "string") return;

      if (msg.speaking) speaking.add(msg.userId);
      else speaking.delete(msg.userId);

      broadcastToDisplays({
        type: "speaking",
        userId: msg.userId,
        speaking: !!msg.speaking,
        ts: Date.now(),
      });
    });

    ws.on("close", () => console.log("[ws] source disconnected"));
    return;
  }

  // role === "display"
  displays.add(ws);
  console.log(`[ws] display connected (${displays.size} total)`);

  // Bring the new client up to date immediately.
  const snapshot: SnapshotMessage = {
    type: "snapshot",
    speaking: [...speaking],
    ts: Date.now(),
  };
  ws.send(JSON.stringify(snapshot));

  ws.on("close", () => {
    displays.delete(ws);
    console.log(`[ws] display disconnected (${displays.size} total)`);
  });
});

// Keep-alive ping so dead sockets get pruned (tunnels/proxies drop idle conns).
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`Relay listening on :${PORT}`);
  console.log(`  config dir : ${CONFIG_DIR}`);
  console.log(`  campaign   : http://localhost:${PORT}/campaign.json`);
  console.log(`  portraits  : http://localhost:${PORT}/portraits/<file>`);
  console.log(`  websocket  : ws://localhost:${PORT}/?role=display`);
});
