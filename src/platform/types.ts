import type { StreamCallbacks } from "../ai/router.js";
import type { RequestHandler } from "../auth/server.js";

export interface IncomingMessage {
  platformUserId: string;
  platformUsername: string;
  text: string;
  platform: "console" | "telegram" | "twilio" | "groupme";
  imageUrls?: string[];
}

export type MessageHandler = (message: IncomingMessage, callbacks?: StreamCallbacks) => Promise<string>;

export interface Platform {
  start(handler: MessageHandler): Promise<void>;
  stop(): void;
  setOAuthHandler?(handler: RequestHandler): void;
}
