import * as readline from "node:readline";
import type { IncomingMessage, Platform, MessageHandler } from "./types.js";
import { logger } from "../logger.js";

export class ConsolePlatform implements Platform {
  private rl: readline.Interface | null = null;

  async start(handler: MessageHandler): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    logger.info("Console platform started. Type your messages (Ctrl+C to quit):");
    process.stdout.write("\n> ");

    this.rl.on("line", async (line) => {
      const text = line.trim();
      if (!text) {
        process.stdout.write("> ");
        return;
      }

      const message: IncomingMessage = {
        platformUserId: "console-user",
        platformUsername: "console",
        text,
        platform: "console",
      };

      process.stdout.write("\n");

      try {
        await handler(message, {
          onText: (chunk) => process.stdout.write(chunk),
          onComplete: () => process.stdout.write("\n\n"),
        });
      } catch (err) {
        logger.error({ err }, "Error handling message");
        console.log("[Error processing message]\n");
      }

      process.stdout.write("> ");
    });

    this.rl.on("close", () => {
      logger.info("Console platform stopped");
      process.exit(0);
    });
  }

  stop(): void {
    this.rl?.close();
  }
}
