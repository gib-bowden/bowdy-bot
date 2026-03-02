import { getGmailClient } from "./client.js";
import { logger } from "../../logger.js";

export interface EmailMessage {
  id: string;
  threadId: string;
  subject: string;
  sender: string;
  snippet: string;
  receivedAt: string;
  labelIds: string[];
}

export interface EmailContent {
  id: string;
  threadId: string;
  subject: string;
  sender: string;
  body: string;
  receivedAt: string;
}

/**
 * List unread messages in the inbox since a given date.
 */
const MAX_TRIAGE_MESSAGES = 50;

export async function listUnreadMessages(
  email: string,
  since?: string,
  maxMessages: number = MAX_TRIAGE_MESSAGES,
): Promise<EmailMessage[]> {
  const gmail = await getGmailClient(email);

  let query = "is:unread in:inbox -label:BowdyBot-Triaged";
  if (since) {
    // Gmail search uses YYYY/MM/DD format
    const sinceDate = new Date(since);
    const formatted = `${sinceDate.getFullYear()}/${String(sinceDate.getMonth() + 1).padStart(2, "0")}/${String(sinceDate.getDate()).padStart(2, "0")}`;
    query += ` after:${formatted}`;
  }

  const messages: EmailMessage[] = [];
  let pageToken: string | undefined;

  do {
    const pageSize = Math.min(100, maxMessages - messages.length);
    const response = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: pageSize,
      pageToken,
    });

    const messageIds = response.data.messages || [];
    pageToken = response.data.nextPageToken ?? undefined;

    // Fetch metadata for each message
    for (const msg of messageIds) {
      if (!msg.id) continue;
      if (messages.length >= maxMessages) break;
      try {
        const detail = await gmail.users.messages.get({
          userId: "me",
          id: msg.id,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"],
        });

        const headers = detail.data.payload?.headers || [];
        const getHeader = (name: string) =>
          headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

        messages.push({
          id: detail.data.id!,
          threadId: detail.data.threadId!,
          subject: getHeader("Subject"),
          sender: getHeader("From"),
          snippet: detail.data.snippet ?? "",
          receivedAt: getHeader("Date"),
          labelIds: detail.data.labelIds ?? [],
        });
      } catch (err) {
        logger.warn({ err, messageId: msg.id }, "Failed to fetch message metadata");
      }
    }
  } while (pageToken && messages.length < maxMessages);

  return messages;
}

/**
 * Get full message content (text body extracted from HTML or plain text parts).
 */
