import {
  createServer,
  type IncomingMessage as HttpRequest,
  type ServerResponse,
} from "node:http";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getClient } from "../ai/client.js";
import type { RequestHandler } from "../auth/server.js";
import type { IncomingMessage, Platform, MessageHandler } from "./types.js";

const MAX_MESSAGE_LENGTH = 1000;
const SPLIT_DELAY_MS = 500;
const GROUPME_API_URL = "https://api.groupme.com/v3/bots/post";
const MAX_RECENT_MESSAGES = 10;

/** Fast-path: explicit bot name mention skips the classifier */
const FAST_TRIGGERS = /\b(bowdy|bowdey|bowdy bot|bowdey bot)\b/i;

interface RecentMessage {
  sender: string;
  text: string;
  isBot: boolean;
}

interface MentionAttachment {
  type: "mentions";
  user_ids: string[];
  loci: number[][];
}

/**
 * Check if the bot is @mentioned in the GroupMe attachments.
 */
function isBotMentioned(
  attachments: unknown[],
  botUserId: string,
): boolean {
  if (!botUserId) return false;
  for (const att of attachments) {
    const a = att as Record<string, unknown>;
    if (a.type === "mentions" && Array.isArray(a.user_ids)) {
      const mention = a as unknown as MentionAttachment;
      if (mention.user_ids.includes(botUserId)) return true;
    }
  }
  return false;
}

/**
 * Use Claude Haiku to classify whether a message is directed at the bot.
 */
async function classifyMessage(
  text: string,
  senderName: string,
  recentMessages: RecentMessage[],
): Promise<boolean> {
  const client = getClient();

  let conversationContext = "";
  if (recentMessages.length > 0) {
    const lines = recentMessages.map(
      (m) => `${m.isBot ? "[Bowdy Bot]" : `[${m.sender}]`}: ${m.text}`,
    );
    conversationContext = `\nRecent group chat messages (oldest first):\n${lines.join("\n")}\n`;
  }

  const prompt = `You are a classifier for a family group chat. Bowdy Bot is an AI assistant that can check grocery lists, the Kroger cart, calendars/schedules, set reminders, search the web, and answer general knowledge questions.

Determine if the following message is something Bowdy Bot should respond to, or if it's just regular conversation between family members.

A message IS for the bot if:
- It asks about or wants to manage a list, grocery cart, calendar, or schedule (e.g., "what's on the list", "what's in the cart", "what's today look like")
- It asks a question or makes a request that requires information lookup or tools (recipes, weather, reminders, general knowledge, product search, etc.)
- It's a follow-up to a recent bot response (check the conversation context)
- It directly addresses the bot by name or role
- When in doubt and the message could reasonably be a request for the bot, say YES

A message is NOT for the bot if:
- It's clearly casual conversation between family members ("lol", "ok sounds good", "love you")
- It's a reaction or response to another human's message
- It's sharing personal updates or coordinating plans directly between family members (e.g., "I'll pick you up at 5")
${conversationContext}
Current message from ${senderName}: "${text}"

Respond with exactly "YES" or "NO".`;

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 3,
      messages: [{ role: "user", content: prompt }],
    });

    const result =
      response.content[0]?.type === "text"
        ? response.content[0].text.trim().toUpperCase()
        : "NO";

    logger.info(
      { sender: senderName, text, classification: result },
      "Message classification result",
    );

    return result === "YES";
  } catch (err) {
    logger.error({ err }, "Message classification failed, falling back to ignore");
    return false;
  }
}

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
    throw new Error(
      `GroupMe API error: ${response.status} ${response.statusText}`,
    );
  }
}

export class GroupMePlatform implements Platform {
  private server: ReturnType<typeof createServer> | null = null;
  private botId: string;
  private botUserId: string;
  private port: number;
  private oauthHandler: RequestHandler | null = null;
  private recentMessages: RecentMessage[] = [];

