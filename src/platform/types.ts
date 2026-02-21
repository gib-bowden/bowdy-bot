export interface IncomingMessage {
  platformUserId: string;
  platformUsername: string;
  text: string;
  platform: "console" | "telegram";
}

export interface OutgoingMessage {
  text: string;
}

export interface Platform {
  start(handler: (message: IncomingMessage) => Promise<OutgoingMessage>): Promise<void>;
  stop(): void;
}
