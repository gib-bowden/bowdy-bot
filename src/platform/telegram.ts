import { Bot } from "grammy";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { IncomingMessage, OutgoingMessage, Platform } from "./types.js";

export class TelegramPlatform implements Platform {
  private bot: Bot;

  constructor() {
    if (!config.telegramBotToken) {
      throw new Error("TELEGRAM_BOT_TOKEN is required for Telegram platform");
    }
    this.bot = new Bot(config.telegramBotToken);
  }

  async start(handler: (message: IncomingMessage) => Promise<OutgoingMessage>): Promise<void> {
    this.bot.on("message:text", async (ctx) => {
      const message: IncomingMessage = {
        platformUserId: String(ctx.from.id),
        platformUsername: ctx.from.username ?? ctx.from.first_name,
        text: ctx.message.text,
        platform: "telegram",
      };

      logger.info({ user: message.platformUsername }, "Telegram message received");

      const response = await handler(message);
      await ctx.reply(response.text);
    });

    logger.info("Starting Telegram bot (polling)");
    this.bot.start();
  }

  stop(): void {
    this.bot.stop();
  }
}
