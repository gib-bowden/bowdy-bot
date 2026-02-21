import { Bot } from "grammy";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { IncomingMessage, Platform, MessageHandler } from "./types.js";

export class TelegramPlatform implements Platform {
  private bot: Bot;

  constructor() {
    if (!config.telegramBotToken) {
      throw new Error("TELEGRAM_BOT_TOKEN is required for Telegram platform");
    }
    this.bot = new Bot(config.telegramBotToken);
  }

  async start(handler: MessageHandler): Promise<void> {
    this.bot.on("message:text", async (ctx) => {
      const message: IncomingMessage = {
        platformUserId: String(ctx.from.id),
        platformUsername: ctx.from.username ?? ctx.from.first_name,
        text: ctx.message.text,
        platform: "telegram",
      };

      logger.info({ user: message.platformUsername }, "Telegram message received");

      // Send typing indicator while processing
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 4000);

      // Send initial typing action immediately
      await ctx.replyWithChatAction("typing").catch(() => {});

      try {
        // No streaming for Telegram — collect full response then send
        const responseText = await handler(message);
        await ctx.reply(responseText);
      } catch (err) {
        logger.error({ err }, "Error handling Telegram message");
        await ctx.reply("Sorry, something went wrong. Try again?");
      } finally {
        clearInterval(typingInterval);
      }
    });

    logger.info("Starting Telegram bot (polling)");
    this.bot.start();
  }

  stop(): void {
    this.bot.stop();
  }
}
