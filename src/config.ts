import { config as loadDotenv } from "node:process";

// Load .env file if present (Node 22+ has built-in .env support via --env-file,
// but we read process.env directly for simplicity)
try {
  const { readFileSync } = await import("node:fs");
  const envContent = readFileSync(".env", "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // .env file not found, rely on environment variables
}

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
  platform: optional("PLATFORM", "console") as "console" | "telegram",
  telegramBotToken: process.env["TELEGRAM_BOT_TOKEN"] ?? "",
  logLevel: optional("LOG_LEVEL", "info"),
  dbPath: optional("DB_PATH", "./data/bowdy-bot.db"),
} as const;
