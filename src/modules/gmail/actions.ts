import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../../db/client.js";
import { logger } from "../../logger.js";
import {
  archiveMessages,
  trashMessages,
  findUnsubscribeLinks,
} from "./api.js";
import { saveRule } from "./rules.js";

/** Valid one-click actions (calendar/task excluded — they need extra info). */
export const ONE_CLICK_ACTIONS = ["archive", "keep", "unsubscribe", "spam"] as const;
export type OneClickAction = (typeof ONE_CLICK_ACTIONS)[number];

/** Actions available per triage category. */
const CATEGORY_ACTIONS: Record<string, OneClickAction[]> = {
  action_needed: ["archive", "keep"],
  fyi: ["archive", "keep"],
  recommend_archive: ["archive", "keep", "unsubscribe"],
  unknown: ["archive", "keep"],
};

export function getActionsForCategory(category: string): OneClickAction[] {
  return CATEGORY_ACTIONS[category] ?? CATEGORY_ACTIONS["unknown"]!;
}

export function isValidAction(action: string): action is OneClickAction {
  return (ONE_CLICK_ACTIONS as readonly string[]).includes(action);
}

/**
 * Generate an HMAC signature for a triage action URL.
 * Signs: sessionId + itemRef + action
 */
export function generateActionHmac(
  secret: string,
  sessionId: string,
  itemRef: string,
  action: string,
): string {
  return createHmac("sha256", secret)
    .update(`${sessionId}:${itemRef}:${action}`)
    .digest("hex")
    .slice(0, 16); // 16 hex chars = 64 bits, sufficient for URL tokens
}

/**
 * Verify an HMAC signature for a triage action URL.
 */