export async function getMessageContent(
  email: string,
  messageId: string,
): Promise<EmailContent> {
  const gmail = await getGmailClient(email);
  const response = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = response.data.payload?.headers || [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

  const body = extractTextBody(response.data.payload);

  return {
    id: response.data.id!,
    threadId: response.data.threadId!,
    subject: getHeader("Subject"),
    sender: getHeader("From"),
    body,
    receivedAt: getHeader("Date"),
  };
}

/**
 * Archive messages by removing the INBOX label.
 */
export async function archiveMessages(
  email: string,
  messageIds: string[],
): Promise<void> {
  const gmail = await getGmailClient(email);
  await Promise.all(
    messageIds.map((id) =>
      gmail.users.messages.modify({
        userId: "me",
        id,
        requestBody: { removeLabelIds: ["INBOX"] },
      }),
    ),
  );
}

/**
 * Trash messages.
 */
export async function trashMessages(
  email: string,
  messageIds: string[],
): Promise<void> {
  const gmail = await getGmailClient(email);
  await Promise.all(
    messageIds.map((id) => gmail.users.messages.trash({ userId: "me", id })),
  );
}

/**
 * Send an email via Gmail API.
 */
export async function sendEmail(
  fromEmail: string,
  to: string,
  subject: string,
  htmlBody: string,
  threadId?: string,
): Promise<{ messageId: string; threadId: string }> {
  const gmail = await getGmailClient(fromEmail);

  const messageParts = [
    `From: ${fromEmail}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    "Content-Type: text/html; charset=utf-8",
    "",
    htmlBody,
  ];

  // If replying in a thread, add References/In-Reply-To headers
  if (threadId) {
    messageParts.splice(3, 0, `In-Reply-To: ${threadId}`, `References: ${threadId}`);
  }

  const raw = Buffer.from(messageParts.join("\r\n")).toString("base64url");

  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId },
  });

  return {
    messageId: response.data.id!,
    threadId: response.data.threadId!,
  };
}

/**
 * Get new replies in a thread after a specific message.
 */
export async function getThreadReplies(
  email: string,
  threadId: string,
  afterMessageId: string,
): Promise<EmailContent[]> {
  const gmail = await getGmailClient(email);
  const response = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });

  const messages = response.data.messages || [];
  const replies: EmailContent[] = [];
  let foundAfter = false;

  for (const msg of messages) {
    if (msg.id === afterMessageId) {
      foundAfter = true;
      continue;
    }
    if (!foundAfter || !msg.id) continue;

    const headers = msg.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

    replies.push({
      id: msg.id,
      threadId: msg.threadId!,
      subject: getHeader("Subject"),
      sender: getHeader("From"),
      body: extractTextBody(msg.payload),
      receivedAt: getHeader("Date"),
    });
  }

  return replies;
}

/**
 * List all labels for an account.
 */
export async function listLabels(
  email: string,
): Promise<Array<{ id: string; name: string }>> {
  const gmail = await getGmailClient(email);
  const response = await gmail.users.labels.list({ userId: "me" });
  return (response.data.labels || [])
    .filter((l) => l.id && l.name)
    .map((l) => ({ id: l.id!, name: l.name! }));
}

/**
 * Create a label.
 */
export async function createLabel(
  email: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const gmail = await getGmailClient(email);
  const response = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  return { id: response.data.id!, name: response.data.name! };
}

const TRIAGED_LABEL_NAME = "BowdyBot-Triaged";
const triagedLabelCache = new Map<string, string>();

/**
 * Get or create the BowdyBot-Triaged label for an account. Cached per account.
 */
async function getTriagedLabelId(email: string): Promise<string> {
  const cached = triagedLabelCache.get(email);
  if (cached) return cached;

  const labels = await listLabels(email);
  const existing = labels.find((l) => l.name === TRIAGED_LABEL_NAME);
  if (existing) {
    triagedLabelCache.set(email, existing.id);
    return existing.id;
  }

  const created = await createLabel(email, TRIAGED_LABEL_NAME);
  triagedLabelCache.set(email, created.id);
  return created.id;
}

/**
 * Mark messages as triaged by applying the BowdyBot-Triaged label.
 */
export async function markAsTriaged(
  email: string,
  messageIds: string[],
): Promise<void> {
  const labelId = await getTriagedLabelId(email);
  await Promise.all(messageIds.map((id) => modifyLabels(email, id, [labelId], [])));
}

/**
 * Add/remove labels from a message.
 */
export async function modifyLabels(
  email: string,
  messageId: string,
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<void> {
  const gmail = await getGmailClient(email);
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { addLabelIds, removeLabelIds },
  });
}

/**
 * Find unsubscribe links from email headers and body.
 */
export async function findUnsubscribeLinks(
  email: string,
  messageIds: string[],
): Promise<Map<string, string[]>> {
  const gmail = await getGmailClient(email);
  const results = new Map<string, string[]>();

  for (const id of messageIds) {
    const response = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["List-Unsubscribe"],
    });

    const headers = response.data.payload?.headers || [];
    const unsubHeader = headers.find(
      (h) => h.name?.toLowerCase() === "list-unsubscribe",
    )?.value;

    const links: string[] = [];
    if (unsubHeader) {
      // Extract URLs from the List-Unsubscribe header (format: <url>, <mailto:...>)
      const urlMatches = unsubHeader.match(/https?:\/\/[^>,\s]+/g);
      if (urlMatches) links.push(...urlMatches);
    }

    results.set(id, links);
  }

  return results;
}

// --- Helpers ---

function extractTextBody(
  payload: { mimeType?: string | null; body?: { data?: string | null } | null; parts?: unknown[] | null } | null | undefined,
): string {
  if (!payload) return "";

  // Single-part message
  if (payload.body?.data && payload.mimeType === "text/plain") {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  // Multipart — look for text/plain first, then text/html
  const parts = (payload.parts || []) as Array<{
    mimeType?: string | null;
    body?: { data?: string | null } | null;
    parts?: unknown[] | null;
  }>;

  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return Buffer.from(part.body.data, "base64url").toString("utf-8");
    }
  }

  for (const part of parts) {
    if (part.mimeType === "text/html" && part.body?.data) {
      const html = Buffer.from(part.body.data, "base64url").toString("utf-8");
      return stripHtml(html);
    }
    // Recurse into nested multipart
    if (part.parts) {
      const nested = extractTextBody(part as typeof payload);
      if (nested) return nested;
    }
  }

  // Fallback: if payload itself is HTML
  if (payload.body?.data && payload.mimeType === "text/html") {
    const html = Buffer.from(payload.body.data, "base64url").toString("utf-8");
    return stripHtml(html);
  }

  return "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
