import { eq } from "drizzle-orm";
import { getDb, schema } from "../../db/client.js";
import { getClient } from "../../ai/client.js";
import { logger } from "../../logger.js";
import {
  getThreadReplies,
  archiveMessages,
  trashMessages,
  sendEmail,
  findUnsubscribeLinks,
} from "./api.js";
import { saveRule } from "./rules.js";

interface ParsedAction {
  itemNumber: number;
  action: string;
  extraText?: string;
}

/**
 * Process replies to triage emails — parse user actions and execute them.
 */
export async function processTriageReplies(familyEmail: string): Promise<void> {
  const db = getDb();

  // Find sessions awaiting replies
  const pendingSessions = db
    .select()
    .from(schema.emailTriageSessions)
    .where(eq(schema.emailTriageSessions.status, "sent"))
    .all();

  if (pendingSessions.length === 0) return;

  for (const session of pendingSessions) {
    if (!session.triageEmailThreadId || !session.triageEmailMessageId) continue;

    try {
      // Check for replies in the triage thread
      const replies = await getThreadReplies(
        session.accountEmail,
        session.triageEmailThreadId,
        session.triageEmailMessageId,
      );

      if (replies.length === 0) continue;

      // Use the latest reply
      const latestReply = replies[replies.length - 1]!;

      // Parse the reply into actions
      const actions = await parseReplyActions(latestReply.body);
      if (actions.length === 0) {
        logger.info({ sessionId: session.id }, "Reply found but no parseable actions");
        continue;
      }

      // Get triage items for this session
      const items = db
        .select()
        .from(schema.emailTriageItems)
        .where(eq(schema.emailTriageItems.sessionId, session.id))
        .all();

      // Filter to only pending items (not already actioned or auto-archived)
      const pendingItems = items.filter((i) => i.status === "pending");

      // Build numbered map (1-indexed, matching triage email order)
      // Order: action_needed first, then fyi, recommend_archive, unknown
      const categoryOrder = ["action_needed", "fyi", "recommend_archive", "unknown"];
      const sortedItems = pendingItems.sort((a, b) => {
        const aIdx = categoryOrder.indexOf(a.category ?? "unknown");
        const bIdx = categoryOrder.indexOf(b.category ?? "unknown");
        return aIdx - bIdx;
      });

      const results: string[] = [];
      let archived = 0;
      let calendared = 0;
      let tasked = 0;
      let trashed = 0;
      let unsubscribed = 0;
      let kept = 0;

      for (const action of actions) {
        const item = sortedItems[action.itemNumber - 1];
        if (!item) {
          results.push(`#${action.itemNumber}: Item not found`);
          continue;
        }

        try {
          switch (action.action) {
            case "archive": {
              await archiveMessages(session.accountEmail, [item.gmailMessageId]);
              db.update(schema.emailTriageItems)
                .set({ actionTaken: "archived", status: "actioned" })
                .where(eq(schema.emailTriageItems.id, item.id))
                .run();
              archived++;
              break;
            }

            case "calendar": {
              // Create calendar event from email context
              try {
                const { calendarModule } = await import("../calendar/index.js");
                const now = new Date();
                const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000);
                await calendarModule.executeTool("create_event", {
                  title: item.subject ?? "Event from email",
                  start: now.toISOString(),
                  end: oneHourLater.toISOString(),
                  description: `From: ${item.sender}\n\nCreated from email triage — update the time.`,
                });
                db.update(schema.emailTriageItems)
                  .set({ actionTaken: "calendar_event_created", status: "actioned" })
                  .where(eq(schema.emailTriageItems.id, item.id))
                  .run();
                calendared++;
              } catch (err) {
                logger.error({ err, itemId: item.id }, "Failed to create calendar event");
                results.push(`#${action.itemNumber}: Calendar creation failed — check email for details`);
              }
              break;
            }

            case "task": {
              try {
                const { googleTasksModule } = await import("../google-tasks/index.js");
                await googleTasksModule.executeTool("add_task", {
                  title: item.subject ?? "Task from email",
                });
                db.update(schema.emailTriageItems)
                  .set({ actionTaken: "task_created", status: "actioned" })
                  .where(eq(schema.emailTriageItems.id, item.id))
                  .run();
                tasked++;
              } catch (err) {
                logger.error({ err, itemId: item.id }, "Failed to create task");
                results.push(`#${action.itemNumber}: Task creation failed`);
              }
              break;
            }

            case "keep": {
              db.update(schema.emailTriageItems)
                .set({ actionTaken: "kept", status: "actioned" })
                .where(eq(schema.emailTriageItems.id, item.id))
                .run();
              kept++;
              break;
            }

            case "unsubscribe": {
              const links = await findUnsubscribeLinks(session.accountEmail, [item.gmailMessageId]);
              const unsubLinks = links.get(item.gmailMessageId) ?? [];

              // Create archive rule for the sender's domain
              const senderDomain = extractDomain(item.sender ?? "");
              if (senderDomain) {
                saveRule({
                  accountEmail: session.accountEmail,
                  matchType: "domain",
                  matchValue: senderDomain,
                  action: "archive",
                });
              }

              if (unsubLinks.length > 0) {
                results.push(
                  `#${action.itemNumber}: Unsubscribe link${unsubLinks.length > 1 ? "s" : ""}: ${unsubLinks.join(", ")}`,
                );
              } else {
                results.push(`#${action.itemNumber}: No unsubscribe link found — domain rule created to auto-archive future emails`);
              }

              await archiveMessages(session.accountEmail, [item.gmailMessageId]);
              db.update(schema.emailTriageItems)
                .set({ actionTaken: "unsubscribed", status: "actioned" })
                .where(eq(schema.emailTriageItems.id, item.id))
                .run();
              unsubscribed++;
              break;
            }

            case "spam": {
              await trashMessages(session.accountEmail, [item.gmailMessageId]);
              const senderDomain = extractDomain(item.sender ?? "");
              if (senderDomain) {
                saveRule({
                  accountEmail: session.accountEmail,
                  matchType: "domain",
                  matchValue: senderDomain,
                  action: "archive",
                });
              }
              db.update(schema.emailTriageItems)
                .set({ actionTaken: "trashed", status: "actioned" })
                .where(eq(schema.emailTriageItems.id, item.id))
                .run();
              trashed++;
              break;
            }

            default:
              results.push(`#${action.itemNumber}: Unknown action "${action.action}"`);
          }
        } catch (err) {
          logger.error({ err, itemId: item.id, action: action.action }, "Failed to execute triage action");
          results.push(`#${action.itemNumber}: Action "${action.action}" failed`);
        }
      }

      // Build confirmation summary
      const summaryParts: string[] = [];
      if (archived > 0) summaryParts.push(`archived ${archived}`);
      if (calendared > 0) summaryParts.push(`created ${calendared} calendar event${calendared > 1 ? "s" : ""}`);
      if (tasked > 0) summaryParts.push(`created ${tasked} task${tasked > 1 ? "s" : ""}`);
      if (trashed > 0) summaryParts.push(`trashed ${trashed}`);
      if (unsubscribed > 0) summaryParts.push(`unsubscribed from ${unsubscribed}`);
      if (kept > 0) summaryParts.push(`kept ${kept}`);

      const confirmationHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px;">
          <p>✅ Done! ${summaryParts.join(", ")}.</p>
          ${results.length > 0 ? `<p style="color: #666; font-size: 0.9em;">Notes:<br>${results.join("<br>")}</p>` : ""}
        </div>
      `;

      // Send confirmation reply in the triage thread
      await sendEmail(
        familyEmail,
        session.accountEmail,
        `Re: Email Triage Summary`,
        confirmationHtml,
        session.triageEmailThreadId,
      );

      // Update session status
      db.update(schema.emailTriageSessions)
        .set({ status: "processed", processedAt: new Date().toISOString() })
        .where(eq(schema.emailTriageSessions.id, session.id))
        .run();

      logger.info(
        { sessionId: session.id, actions: actions.length, summary: summaryParts.join(", ") },
        "Triage replies processed",
      );
    } catch (err) {
      logger.error({ err, sessionId: session.id }, "Failed to process triage replies");
    }
  }
}

/**
 * Parse a reply email body into structured actions using Claude Haiku.
 */
async function parseReplyActions(replyBody: string): Promise<ParsedAction[]> {
  // First try simple regex parsing for common patterns
  const simpleActions = parseSimpleReply(replyBody);
  if (simpleActions.length > 0) return simpleActions;

  // Fall back to Claude Haiku for complex replies
  const client = getClient();

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: `Parse this email triage reply into actions. The user is responding to a numbered list of emails with actions.

Valid actions: archive, calendar, task, keep, unsubscribe, spam

Reply text:
${replyBody.slice(0, 2000)}

Respond with ONLY a JSON array:
[{"itemNumber": 1, "action": "archive"}, {"itemNumber": 2, "action": "calendar"}]

If the reply doesn't contain any parseable actions, return an empty array [].`,
        },
      ],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    return JSON.parse(jsonMatch[0]) as ParsedAction[];
  } catch (err) {
    logger.error({ err }, "Failed to parse reply with Haiku");
    return [];
  }
}

