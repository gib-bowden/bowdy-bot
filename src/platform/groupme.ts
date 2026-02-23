import { createServer, type IncomingMessage as HttpRequest, type ServerResponse } from "node:http";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { IncomingMessage, Platform, MessageHandler } from "./types.js";

const MAX_MESSAGE_LENGTH = 1000;
const SPLIT_DELAY_MS = 500;
const GROUPME_API_URL = "https://api.groupme.com/v3/bots/post";

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_MESSAGE_LENGTH) {
    let splitIdx = remaining.lastIndexOf("\n\n", MAX_MESSAGE_LENGTH);
    if (splitIdx < MAX_MESSAGE_LENGTH / 2) {
      splitIdx = remaining.lastIndexOf(". ", MAX_MESSAGE_LENGTH);
      if (splitIdx > 0) splitIdx += 1;
    }
    if (splitIdx < MAX_MESSAGE_LENGTH / 2) {
      splitIdx = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
    }
    if (splitIdx < MAX_MESSAGE_LENGTH / 2) {
      splitIdx = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

interface GroupMeWebhookPayload {
  attachments: unknown[];
  avatar_url: string;
  created_at: number;
  group_id: string;
  id: string;
  name: string;
  sender_id: string;
  sender_type: string;
  source_guid: string;
  system: boolean;
  text: string;
  user_id: string;
}

async function sendGroupMeMessage(botId: string, text: string): Promise<void> {
  const response = await fetch(GROUPME_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bot_id: botId, text }),
  });

  if (!response.ok) {
    throw new Error(`GroupMe API error: ${response.status} ${response.statusText}`);
  }
}

export class GroupMePlatform implements Platform {
  private server: ReturnType<typeof createServer> | null = null;
  private botId: string;
  private port: number;

  constructor() {
    if (!config.groupmeBotId) {
      throw new Error("GROUPME_BOT_ID is required for GroupMe platform.");
    }

    this.botId = config.groupmeBotId;
    this.port = parseInt(process.env["PORT"] || config.groupmeWebhookPort, 10);
  }

  async start(handler: MessageHandler): Promise<void> {
    let processing = false;
    const queue: Array<{ senderId: string; senderName: string; text: string }> = [];

    const processQueue = async () => {
      if (processing) return;
      processing = true;

      while (queue.length > 0) {
        const item = queue.shift()!;

        const message: IncomingMessage = {
          platformUserId: item.senderId,
          platformUsername: item.senderName,
          text: item.text,
          platform: "groupme",
        };

        logger.info({ user: item.senderName, senderId: item.senderId }, "GroupMe message received");

        try {
          const responseText = await handler(message);
          const chunks = splitMessage(responseText);
          for (let i = 0; i < chunks.length; i++) {
            if (i > 0) {
              await new Promise((resolve) => setTimeout(resolve, SPLIT_DELAY_MS));
            }
            await sendGroupMeMessage(this.botId, chunks[i]!);
          }
        } catch (err) {
          logger.error({ err }, "Error handling GroupMe message");
          try {
            await sendGroupMeMessage(this.botId, "Sorry, something went wrong. Try again?");
          } catch {
            logger.error("Failed to send error reply via GroupMe");
          }
        }
      }

      processing = false;
    };

    this.server = createServer((req: HttpRequest, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }

      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });

      req.on("end", () => {
        // Always respond 200 so GroupMe doesn't retry
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end();

        let payload: GroupMeWebhookPayload;
        try {
          payload = JSON.parse(body) as GroupMeWebhookPayload;
        } catch {
          logger.debug("Received webhook with invalid JSON");
          return;
        }

        // Ignore bot messages to prevent infinite loops
        if (payload.sender_type === "bot") {
          return;
        }

        // Ignore system messages
        if (payload.system) {
          return;
        }

        if (!payload.text) {
          logger.debug("Received webhook without text");
          return;
        }

        queue.push({
          senderId: payload.sender_id,
          senderName: payload.name,
          text: payload.text.trim(),
        });
        processQueue();
      });
    });

    this.server.listen(this.port, () => {
      logger.info({ port: this.port }, "Starting GroupMe platform on port %d", this.port);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    logger.info("GroupMe platform stopped");
  }
}
