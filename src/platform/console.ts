import * as readline from "node:readline";
import type { IncomingMessage, OutgoingMessage, Platform } from "./types.js";
import { logger } from "../logger.js";

export class ConsolePlatform implements Platform {
  private rl: readline.Interface | null = null;

  async start(handler: (message: IncomingMessage) => Promise<OutgoingMessage>): Promise<void> {
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

      try {
        const response = await handler(message);
        console.log(`\n${response.text}\n`);
      } catch (err) {
        logger.error({ err }, "Error handling message");
        console.log("\n[Error processing message]\n");
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