  constructor() {
    if (!config.groupmeBotId) {
      throw new Error("GROUPME_BOT_ID is required for GroupMe platform.");
    }

    this.botId = config.groupmeBotId;
    this.botUserId = config.groupmeBotUserId;
    this.port = parseInt(process.env["PORT"] || config.groupmeWebhookPort, 10);
  }

  private pushRecentMessage(msg: RecentMessage): void {
    this.recentMessages.push(msg);
    if (this.recentMessages.length > MAX_RECENT_MESSAGES) {
      this.recentMessages.shift();
    }
  }

  setOAuthHandler(handler: RequestHandler): void {
    this.oauthHandler = handler;
  }

  async start(handler: MessageHandler): Promise<void> {
    let processing = false;
    const queue: Array<{ senderId: string; senderName: string; text: string; imageUrls?: string[] }> =
      [];

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
          imageUrls: item.imageUrls,
        };

        logger.info(
          { user: item.senderName, senderId: item.senderId },
          "GroupMe message received",
        );

        try {
          // Send acknowledgment so the group knows the bot heard them
          await sendGroupMeMessage(this.botId, "On it...").catch((err) =>
            logger.warn({ err }, "Failed to send acknowledgment"),
          );

          const responseText = await handler(message);
          const chunks = splitMessage(responseText);
          for (let i = 0; i < chunks.length; i++) {
            if (i > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, SPLIT_DELAY_MS),
              );
            }
            await sendGroupMeMessage(this.botId, chunks[i]!);
          }

          // Buffer bot response so classifier sees it for follow-ups
          this.pushRecentMessage({
            sender: "Bowdy Bot",
            text: responseText.slice(0, 500),
            isBot: true,
          });
        } catch (err) {
          logger.error({ err }, "Error handling GroupMe message");
          try {
            await sendGroupMeMessage(
              this.botId,
              "Sorry, something went wrong. Try again?",
            );
          } catch {
            logger.error("Failed to send error reply via GroupMe");
          }
        }
      }

      processing = false;
    };

    this.server = createServer(async (req: HttpRequest, res: ServerResponse) => {
      if (this.oauthHandler && await this.oauthHandler(req, res)) {
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }

      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });

      req.on("end", async () => {
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

        // Extract image URLs from attachments
        const imageUrls: string[] = [];
        if (Array.isArray(payload.attachments)) {
          for (const att of payload.attachments) {
            const a = att as Record<string, unknown>;
            if (a.type === "image" && typeof a.url === "string") {
              imageUrls.push(a.url);
            }
          }
        }

        if (!payload.text && imageUrls.length === 0) {
          logger.debug("Received webhook without text or images");
          return;
        }

        const rawText = (payload.text ?? "").trim();

        // Always buffer the message for classifier context
        if (rawText) {
          this.pushRecentMessage({
            sender: payload.name,
            text: rawText,
            isBot: false,
          });
        }

        // Determine if the message is directed at the bot:
        // 1. Fast path: explicit name mention
        // 2. @mention in attachments
        // 3. LLM classifier with conversation context
        let directed = false;

        if (FAST_TRIGGERS.test(rawText)) {
          directed = true;
          logger.debug({ user: payload.name }, "Fast-path trigger matched");
        } else if (
          Array.isArray(payload.attachments) &&
          isBotMentioned(payload.attachments, this.botUserId)
        ) {
          directed = true;
          logger.debug({ user: payload.name }, "Bot @mentioned");
        } else if (rawText) {
          directed = await classifyMessage(
            rawText,
            payload.name,
            this.recentMessages.slice(0, -1), // exclude current message (already added)
          );
        }

        if (!directed) {
          logger.debug(
            { user: payload.name, text: rawText },
            "Ignoring GroupMe message not directed at bot",
          );
          return;
        }

        queue.push({
          senderId: payload.sender_id,
          senderName: payload.name,
          text: rawText,
          imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
        });
        processQueue();
      });
    });

    this.server.listen(this.port, () => {
      logger.info(
        { port: this.port },
        "Starting GroupMe platform on port %d",
        this.port,
      );
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
