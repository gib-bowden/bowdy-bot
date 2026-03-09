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
  get anthropicApiKey(): string {
    return required("ANTHROPIC_API_KEY");
  },
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
  groupmeBotUserId: process.env["GROUPME_BOT_USER_ID"] ?? "",
  groupmeWebhookPort: optional("GROUPME_WEBHOOK_PORT", "3000"),
  logLevel: optional("LOG_LEVEL", "info"),
  dbPath: optional("DB_PATH", "./data/bowdy-bot.db"),
  timezone: optional("TZ", "America/Chicago"),
  googleClientId: process.env["GOOGLE_CLIENT_ID"] ?? "",
  googleClientSecret: process.env["GOOGLE_CLIENT_SECRET"] ?? "",
  googleOAuthRedirectUri: optional(
    "GOOGLE_OAUTH_REDIRECT_URI",
    "http://localhost:3001/oauth/callback",
  ),
  googleOAuthPort: optional("GOOGLE_OAUTH_PORT", "3001"),
  googleCalendarId: process.env["GOOGLE_CALENDAR_ID"] ?? "",
  googleTokenEncryptionKey: process.env["GOOGLE_TOKEN_ENCRYPTION_KEY"] ?? "",
  tokenEncryptionKey:
    process.env["TOKEN_ENCRYPTION_KEY"] ??
    process.env["GOOGLE_TOKEN_ENCRYPTION_KEY"] ??
    "",
  krogerClientId: process.env["KROGER_CLIENT_ID"] ?? "",
  krogerClientSecret: process.env["KROGER_CLIENT_SECRET"] ?? "",
  krogerOAuthRedirectUri: optional(
    "KROGER_OAUTH_REDIRECT_URI",
    "http://localhost:3001/kroger/callback",
  ),
  enableMorningBriefing: optional("ENABLE_MORNING_BRIEFING", "true") === "true",
  morningBriefingHour: optional("MORNING_BRIEFING_HOUR", "8"),
  enableEmailTriage: optional("ENABLE_EMAIL_TRIAGE", "false") === "true",
  emailTriageAccounts: process.env["EMAIL_TRIAGE_ACCOUNTS"] ?? "",
  emailTriageFamilyAccount: process.env["EMAIL_TRIAGE_FAMILY_ACCOUNT"] ?? "",
  emailTriageMorningHour: optional("EMAIL_TRIAGE_MORNING_HOUR", "8"),
  emailTriageEveningHour: optional("EMAIL_TRIAGE_EVENING_HOUR", "18"),
  publicUrl: process.env["PUBLIC_URL"] ?? "",
} as const;