export function verifyActionHmac(
  secret: string,
  sessionId: string,
  itemRef: string,
  action: string,
  hmac: string,
): boolean {
  const expected = generateActionHmac(secret, sessionId, itemRef, action);
  // Constant-time comparison
  if (expected.length !== hmac.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ hmac.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Generate a full action URL for a triage item.
 */
export function generateActionUrl(
  publicUrl: string,
  secret: string,
  sessionId: string,
  itemRef: string,
  action: string,
): string {
  const hmac = generateActionHmac(secret, sessionId, itemRef, action);
  const params = new URLSearchParams({
    session: sessionId,
    item: itemRef,
    action,
    sig: hmac,
  });
  return `${publicUrl}/triage/action?${params.toString()}`;
}

export interface ActionResult {
  success: boolean;
  message: string;
  alreadyHandled?: boolean;
}

/**
 * Execute a triage action for a single item reference.
 * Shared by both the reply processor (replies.ts) and the webhook handler (action-handler.ts).
 */
export async function executeTriageAction(
  sessionId: string,
  accountEmail: string,
  itemRef: string,
  action: string,
): Promise<ActionResult> {
  const db = getDb();

  // Load session
  const session = db
    .select()
    .from(schema.emailTriageSessions)
    .where(eq(schema.emailTriageSessions.id, sessionId))
    .get();

  if (!session) {
    return { success: false, message: "Session not found" };
  }

  // Resolve item ref to message IDs via triageItemMap
  const triageItemMap: Record<string, string[]> | null = session.triageItemMap
    ? JSON.parse(session.triageItemMap)
    : null;

  if (!triageItemMap) {
    return { success: false, message: "Session has no item map" };
  }

  const targetMsgIds = triageItemMap[itemRef];
  if (!targetMsgIds || targetMsgIds.length === 0) {
    return { success: false, message: `Item #${itemRef} not found` };
  }

  // Load triage items from DB
  const items = db
    .select()
    .from(schema.emailTriageItems)
    .where(eq(schema.emailTriageItems.sessionId, sessionId))
    .all();

  const itemsByMsgId = new Map(items.map((i) => [i.gmailMessageId, i]));
  const targetItems = targetMsgIds
    .map((id) => itemsByMsgId.get(id))
    .filter((i): i is NonNullable<typeof i> => i != null);

  if (targetItems.length === 0) {
    return { success: false, message: `Item #${itemRef} not found in database` };
  }

  // Check if already actioned
  const pendingItems = targetItems.filter((i) => i.status === "pending");
  if (pendingItems.length === 0) {
    const firstItem = targetItems[0]!;
    return {
      success: true,
      alreadyHandled: true,
      message: `Already handled: "${firstItem.subject ?? "Unknown subject"}"`,
    };
  }

  const firstItem = pendingItems[0]!;
  const subjectLabel = firstItem.subject ?? "Unknown subject";

  try {
    switch (action) {
      case "archive": {
        const msgIds = pendingItems.map((i) => i.gmailMessageId);
        await archiveMessages(accountEmail, msgIds);
        for (const ti of pendingItems) {
          db.update(schema.emailTriageItems)
            .set({ actionTaken: "archived", status: "actioned" })
            .where(eq(schema.emailTriageItems.id, ti.id))
            .run();
        }
        return { success: true, message: `Archived "${subjectLabel}"${pendingItems.length > 1 ? ` (${pendingItems.length} emails)` : ""}` };
      }

      case "keep": {
        for (const ti of pendingItems) {
          db.update(schema.emailTriageItems)
            .set({ actionTaken: "kept", status: "actioned" })
            .where(eq(schema.emailTriageItems.id, ti.id))
            .run();
        }
        return { success: true, message: `Kept "${subjectLabel}"${pendingItems.length > 1 ? ` (${pendingItems.length} emails)` : ""}` };
      }

      case "unsubscribe": {
        const msgIds = pendingItems.map((i) => i.gmailMessageId);
        const links = await findUnsubscribeLinks(accountEmail, msgIds);
        const allUnsubLinks: string[] = [];
        for (const msgId of msgIds) {
          const l = links.get(msgId) ?? [];
          allUnsubLinks.push(...l);
        }

        const senderDomain = extractDomain(firstItem.sender ?? "");
        if (senderDomain) {
          saveRule({
            accountEmail,
            matchType: "domain",
            matchValue: senderDomain,
            action: "archive",
          });
        }

        await archiveMessages(accountEmail, msgIds);
        for (const ti of pendingItems) {
          db.update(schema.emailTriageItems)
            .set({ actionTaken: "unsubscribed", status: "actioned" })
            .where(eq(schema.emailTriageItems.id, ti.id))
            .run();
        }

        const linkInfo = allUnsubLinks.length > 0
          ? ` Unsubscribe link: ${[...new Set(allUnsubLinks)][0]}`
          : " Domain rule created to auto-archive future emails.";
        return { success: true, message: `Unsubscribed from "${subjectLabel}".${linkInfo}` };
      }

      case "spam": {
        const msgIds = pendingItems.map((i) => i.gmailMessageId);
        await trashMessages(accountEmail, msgIds);
        const senderDomain = extractDomain(firstItem.sender ?? "");
        if (senderDomain) {
          saveRule({
            accountEmail,
            matchType: "domain",
            matchValue: senderDomain,
            action: "archive",
          });
        }
        for (const ti of pendingItems) {
          db.update(schema.emailTriageItems)
            .set({ actionTaken: "trashed", status: "actioned" })
            .where(eq(schema.emailTriageItems.id, ti.id))
            .run();
        }
        return { success: true, message: `Trashed "${subjectLabel}" and created auto-archive rule` };
      }

      default:
        return { success: false, message: `Unknown action: "${action}"` };
    }
  } catch (err) {
    logger.error({ err, sessionId, itemRef, action }, "Failed to execute triage action");
    return { success: false, message: `Action "${action}" failed: ${(err as Error).message}` };
  }
}

function extractDomain(sender: string): string {
  const emailMatch = sender.match(/<([^>]+)>/) ?? [null, sender];
  const emailAddr = emailMatch[1] ?? sender;
  return emailAddr.split("@")[1]?.toLowerCase() ?? "";
}
