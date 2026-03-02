import { eq, desc } from "drizzle-orm";
import { ulid } from "ulid";
import { getDb, schema } from "../../db/client.js";
import { logger } from "../../logger.js";
import {
  listUnreadMessages,
  archiveMessages,
  sendEmail,
  // markAsTriaged,
} from "./api.js";
import { classifyEmails, type ClassifiedEmail } from "./classify.js";

/**
 * Run triage for a single account: scan → classify → send summary email → save to DB.
 */
export async function runTriageForAccount(
  accountEmail: string,
  familyEmail: string,
): Promise<{ sessionId: string; emailCount: number } | null> {
  logger.info({ accountEmail }, "Running email triage");

  const db = getDb();

  // Find last successful session to determine "since" cutoff
  const lastSession = db
    .select()
    .from(schema.emailTriageSessions)
    .where(eq(schema.emailTriageSessions.accountEmail, accountEmail))
    .orderBy(desc(schema.emailTriageSessions.createdAt))
    .limit(1)
    .get();

  const since = lastSession?.createdAt ?? undefined;

  // Fetch unread emails
  const emails = await listUnreadMessages(accountEmail, since);
  if (emails.length === 0) {
    logger.info({ accountEmail }, "No new unread emails to triage");
    return null;
  }

  // Classify all emails
  const classified = await classifyEmails(emails, accountEmail);

  // Auto-archive emails classified as recommend_archive with a rule applied
  const autoArchiveIds = classified
    .filter((c) => c.ruleApplied && c.category === "recommend_archive")
    .map((c) => c.message.id);

  if (autoArchiveIds.length > 0) {
    try {
      await archiveMessages(accountEmail, autoArchiveIds);
      logger.info(
        { accountEmail, count: autoArchiveIds.length },
        "Auto-archived emails by rule",
      );
    } catch (err) {
      logger.error({ err }, "Failed to auto-archive emails");
    }
  }

  // Filter out auto-archived emails from the triage summary
  const autoArchivedSet = new Set(autoArchiveIds);
  const triageItems = classified.filter(
    (c) => !autoArchivedSet.has(c.message.id),
  );

  if (triageItems.length === 0) {
    logger.info(
      { accountEmail },
      "All emails auto-handled by rules, no triage email needed",
    );
    // Still save a session for tracking
    const sessionId = ulid();
    db.insert(schema.emailTriageSessions)
      .values({
        id: sessionId,
        accountEmail,
        status: "processed",
        emailCount: autoArchiveIds.length,
        processedAt: new Date().toISOString(),
      })
      .run();
    return { sessionId, emailCount: autoArchiveIds.length };
  }

  // Compose triage summary email
  const htmlBody = composeTriageEmail(
    triageItems,
    accountEmail,
    autoArchiveIds.length,
  );
  const subject = `📬 Email Triage: ${triageItems.length} email${triageItems.length === 1 ? "" : "s"} to review`;

  // Send from family account to personal account
  const sent = await sendEmail(familyEmail, accountEmail, subject, htmlBody);

  // Save session + items to DB
  const sessionId = ulid();
  db.insert(schema.emailTriageSessions)
    .values({
      id: sessionId,
      accountEmail,
      triageEmailThreadId: sent.threadId,
      triageEmailMessageId: sent.messageId,
      status: "sent",
      emailCount: classified.length,
    })
    .run();

  for (const item of classified) {
    db.insert(schema.emailTriageItems)
      .values({
        id: ulid(),
        sessionId,
        gmailMessageId: item.message.id,
        gmailThreadId: item.message.threadId,
        accountEmail,
        subject: item.message.subject,
        sender: item.message.sender,
        snippet: item.message.snippet,
        receivedAt: item.message.receivedAt,
        category: item.category,
        summary: item.summary,
        suggestedAction: item.suggestedAction,
        actionTaken: autoArchivedSet.has(item.message.id)
          ? "auto_archived"
          : null,
        status: autoArchivedSet.has(item.message.id) ? "actioned" : "pending",
      })
      .run();
  }

  // Mark all scanned messages as triaged so they're excluded from future scans
  // TODO: Remove after testing
  // const allMessageIds = classified.map((c) => c.message.id);
  // try {
  //   await markAsTriaged(accountEmail, allMessageIds);
  // } catch (err) {
  //   logger.error({ err, accountEmail }, "Failed to mark messages as triaged");
  // }

  logger.info(
    {
      accountEmail,
      sessionId,
      total: classified.length,
      autoArchived: autoArchiveIds.length,
      triaged: triageItems.length,
    },
    "Email triage complete, summary sent",
  );

  return { sessionId, emailCount: classified.length };
}

