/**
 * D&D Voice Overlay - Discord RPC listener  (HOST MACHINE ONLY)
 * ------------------------------------------------------------
 * Connects to the host's local Discord desktop app over RPC, subscribes to
 * SPEAKING_START / SPEAKING_STOP for whatever voice channel the host is in,
 * and forwards clean { userId, speaking } events to the relay.
 *
 * Only the host ever authorizes Discord. Players install the extension only.
 *
 * Requires the Discord DESKTOP app to be running and logged in on this machine.
 */
import "dotenv/config";
import { Client } from "discord-rpc";
import { RelayClient } from "./relay-client";

const CLIENT_ID = requireEnv("DISCORD_CLIENT_ID");
const CLIENT_SECRET = requireEnv("DISCORD_CLIENT_SECRET");
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI ?? "http://localhost";
const RELAY_URL = process.env.RELAY_URL ?? "ws://localhost:8787";
const RELAY_TOKEN = process.env.RELAY_TOKEN ?? "";

// Voice read is what gives us speaking start/stop. This scope is gated by
// Discord, but the host IS the app owner, so authorization just works.
const SCOPES = ["rpc", "rpc.voice.read"];

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`Missing required env var ${key}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

const relay = new RelayClient(RELAY_URL, RELAY_TOKEN);
relay.start();

let currentChannelId: string | null = null;

async function main(): Promise<void> {
  const client = new Client({ transport: "ipc" });

  client.on("ready", async () => {
    console.log(`[discord] authorized as ${client.user?.username ?? "unknown"}`);
    await subscribeToCurrentChannel(client);

    // If the host hops to another voice channel, re-point our subscriptions.
    client.on("VOICE_CHANNEL_SELECT", async (data) => {
      console.log(`[discord] voice channel changed -> ${data.channel_id ?? "none"}`);
      await subscribeToCurrentChannel(client);
    });
  });

  client.on("SPEAKING_START", (data) => {
    relay.publishSpeaking(data.user_id, true);
  });
  client.on("SPEAKING_STOP", (data) => {
    relay.publishSpeaking(data.user_id, false);
  });

  client.on("disconnected", () => {
    console.warn("[discord] disconnected from client, retrying login in 3s");
    setTimeout(() => connectWithRetry(client), 3000);
  });

  await connectWithRetry(client);
}

async function connectWithRetry(client: Client): Promise<void> {
  try {
    await client.login({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      scopes: SCOPES,
    });
  } catch (err) {
    console.error("[discord] login failed:", (err as Error).message);
    console.error("  - Is the Discord DESKTOP app running and logged in?");
    console.error("  - Are CLIENT_ID / CLIENT_SECRET / REDIRECT_URI correct?");
    setTimeout(() => connectWithRetry(client), 5000);
  }
}

async function subscribeToCurrentChannel(client: Client): Promise<void> {
  try {
    const vc = await client.request("GET_SELECTED_VOICE_CHANNEL");
    if (!vc) {
      console.log("[discord] not currently in a voice channel; waiting...");
      currentChannelId = null;
      return;
    }
    if (vc.id === currentChannelId) return;

    currentChannelId = vc.id;
    await client.subscribe("SPEAKING_START", { channel_id: vc.id });
    await client.subscribe("SPEAKING_STOP", { channel_id: vc.id });
    console.log(`[discord] listening for speaking in "${vc.name}" (${vc.id})`);
  } catch (err) {
    console.error("[discord] failed to subscribe:", (err as Error).message);
  }
}

process.on("SIGINT", () => {
  console.log("\nshutting down");
  relay.stop();
  process.exit(0);
});

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
