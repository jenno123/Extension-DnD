/**
 * Thin auto-reconnecting WebSocket client that publishes speaking events to
 * the relay as role=source. Buffers nothing on purpose: speaking state is
 * ephemeral, and the relay re-snapshots displays on (re)connect.
 */
import WebSocket from "ws";

export class RelayClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectMs = 1000;

  constructor(private readonly relayUrl: string, private readonly token: string) {}

  start(): void {
    this.connect();
  }

  private connect(): void {
    const sep = this.relayUrl.includes("?") ? "&" : "?";
    const tokenPart = this.token ? `&token=${encodeURIComponent(this.token)}` : "";
    const url = `${this.relayUrl}${sep}role=source${tokenPart}`;

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.reconnectMs = 1000;
      console.log("[relay] connected");
    });
    this.ws.on("close", () => {
      if (this.closed) return;
      console.warn(`[relay] disconnected, retrying in ${this.reconnectMs}ms`);
      setTimeout(() => this.connect(), this.reconnectMs);
      this.reconnectMs = Math.min(this.reconnectMs * 2, 15000);
    });
    this.ws.on("error", (e) => console.warn("[relay] error:", e.message));
  }

  publishSpeaking(userId: string, speaking: boolean): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "speaking", userId, speaking, ts: Date.now() }));
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
  }
}
