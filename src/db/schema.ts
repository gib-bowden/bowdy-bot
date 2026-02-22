import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), // ULID
  name: text("name").notNull(),
  platformId: text("platform_id").notNull(),
  platform: text("platform").notNull(), // "console" | "telegram"
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(), // ULID
  title: text("title").notNull(),
  list: text("list").notNull().default("general"), // "general", "grocery", etc.
  dueDate: text("due_date"), // ISO date string, e.g. "2026-02-25"
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  createdBy: text("created_by").references(() => users.id),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  completedAt: text("completed_at"),
});

export const conversationHistory = sqliteTable("conversation_history", {
  id: text("id").primaryKey(), // ULID
  userId: text("user_id").notNull(),
  role: text("role").notNull(), // "user" | "assistant"
  content: text("content").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});
