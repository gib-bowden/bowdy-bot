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
const googleOAuthConfigured = !!(config.googleClientId && config.googleClientSecret);

if (googleOAuthConfigured) {
  const key = config.googleTokenEncryptionKey;
  if (!key || !/^[0-9a-f]{64}$/i.test(key)) {
    throw new Error(
      "GOOGLE_TOKEN_ENCRYPTION_KEY is required when Google OAuth is configured. " +
        "Generate one with: openssl rand -hex 32",
    );
  }
}

if (googleOAuthConfigured) {
  const { googleTasksModule } = await import("./modules/google-tasks/index.js");
  registry.register(googleTasksModule);
  logger.info("Using Google Tasks backend (OAuth)");
} else {
  registry.register(tasksModule);
}

if (googleOAuthConfigured && config.googleCalendarId) {
  registry.register(calendarModule);
}

// Start OAuth server if Google OAuth is configured
if (googleOAuthConfigured) {
  const { startOAuthServer } = await import("./auth/server.js");
  startOAuthServer();
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
} else if (config.platform === "groupme") {
  const { GroupMePlatform } = await import("./platform/groupme.js");
  platform = new GroupMePlatform();
} else {
  platform = new ConsolePlatform();
}

logger.info({ platform: config.platform }, "Starting bowdy-bot");

// Start
await platform.start((message, callbacks) => router.handle(message, callbacks));
