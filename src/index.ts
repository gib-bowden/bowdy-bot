import { config } from "./config.js";
import { logger } from "./logger.js";
import { ensureSchema } from "./db/migrate.js";
import { ConsolePlatform } from "./platform/console.js";
import type { Platform } from "./platform/types.js";
import { ModuleRegistry } from "./modules/registry.js";
import { AIRouter } from "./ai/router.js";
import { calendarModule } from "./modules/calendar/index.js";
import type { BetaSkillParams } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";

// Ensure DB schema exists
ensureSchema();

// Register modules
const registry = new ModuleRegistry();
const googleOAuthConfigured = !!(config.googleClientId && config.googleClientSecret);
const krogerConfigured = !!(config.krogerClientId && config.krogerClientSecret);

if (googleOAuthConfigured || krogerConfigured) {
  const key = config.tokenEncryptionKey;
  if (!key || !/^[0-9a-f]{64}$/i.test(key)) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY (or GOOGLE_TOKEN_ENCRYPTION_KEY) is required when Google OAuth or Kroger is configured. " +
        "Generate one with: openssl rand -hex 32",
    );
  }
}

if (googleOAuthConfigured) {
  const { googleTasksModule } = await import("./modules/google-tasks/index.js");
  registry.register(googleTasksModule);
  logger.info("Using Google Tasks backend (OAuth)");
}
if (krogerConfigured) {
  const { krogerModule } = await import("./modules/kroger/index.js");
  registry.register(krogerModule);
  logger.info("Using Kroger product search + cart integration");
}

if (googleOAuthConfigured && config.googleCalendarId) {
  registry.register(calendarModule);
}

// Sync skills (best-effort — continue without them on failure)
let skills: BetaSkillParams[] = [];
try {
  const { syncSkills } = await import("./skills/manager.js");
  skills = await syncSkills();
} catch (err) {
  logger.warn({ err }, "Failed to sync skills, continuing without them");
}

// Create AI router
const router = new AIRouter(registry, skills);

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

// Start OAuth — mount on platform server if supported, otherwise standalone
if (googleOAuthConfigured || krogerConfigured) {
  const { createOAuthHandler, createKrogerOAuthHandler, createCombinedHandler, startOAuthServer } = await import("./auth/server.js");

  const handlers = [];
  if (googleOAuthConfigured) handlers.push(createOAuthHandler());
  if (krogerConfigured) handlers.push(createKrogerOAuthHandler());
  const combinedHandler = createCombinedHandler(handlers);

  if (platform.setOAuthHandler) {
    platform.setOAuthHandler(combinedHandler);
    logger.info("OAuth routes mounted on platform server");
  } else {
    startOAuthServer(combinedHandler);
  }
}

logger.info({ platform: config.platform }, "Starting bowdy-bot");

// Start
await platform.start((message, callbacks) => router.handle(message, callbacks));
