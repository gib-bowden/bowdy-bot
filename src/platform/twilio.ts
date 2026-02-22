import { createServer, type IncomingMessage as HttpRequest, type ServerResponse } from "node:http";
import { Twilio } from "twilio";
import { validateRequest } from "twilio";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { IncomingMessage, Platform, MessageHandler } from "./types.js";

const MAX_MESSAGE_LENGTH = 1500;
const SPLIT_DELAY_MS = 500;

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

function parseFormUrlEncoded(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of body.split("&")) {
    const [key, ...rest] = pair.split("=");
    if (key) {
      params[decodeURIComponent(key)] = decodeURIComponent(rest.join("=").replace(/\+/g, " "));
    }
  }
  return params;
}

export class TwilioPlatform implements Platform {
  private server: ReturnType<typeof createServer> | null = null;
  private client: Twilio;
  private allowlist: Map<string, string>;
  private port: number;

  constructor() {
    if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioPhoneNumber) {
      throw new Error(
        "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER are required for Twilio platform.",
      );
    }

    const raw = config.twilioAllowlist;
    if (!raw) {
      throw new Error(
        "TWILIO_ALLOWLIST is required for Twilio platform. " +
          "Set it to a comma-separated list of handle:Name pairs, e.g. +16155551234:Gib,+16155555678:Mary Becker",
      );
    }

    this.allowlist = new Map(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((entry) => {
          const colonIdx = entry.indexOf(":");
          if (colonIdx === -1) {
            return [entry, entry] as [string, string];
          }
          return [
            entry.slice(0, colonIdx).trim(),
            entry.slice(colonIdx + 1).trim(),
          ] as [string, string];
        }),
    );

    this.client = new Twilio(config.twilioAccountSid, config.twilioAuthToken);
    this.port = parseInt(process.env["PORT"] || config.twilioWebhookPort, 10);

    logger.info(
      { allowlistSize: this.allowlist.size },
      "Twilio allowlist loaded",
    );
  }

  private getAllowedName(phoneNumber: string): string | null {
    return this.allowlist.get(phoneNumber) ?? null;
  }

  async start(handler: MessageHandler): Promise<void> {
    let processing = false;
    const queue: Array<{ from: string; body: string; senderName: string }> = [];

    const processQueue = async () => {
      if (processing) return;
      processing = true;

      while (queue.length > 0) {
        const item = queue.shift()!;

        const message: IncomingMessage = {
          platformUserId: item.from,
          platformUsername: item.senderName,
          text: item.body,
          platform: "twilio",
        };

        logger.info({ user: item.senderName, from: item.from }, "SMS received");

        try {
          const responseText = await handler(message);
          const chunks = splitMessage(responseText);
          for (let i = 0; i < chunks.length; i++) {
            if (i > 0) {
              await new Promise((resolve) => setTimeout(resolve, SPLIT_DELAY_MS));
            }
            await this.client.messages.create({
              body: chunks[i]!,
              from: config.twilioPhoneNumber,
              to: item.from,
            });
          }
        } catch (err) {
          logger.error({ err }, "Error handling SMS");
          try {
            await this.client.messages.create({
              body: "Sorry, something went wrong. Try again?",
              from: config.twilioPhoneNumber,
              to: item.from,
            });
          } catch {
            logger.error("Failed to send error reply via SMS");
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
        // Always respond 200 to Twilio so it doesn't retry
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end();

        const params = parseFormUrlEncoded(body);
        const from = params["From"];
        const messageBody = params["Body"];

        if (!from || !messageBody) {
          logger.debug("Received webhook without From or Body");
          return;
        }

        // Validate Twilio signature
        const twilioSignature = req.headers["x-twilio-signature"] as string | undefined;
        if (twilioSignature) {
          const url = `https://${req.headers["host"]}${req.url}`;
          const valid = validateRequest(
            config.twilioAuthToken,
            twilioSignature,
            url,
            params,
          );
          if (!valid) {
            logger.warn({ from }, "Invalid Twilio signature — ignoring");
            return;
          }
        }

        const senderName = this.getAllowedName(from);
        if (!senderName) {
          logger.debug({ from }, "Ignoring SMS from non-allowlisted sender");
          return;
        }

        queue.push({ from, body: messageBody.trim(), senderName });
        processQueue();
      });
    });

    this.server.listen(this.port, () => {
      logger.info({ port: this.port }, "Starting Twilio SMS platform on port %d", this.port);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    logger.info("Twilio SMS platform stopped");
  }
}
