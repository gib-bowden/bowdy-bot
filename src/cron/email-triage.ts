import { config } from "../config.js";
import { logger } from "../logger.js";
import { runEmailTriage } from "../modules/gmail/triage.js";

export async function runScheduledTriage(): Promise<void> {
  logger.info("Running scheduled email triage");

  const accounts = config.emailTriageAccounts
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  const familyEmail = config.emailTriageFamilyAccount;

  if (accounts.length === 0 || !familyEmail) {
    logger.warn("Email triage accounts or family account not configured");
    return;
  }

  try {
    await runEmailTriage(accounts, familyEmail);
  } catch (err) {
    logger.error({ err }, "Scheduled email triage failed");
  }
}
