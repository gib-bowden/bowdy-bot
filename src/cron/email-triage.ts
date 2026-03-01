import { config } from "../config.js";
import { logger } from "../logger.js";
import { runEmailTriage } from "../modules/gmail/triage.js";
import { processTriageReplies } from "../modules/gmail/replies.js";

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

export async function runScheduledReplyProcessing(): Promise<void> {
  logger.info("Processing triage replies");

  const familyEmail = config.emailTriageFamilyAccount;
  if (!familyEmail) return;

  try {
    await processTriageReplies(familyEmail);
  } catch (err) {
    logger.error({ err }, "Scheduled reply processing failed");
  }
}
