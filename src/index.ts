import { config } from "./config.js";
import { logger } from "./logger.js";
import { ensureSchema } from "./db/migrate.js";
import { ConsolePlatform } from "./platform/console.js";
import type { Platform } from "./platform/types.js";
import { ModuleRegistry } from "./modules/registry.js";
import { AIRouter } from "./ai/router.js";
import { tasksModule } from "./modules/tasks/index.js";
import { calendarModule } from "./modules/calendar/index.js";

// Ensure DB schema exists
ensureSchema();

// Register modules
const registry = new ModuleRegistry();
registry.register(tasksModule);
if (config.googleServiceAccountKeyPath && config.googleCalendarId) {
  registry.register(calendarModule);
}

// Create AI router
const router = new AIRouter(registry);

// Select platform
let platform: Platform;
if (config.platform === "telegram") {
  const { TelegramPlatform } = await import("./platform/telegram.js");
  platform = new TelegramPlatform();
} else if (config.platform === "twilio") {
  const { TwilioPlatform } = await import("./platform/twilio.js");
  platform = new TwilioPlatform();
} else {
  platform = new ConsolePlatform();
}

logger.info({ platform: config.platform }, "Starting bowdy-bot");

// Start
await platform.start((message, callbacks) => router.handle(message, callbacks));
