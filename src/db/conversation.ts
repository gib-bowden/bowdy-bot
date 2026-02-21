import { desc, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { getDb, schema } from "./client.js";

const MAX_HISTORY = 30; // last 30 messages (15 exchanges)

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export async function getConversationHistory(platformUserId: string): Promise<HistoryMessage[]> {
  const db = getDb();

  const rows = await db
    .select({ role: schema.conversationHistory.role, content: schema.conversationHistory.content })
    .from(schema.conversationHistory)
    .where(eq(schema.conversationHistory.userId, platformUserId))
    .orderBy(desc(schema.conversationHistory.createdAt))
    .limit(MAX_HISTORY);

  // Rows come back newest-first, reverse to chronological
  return rows.reverse().map((r) => ({
    role: r.role as "user" | "assistant",
    content: r.content,
  }));
}

export async function saveMessage(
  platformUserId: string,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  const db = getDb();

  await db.insert(schema.conversationHistory).values({
    id: ulid(),
    userId: platformUserId,
    role,
    content,
    createdAt: new Date().toISOString(),
  });
}
