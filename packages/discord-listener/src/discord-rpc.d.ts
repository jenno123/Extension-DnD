declare module "discord-rpc" {
  import { EventEmitter } from "events";

  export interface LoginOptions {
    clientId: string;
    clientSecret?: string;
    accessToken?: string;
    redirectUri?: string;
    scopes?: string[];
    rpcToken?: string | boolean;
  }

  export interface VoiceChannel {
    id: string;
    name: string;
    guild_id?: string;
    voice_states?: Array<{ user: { id: string; username: string } }>;
  }

  export interface SpeakingPayload {
    user_id: string;
    channel_id?: string;
  }

  export interface Subscription {
    unsubscribe(): Promise<void>;
  }

  export class Client extends EventEmitter {
    constructor(options: { transport: "ipc" | "websocket" });
    user?: { id: string; username: string };
    login(options: LoginOptions): Promise<Client>;
    subscribe(event: string, args?: Record<string, unknown>): Promise<Subscription>;
    request(cmd: string, args?: Record<string, unknown>, evt?: string): Promise<any>;
    destroy(): Promise<void>;
    on(event: "ready", listener: () => void): this;
    on(event: "disconnected", listener: () => void): this;
    on(event: "SPEAKING_START", listener: (data: SpeakingPayload) => void): this;
    on(event: "SPEAKING_STOP", listener: (data: SpeakingPayload) => void): this;
    on(event: "VOICE_CHANNEL_SELECT", listener: (data: { channel_id: string | null }) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  export function register(clientId: string): boolean;
}