/**
 * Run triage for all configured accounts.
 */
export async function runEmailTriage(
  accounts: string[],
  familyEmail: string,
): Promise<void> {
  for (const accountEmail of accounts) {
    try {
      await runTriageForAccount(accountEmail, familyEmail);
    } catch (err) {
      logger.error({ err, accountEmail }, "Email triage failed for account");
    }
  }
}

function composeTriageEmail(
  items: ClassifiedEmail[],
  accountEmail: string,
  autoArchivedCount: number,
): string {
  const actionNeeded = items.filter((i) => i.category === "action_needed");
  const fyi = items.filter((i) => i.category === "fyi");
  const recommendArchive = items.filter(
    (i) => i.category === "recommend_archive",
  );
  const unknown = items.filter((i) => i.category === "unknown");

  const sections: string[] = [];

  sections.push(`
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
    <h2 style="color: #333;">Email Triage for ${accountEmail}</h2>
    <p style="color: #666;">Here's a summary of your unread emails. Reply to this email with actions you'd like to take.</p>
  `);

  if (autoArchivedCount > 0) {
    sections.push(
      `<p style="color: #888; font-size: 0.9em;">📦 ${autoArchivedCount} email${autoArchivedCount === 1 ? "" : "s"} auto-archived by your rules.</p>`,
    );
  }

  let itemNumber = 1;

  if (actionNeeded.length > 0) {
    sections.push('<h3 style="color: #d32f2f;">🔴 Action Needed</h3>');
    for (const item of actionNeeded) {
      sections.push(formatTriageItem(item, itemNumber++));
    }
  }

  if (fyi.length > 0) {
    sections.push('<h3 style="color: #1976d2;">🔵 FYI</h3>');
    for (const item of fyi) {
      sections.push(formatTriageItem(item, itemNumber++));
    }
  }

  if (recommendArchive.length > 0) {
    sections.push('<h3 style="color: #388e3c;">🟢 Recommend Archive</h3>');
    for (const item of recommendArchive) {
      sections.push(formatTriageItem(item, itemNumber++));
    }
  }

  if (unknown.length > 0) {
    sections.push('<h3 style="color: #666;">⚪ Uncategorized</h3>');
    for (const item of unknown) {
      sections.push(formatTriageItem(item, itemNumber++));
    }
  }

  sections.push(`
    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
    <h3>How to respond</h3>
    <p style="color: #666; font-size: 0.9em;">Reply with item numbers and actions, e.g.:</p>
    <pre style="background: #f5f5f5; padding: 10px; border-radius: 4px; font-size: 0.85em;">1 archive
2 calendar
3 task
4,5,6 archive
7 keep
8 unsubscribe
9 spam</pre>
    <p style="color: #666; font-size: 0.85em;">
      <strong>Actions:</strong> archive, calendar (create event), task (create todo), keep (leave as-is), unsubscribe, spam (trash + auto-archive rule)
    </p>
    </div>
  `);

  return sections.join("\n");
}

function formatTriageItem(item: ClassifiedEmail, number: number): string {
  const senderName = item.message.sender.replace(/<[^>]+>/, "").trim();
  return `
    <div style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">
      <strong style="color: #333;">${number}.</strong>
      <strong>${escapeHtml(senderName)}</strong><br>
      <span style="color: #333;">${escapeHtml(item.message.subject)}</span><br>
      <span style="color: #888; font-size: 0.9em;">${escapeHtml(item.summary)}</span>
    </div>
  `;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
