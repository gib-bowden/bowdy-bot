import "dotenv/config";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

function resolveGoogleServiceAccountKeyPath(): string {
  const filePath = process.env["GOOGLE_SERVICE_ACCOUNT_KEY_PATH"] ?? "";
  if (filePath) return filePath;

  const base64Key = process.env["GOOGLE_SERVICE_ACCOUNT_KEY"] ?? "";
  if (!base64Key) return "";

  const tempDir = mkdtempSync(join(tmpdir(), "bowdy-bot-"));
  const tempPath = join(tempDir, "google-service-account.json");
  writeFileSync(tempPath, Buffer.from(base64Key, "base64"), "utf-8");
  return tempPath;
}

export const config = {
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  platform: optional("PLATFORM", "console") as
    | "console"
    | "telegram"
    | "twilio"
    | "groupme",
  telegramBotToken: process.env["TELEGRAM_BOT_TOKEN"] ?? "",
  twilioAccountSid: process.env["TWILIO_ACCOUNT_SID"] ?? "",
  twilioAuthToken: process.env["TWILIO_AUTH_TOKEN"] ?? "",
  twilioPhoneNumber: process.env["TWILIO_PHONE_NUMBER"] ?? "",
  twilioAllowlist: process.env["TWILIO_ALLOWLIST"] ?? "",
  twilioWebhookPort: optional("TWILIO_WEBHOOK_PORT", "3000"),
  groupmeBotId: process.env["GROUPME_BOT_ID"] ?? "",
  groupmeWebhookPort: optional("GROUPME_WEBHOOK_PORT", "3000"),
  logLevel: optional("LOG_LEVEL", "info"),
  dbPath: optional("DB_PATH", "./data/bowdy-bot.db"),
  timezone: optional("TZ", "America/Chicago"),
  googleServiceAccountKeyPath: resolveGoogleServiceAccountKeyPath(),
  googleCalendarId: process.env["GOOGLE_CALENDAR_ID"] ?? "",
  googleTasksEnabled:
    (process.env["GOOGLE_TASKS_ENABLED"] ?? "").toLowerCase() === "true",
} as const;
