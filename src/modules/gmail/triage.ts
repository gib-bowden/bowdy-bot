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

  // Compose triage summary email (with grouping)
  const { html: htmlBody, itemMap, displayIndices } = composeTriageEmail(
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
      triageItemMap: JSON.stringify(itemMap),
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
        displayIndex: displayIndices.get(item.message.id) ?? null,
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

/** A group of emails from the same sender within a category. */
interface EmailGroup {
  senderEmail: string;
  senderName: string;
  items: ClassifiedEmail[];
  identicalSubjects: boolean;
}

/** Result of composing the triage email with grouping info. */
interface TriageEmailResult {
  html: string;
  /** Map from display index ("1", "2", "4a", "4b") to gmail message IDs */
  itemMap: Record<string, string[]>;
  /** Map from gmail message ID to its display index */
  displayIndices: Map<string, string>;
}

function composeTriageEmail(
  items: ClassifiedEmail[],
  accountEmail: string,
  autoArchivedCount: number,
): TriageEmailResult {
  const categories: Array<{
    key: string;
    label: string;
    color: string;
    icon: string;
    items: ClassifiedEmail[];
  }> = [
    { key: "action_needed", label: "Action Needed", color: "#d32f2f", icon: "🔴", items: [] },
    { key: "fyi", label: "FYI", color: "#1976d2", icon: "🔵", items: [] },
    { key: "recommend_archive", label: "Recommend Archive", color: "#388e3c", icon: "🟢", items: [] },
    { key: "unknown", label: "Uncategorized", color: "#666", icon: "⚪", items: [] },
  ];

  for (const item of items) {
    const cat = categories.find((c) => c.key === item.category) ?? categories[3]!;
    cat.items.push(item);
  }

  const sections: string[] = [];
  const itemMap: Record<string, string[]> = {};
  const displayIndices = new Map<string, string>();

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

  let groupNumber = 1;

  for (const cat of categories) {
    if (cat.items.length === 0) continue;

    sections.push(`<h3 style="color: ${cat.color};">${cat.icon} ${cat.label}</h3>`);

    const groups = groupBySender(cat.items);

    for (const group of groups) {
      if (group.items.length === 1) {
        // Single item — render as before
        const item = group.items[0]!;
        const idx = String(groupNumber);
        sections.push(formatTriageItem(item, idx));
        itemMap[idx] = [item.message.id];
        displayIndices.set(item.message.id, idx);
      } else if (group.identicalSubjects) {
        // Multiple emails, same subject — collapsed single line
        const idx = String(groupNumber);
        const allIds = group.items.map((i) => i.message.id);
        sections.push(formatCollapsedGroup(group, idx));
        itemMap[idx] = allIds;
        for (const item of group.items) {
          displayIndices.set(item.message.id, idx);
        }
      } else {
        // Multiple emails, different subjects — sender header with sub-items
        const baseIdx = groupNumber;
        const allIds = group.items.map((i) => i.message.id);
        itemMap[String(baseIdx)] = allIds;
        const capped = group.items.slice(0, 10);
        const overflow = group.items.length - capped.length;

        sections.push(formatGroupHeader(group, String(baseIdx)));
        for (let j = 0; j < capped.length; j++) {
          const letter = String.fromCharCode(97 + j); // a, b, c, ...
          const subIdx = `${baseIdx}${letter}`;
          const item = capped[j]!;
          sections.push(formatGroupSubItem(item, subIdx));
          itemMap[subIdx] = [item.message.id];
          displayIndices.set(item.message.id, subIdx);
        }
        if (overflow > 0) {
          sections.push(
            `<div style="padding: 2px 0 8px 24px; color: #999; font-size: 0.85em;">...and ${overflow} more</div>`,
          );
          // Still map overflow items to the group number
          for (let j = capped.length; j < group.items.length; j++) {
            const letter = String.fromCharCode(97 + j);
            const subIdx = `${baseIdx}${letter}`;
            const item = group.items[j]!;
            itemMap[subIdx] = [item.message.id];
            displayIndices.set(item.message.id, subIdx);
          }
        }
      }
      groupNumber++;
    }
  }

  sections.push(`
    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
    <h3>How to respond</h3>
    <p style="color: #666; font-size: 0.9em;">Reply with item numbers and actions, e.g.:</p>
    <pre style="background: #f5f5f5; padding: 10px; border-radius: 4px; font-size: 0.85em;">1 archive
2 calendar
3 task
4 archive       (archives entire group)
4a,4c archive   (archives specific items in group)
7 keep
8 unsubscribe
9 spam</pre>
    <p style="color: #666; font-size: 0.85em;">
      <strong>Actions:</strong> archive, calendar (create event), task (create todo), keep (leave as-is), unsubscribe, spam (trash + auto-archive rule)<br>
      <strong>Groups:</strong> Use the number alone (e.g. "4 archive") to act on all emails in a group, or letter suffixes (e.g. "4a archive") for individual items.
    </p>
    </div>
  `);

  return { html: sections.join("\n"), itemMap, displayIndices };
}

/** Group classified emails by normalized sender email address. */
function groupBySender(items: ClassifiedEmail[]): EmailGroup[] {
  const groups = new Map<string, EmailGroup>();
  const order: string[] = [];

  for (const item of items) {
    const email = extractEmailAddress(item.message.sender);
    const existing = groups.get(email);
    if (existing) {
      existing.items.push(item);
    } else {
      const senderName = item.message.sender.replace(/<[^>]+>/, "").trim();
      const group: EmailGroup = {
        senderEmail: email,
        senderName,
        items: [item],
        identicalSubjects: true,
      };
      groups.set(email, group);
      order.push(email);
    }
  }

  // Determine if subjects are identical within each group
  for (const group of groups.values()) {
    if (group.items.length > 1) {
      const normalized = group.items.map((i) => normalizeSubject(i.message.subject));
      group.identicalSubjects = normalized.every((s) => s === normalized[0]);
    }
  }

  return order.map((email) => groups.get(email)!);
}

/** Extract bare email address from "Name <email@example.com>" format. */
function extractEmailAddress(sender: string): string {
  const match = sender.match(/<([^>]+)>/);
  return (match?.[1] ?? sender).toLowerCase().trim();
}

/** Normalize subject for comparison (strip Re:/Fwd: prefixes, whitespace). */
function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(re|fwd?|fw):\s*/gi, "")
    .trim()
    .toLowerCase();
}