/**
 * Simple regex-based reply parser for common formats like:
 * "1 archive", "2,3,4 archive", "1 calendar", etc.
 */
function parseSimpleReply(text: string): ParsedAction[] {
  const actions: ParsedAction[] = [];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    // Match: "1 archive", "2,3,4 archive", "1-5 archive"
    const match = line.match(/^([\d,\s-]+)\s+(archive|calendar|task|keep|unsubscribe|spam)$/i);
    if (!match) continue;

    const numbersStr = match[1]!;
    const action = match[2]!.toLowerCase();

    // Parse number ranges: "1,2,3" or "1-5" or "1, 3, 5"
    const numbers = parseNumberList(numbersStr);
    for (const num of numbers) {
      actions.push({ itemNumber: num, action });
    }
  }

  return actions;
}

function parseNumberList(str: string): number[] {
  const numbers: number[] = [];
  const parts = str.split(",").map((s) => s.trim());

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = parseInt(rangeMatch[2]!, 10);
      for (let i = start; i <= end; i++) numbers.push(i);
    } else {
      const num = parseInt(part, 10);
      if (!isNaN(num)) numbers.push(num);
    }
  }

  return numbers;
}

function extractDomain(sender: string): string {
  const emailMatch = sender.match(/<([^>]+)>/) ?? [null, sender];
  const emailAddr = emailMatch[1] ?? sender;
  return emailAddr.split("@")[1]?.toLowerCase() ?? "";
}
