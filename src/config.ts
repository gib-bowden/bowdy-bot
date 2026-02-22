import "dotenv/config";

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const config = {
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  platform: optional("PLATFORM", "console") as "console" | "telegram" | "imessage",
  telegramBotToken: process.env["TELEGRAM_BOT_TOKEN"] ?? "",
  imessageAllowlist: process.env["IMESSAGE_ALLOWLIST"] ?? "",
  imessageChatDbPath: optional(
    "IMESSAGE_CHAT_DB_PATH",
    `${process.env["HOME"]}/Library/Messages/chat.db`,
  ),
  logLevel: optional("LOG_LEVEL", "info"),
  dbPath: optional("DB_PATH", "./data/bowdy-bot.db"),
  timezone: optional("TZ", "America/Chicago"),
  googleServiceAccountKeyPath: process.env["GOOGLE_SERVICE_ACCOUNT_KEY_PATH"] ?? "",
  googleCalendarId: process.env["GOOGLE_CALENDAR_ID"] ?? "",
} as const;