function formatTriageItem(item: ClassifiedEmail, index: string): string {
  const senderName = item.message.sender.replace(/<[^>]+>/, "").trim();
  return `
    <div style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">
      <strong style="color: #333;">${index}.</strong>
      <strong>${escapeHtml(senderName)}</strong><br>
      <a href="${gmailLink(item.message.threadId)}" target="_blank" style="color: #333; text-decoration: none;">${escapeHtml(item.message.subject)}</a><br>
      <span style="color: #888; font-size: 0.9em;">${escapeHtml(item.summary)}</span>
    </div>
  `;
}

function formatCollapsedGroup(group: EmailGroup, index: string): string {
  const item = group.items[0]!;
  return `
    <div style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">
      <strong style="color: #333;">${index}.</strong>
      <strong>${escapeHtml(group.senderName)}</strong>
      <span style="background: #e0e0e0; border-radius: 8px; padding: 1px 6px; font-size: 0.8em; color: #555;">${group.items.length} emails</span><br>
      <a href="${gmailLink(item.message.threadId)}" target="_blank" style="color: #333; text-decoration: none;">${escapeHtml(item.message.subject)}</a><br>
      <span style="color: #888; font-size: 0.9em;">${escapeHtml(item.summary)}</span>
    </div>
  `;
}

function formatGroupHeader(group: EmailGroup, index: string): string {
  return `
    <div style="padding: 8px 0 2px 0;">
      <strong style="color: #333;">${index}.</strong>
      <strong>${escapeHtml(group.senderName)}</strong>
      <span style="background: #e0e0e0; border-radius: 8px; padding: 1px 6px; font-size: 0.8em; color: #555;">${group.items.length} emails</span>
    </div>
  `;
}

function formatGroupSubItem(item: ClassifiedEmail, index: string): string {
  return `
    <div style="padding: 2px 0; padding-left: 24px; border-bottom: 1px solid #f8f8f8;">
      <strong style="color: #555; font-size: 0.9em;">${index}.</strong>
      <a href="${gmailLink(item.message.threadId)}" target="_blank" style="color: #333; text-decoration: none;">${escapeHtml(item.message.subject)}</a><br>
      <span style="color: #888; font-size: 0.85em; padding-left: 8px;">${escapeHtml(item.summary)}</span>
    </div>
  `;
}

function gmailLink(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#inbox/${threadId}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
