import { eq } from "drizzle-orm";
import { getDb, schema } from "../../db/client.js";
import { getClient } from "../../ai/client.js";
import { logger } from "../../logger.js";
import {
  getThreadReplies,
  sendEmail,
} from "./api.js";
import { executeTriageAction } from "./actions.js";

export interface ParsedAction {
  itemRef: string; // "1", "4", "4a", etc.
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

      const results: string[] = [];
      let archived = 0;
      let calendared = 0;
      let tasked = 0;
      let trashed = 0;
      let unsubscribed = 0;
      let kept = 0;

      for (const action of actions) {
        // Calendar and task still handled inline (need extra module imports)
        if (action.action === "calendar" || action.action === "task") {
          const items = db
            .select()
            .from(schema.emailTriageItems)
            .where(eq(schema.emailTriageItems.sessionId, session.id))
            .all();
          const triageItemMap: Record<string, string[]> | null = session.triageItemMap
            ? JSON.parse(session.triageItemMap)
            : null;
          const itemsByMsgId = new Map(items.map((i) => [i.gmailMessageId, i]));

          let targetMsgIds: string[] | undefined;
          if (triageItemMap) {
            targetMsgIds = triageItemMap[action.itemRef];
          } else {
            const pendingItems = items.filter((i) => i.status === "pending");
            const categoryOrder = ["action_needed", "fyi", "recommend_archive", "unknown"];
            const sorted = pendingItems.sort((a, b) => {
              const aIdx = categoryOrder.indexOf(a.category ?? "unknown");
              const bIdx = categoryOrder.indexOf(b.category ?? "unknown");
              return aIdx - bIdx;
            });
            const num = parseInt(action.itemRef, 10);
            const item = sorted[num - 1];
            targetMsgIds = item ? [item.gmailMessageId] : undefined;
          }

          if (!targetMsgIds || targetMsgIds.length === 0) {
            results.push(`#${action.itemRef}: Item not found`);
            continue;
          }

          const targetItems = targetMsgIds
            .map((id) => itemsByMsgId.get(id))
            .filter((i): i is NonNullable<typeof i> => i != null && i.status === "pending");

          if (targetItems.length === 0) {
            results.push(`#${action.itemRef}: Already actioned or not found`);
            continue;
          }

          const item = targetItems[0]!;

          if (action.action === "calendar") {
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
              for (const ti of targetItems) {
                db.update(schema.emailTriageItems)
                  .set({ actionTaken: "calendar_event_created", status: "actioned" })
                  .where(eq(schema.emailTriageItems.id, ti.id))
                  .run();
              }
              calendared++;
            } catch (err) {
              logger.error({ err, itemId: item.id }, "Failed to create calendar event");
              results.push(`#${action.itemRef}: Calendar creation failed — check email for details`);
            }
          } else {
            try {
              const { googleTasksModule } = await import("../google-tasks/index.js");
              await googleTasksModule.executeTool("add_task", {
                title: item.subject ?? "Task from email",
              });
              for (const ti of targetItems) {
                db.update(schema.emailTriageItems)
                  .set({ actionTaken: "task_created", status: "actioned" })
                  .where(eq(schema.emailTriageItems.id, ti.id))
                  .run();
              }
              tasked++;
            } catch (err) {
              logger.error({ err, itemId: item.id }, "Failed to create task");
              results.push(`#${action.itemRef}: Task creation failed`);
            }
          }
          continue;
        }

        // All other actions use the shared executor
        const result = await executeTriageAction(session.id, session.accountEmail, action.itemRef, action.action);
        if (!result.success) {
          results.push(`#${action.itemRef}: ${result.message}`);
        } else if (!result.alreadyHandled) {
          switch (action.action) {
            case "archive": archived++; break;
            case "keep": kept++; break;
            case "unsubscribe": unsubscribed++; break;
            case "spam": trashed++; break;
          }
          if (result.message.includes("Unsubscribe link:")) {
            results.push(`#${action.itemRef}: ${result.message}`);
          }
        } else {
          results.push(`#${action.itemRef}: ${result.message}`);
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
Items can be plain numbers (e.g. "1", "4") or have letter suffixes for sub-items in a group (e.g. "4a", "4c").
Using a plain number on a group acts on all items in that group.

Valid actions: archive, calendar, task, keep, unsubscribe, spam

Reply text:
${replyBody.slice(0, 2000)}

Respond with ONLY a JSON array:
[{"itemRef": "1", "action": "archive"}, {"itemRef": "4a", "action": "calendar"}]

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
 * "1 archive", "2,3,4 archive", "4a,4c archive", etc.
 */
export function parseSimpleReply(text: string): ParsedAction[] {
  const actions: ParsedAction[] = [];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    // Match: "1 archive", "2,3,4 archive", "4a,4c archive", "1-5 archive"
    const match = line.match(/^(\d+[a-z]?(?:\s*[,\-]\s*\d+[a-z]?)*)\s+(archive|calendar|task|keep|unsubscribe|spam)$/i);
    if (!match) continue;

    const refsStr = match[1]!;
    const action = match[2]!.toLowerCase();

    const refs = parseItemReferences(refsStr);
    for (const ref of refs) {
      actions.push({ itemRef: ref, action });
    }
  }

  return actions;
}

/** Parse item references like "1", "4a", "2-5", "4a,4c" into individual refs. */
export function parseItemReferences(str: string): string[] {
  const refs: string[] = [];
  const parts = str.split(",").map((s) => s.trim());

  for (const part of parts) {
    // Range of plain numbers: "2-5"
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = parseInt(rangeMatch[2]!, 10);
      for (let i = start; i <= end; i++) refs.push(String(i));
    } else if (/^\d+[a-z]?$/i.test(part)) {
      // Single ref: "1", "4a", "4b"
      refs.push(part.toLowerCase());
    }
  }

  return refs;
}

