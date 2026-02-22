import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { IncomingMessage, Platform, MessageHandler } from "./types.js";

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 2000;
const MAX_MESSAGE_LENGTH = 8000;
const SPLIT_DELAY_MS = 500;

interface RawMessage {
  rowid: number;
  text: string | null;
  attributedBody: Buffer | null;
  handle_id: string;
  chat_identifier: string;
  is_group: number;
}

/**
 * Extract text from an NSKeyedArchiver attributedBody blob.
 * On macOS Ventura+, message.text is often empty and the real text
 * lives in attributedBody. The text is preceded by a 0x01 0x2B marker
 * followed by a variable-length size, then raw UTF-8 bytes.
 */
function extractTextFromAttributedBody(blob: Buffer): string | null {
  // Look for the marker sequence: 0x01 followed by 0x2B (+)
  for (let i = 0; i < blob.length - 2; i++) {
    if (blob[i] === 0x01 && blob[i + 1] === 0x2b) {
      // Next byte(s) encode the length
      const lengthByte = blob[i + 2]!;
      let textLength: number;
      let textStart: number;

      if (lengthByte < 0x80) {
        // Single-byte length
        textLength = lengthByte;
        textStart = i + 3;
      } else {
        // Multi-byte length: first byte & 0x7f = number of following length bytes
        const numLengthBytes = lengthByte & 0x7f;
        textLength = 0;
        for (let j = 0; j < numLengthBytes; j++) {
          textLength |= (blob[i + 3 + j] ?? 0) << (8 * j);
        }
        textStart = i + 3 + numLengthBytes;
      }

      if (textStart + textLength <= blob.length && textLength > 0) {
        const text = blob.subarray(textStart, textStart + textLength).toString("utf-8");
        // Sanity check: should be printable text
        if (text.length > 0 && !/[\x00-\x08\x0e-\x1f]/.test(text)) {
          return text;
        }
      }
    }
  }
  return null;
}

function getMessageText(row: RawMessage): string | null {
  if (row.text && row.text.trim().length > 0) {
    return row.text.trim();
  }
  if (row.attributedBody) {
    return extractTextFromAttributedBody(row.attributedBody);
  }
  return null;
}

/**
 * Split a long message on paragraph or sentence boundaries.
 */
function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_MESSAGE_LENGTH) {
    let splitIdx = remaining.lastIndexOf("\n\n", MAX_MESSAGE_LENGTH);
    if (splitIdx < MAX_MESSAGE_LENGTH / 2) {
      splitIdx = remaining.lastIndexOf(". ", MAX_MESSAGE_LENGTH);
      if (splitIdx > 0) splitIdx += 1; // include the period
    }
    if (splitIdx < MAX_MESSAGE_LENGTH / 2) {
      splitIdx = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
    }
    if (splitIdx < MAX_MESSAGE_LENGTH / 2) {
      splitIdx = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function sendIMessage(
  text: string,
  chatIdentifier: string,
  isGroup: boolean,
): Promise<void> {
  const escaped = escapeAppleScript(text);
  let script: string;

  if (isGroup) {
    script = `tell application "Messages" to send "${escaped}" to chat id "${chatIdentifier}"`;
  } else {
    script = `tell application "Messages" to send "${escaped}" to participant "${chatIdentifier}" of account 1`;
  }

  try {
    await execFileAsync("osascript", ["-e", script]);
  } catch (err) {
    logger.error({ err, chatIdentifier, isGroup }, "Failed to send iMessage");
    throw err;
  }
}

async function sendLongMessage(
  text: string,
  chatIdentifier: string,
  isGroup: boolean,
): Promise<void> {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, SPLIT_DELAY_MS));
    }
    await sendIMessage(chunks[i]!, chatIdentifier, isGroup);
  }
}

export class IMessagePlatform implements Platform {
  private db: Database.Database | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastRowId = 0;
  private allowlist: Set<string>;
  private stmt: Database.Statement | null = null;

  constructor() {
    const raw = config.imessageAllowlist;
    if (!raw) {
      throw new Error(
        "IMESSAGE_ALLOWLIST is required for iMessage platform. " +
          "Set it to a comma-separated list of phone numbers and/or emails.",
      );
    }
    this.allowlist = new Set(
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
    logger.info(
      { allowlistSize: this.allowlist.size },
      "iMessage allowlist loaded",
    );
  }

  private isAllowed(handle: string): boolean {
    return this.allowlist.has(handle.toLowerCase());
  }

  async start(handler: MessageHandler): Promise<void> {
    // Open chat.db read-only
    this.db = new Database(config.imessageChatDbPath, { readonly: true });

    // Initialize lastRowId to current max so we skip historical messages
    const maxRow = this.db
      .prepare("SELECT MAX(ROWID) as maxId FROM message")
      .get() as { maxId: number | null } | undefined;
    this.lastRowId = maxRow?.maxId ?? 0;

    // Prepare reusable statement
    this.stmt = this.db.prepare(`
      SELECT
        m.ROWID as rowid,
        m.text,
        m.attributedBody,
        h.id as handle_id,
        c.chat_identifier,
        CASE WHEN c.cache_roomnames IS NOT NULL THEN 1 ELSE 0 END as is_group
      FROM message m
      JOIN handle h ON m.handle_id = h.ROWID
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON cmj.chat_id = c.ROWID
      WHERE m.ROWID > ? AND m.is_from_me = 0
      ORDER BY m.ROWID ASC
    `);

    logger.info(
      { lastRowId: this.lastRowId, dbPath: config.imessageChatDbPath },
      "Starting iMessage platform (polling)",
    );

    // Process messages sequentially via a queue
    let processing = false;
    const queue: RawMessage[] = [];

    const processQueue = async () => {
      if (processing) return;
      processing = true;

      while (queue.length > 0) {
        const row = queue.shift()!;
        const text = getMessageText(row);
        if (!text) continue;

        if (!this.isAllowed(row.handle_id)) {
          logger.debug(
            { handle: row.handle_id },
            "Ignoring message from non-allowlisted sender",
          );
          continue;
        }

        const message: IncomingMessage = {
          platformUserId: row.handle_id,
          platformUsername: row.handle_id,
          text,
          platform: "imessage",
        };

        const isGroup = row.is_group === 1;
        logger.info(
          { user: row.handle_id, isGroup, chatIdentifier: row.chat_identifier },
          "iMessage received",
        );

        try {
          const responseText = await handler(message);
          await sendLongMessage(
            responseText,
            row.chat_identifier,
            isGroup,
          );
        } catch (err) {
          logger.error({ err }, "Error handling iMessage");
          try {
            await sendIMessage(
              "Sorry, something went wrong. Try again?",
              row.chat_identifier,
              isGroup,
            );
          } catch {
            // If we can't even send the error message, just log it
            logger.error("Failed to send error reply via iMessage");
          }
        }
      }

      processing = false;
    };

    this.pollTimer = setInterval(() => {
      if (!this.stmt) return;
      try {
        const rows = this.stmt.all(this.lastRowId) as RawMessage[];
        for (const row of rows) {
          if (row.rowid > this.lastRowId) {
            this.lastRowId = row.rowid;
          }
          queue.push(row);
        }
        if (queue.length > 0) {
          processQueue();
        }
      } catch (err) {
        logger.error({ err }, "Error polling chat.db");
      }
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.stmt = null;
    logger.info("iMessage platform stopped");
  }
}
