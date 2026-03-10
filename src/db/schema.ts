import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), // ULID
  name: text("name").notNull(),
  platformId: text("platform_id").notNull(),
  platform: text("platform").notNull(), // "console" | "telegram"
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const googleAccounts = sqliteTable("google_accounts", {
  id: text("id").primaryKey(), // ULID
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  refreshToken: text("refresh_token").notNull(),
  accessToken: text("access_token"),
  tokenExpiry: text("token_expiry"), // ISO datetime
  scopes: text("scopes").notNull(), // space-separated scopes
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const krogerAccounts = sqliteTable("kroger_accounts", {
  id: text("id").primaryKey(), // ULID
  krogerUserId: text("kroger_user_id").notNull().unique(),
  accessToken: text("access_token").notNull(), // encrypted
  refreshToken: text("refresh_token").notNull(), // encrypted
  tokenExpiry: text("token_expiry"), // ISO datetime
  scopes: text("scopes").notNull(),
  storeId: text("store_id"),
  storeName: text("store_name"),
  storeAddress: text("store_address"),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const productPreferences = sqliteTable("product_preferences", {
  id: text("id").primaryKey(), // ULID
  genericName: text("generic_name").notNull().unique(), // normalized lowercase key, e.g. "eggs"
  upc: text("upc").notNull(), // Kroger UPC for cart operations
  productId: text("product_id").notNull(), // Kroger product ID
  productName: text("product_name").notNull(), // display name, e.g. "Kroger Grade A Large Eggs, 12 ct"
  brand: text("brand"),
  size: text("size"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const reminders = sqliteTable("reminders", {
  id: text("id").primaryKey(), // ULID
  message: text("message").notNull(),
  dueAt: text("due_at").notNull(), // ISO datetime in local TZ
  createdBy: text("created_by").notNull(), // platformUserId
  platform: text("platform").notNull(), // "groupme" | "telegram" | etc.
  fired: integer("fired", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const conversationHistory = sqliteTable("conversation_history", {
  id: text("id").primaryKey(), // ULID
  userId: text("user_id").notNull(),
  role: text("role").notNull(), // "user" | "assistant"
  content: text("content").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const emailTriageSessions = sqliteTable("email_triage_sessions", {
  id: text("id").primaryKey(), // ULID
  accountEmail: text("account_email").notNull(),
  triageEmailThreadId: text("triage_email_thread_id"),
  triageEmailMessageId: text("triage_email_message_id"),
  status: text("status").notNull().default("pending"), // pending | sent | processed | expired
  emailCount: integer("email_count").notNull().default(0),
  triageItemMap: text("triage_item_map"), // JSON: {"1": ["msgId"], "2a": ["msgId2"], ...}
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  processedAt: text("processed_at"),
});

export const emailTriageItems = sqliteTable("email_triage_items", {
  id: text("id").primaryKey(), // ULID
  sessionId: text("session_id").notNull().references(() => emailTriageSessions.id),
  gmailMessageId: text("gmail_message_id").notNull(),
  gmailThreadId: text("gmail_thread_id").notNull(),
  accountEmail: text("account_email").notNull(),
  subject: text("subject"),
  sender: text("sender"),
  snippet: text("snippet"),
  receivedAt: text("received_at"),
  category: text("category"), // action_needed | fyi | recommend_archive | unknown
  displayIndex: text("display_index"), // "1", "4a", "4b", etc.
  summary: text("summary"),
  suggestedAction: text("suggested_action"),
  actionTaken: text("action_taken"),
  status: text("status").notNull().default("pending"), // pending | actioned | skipped
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const browserCookies = sqliteTable("browser_cookies", {
  domain: text("domain").primaryKey(),
  cookiesJson: text("cookies_json").notNull(), // encrypted JSON
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const emailRules = sqliteTable("email_rules", {
  id: text("id").primaryKey(), // ULID
  accountEmail: text("account_email"), // null = all accounts
  matchType: text("match_type").notNull(), // sender | domain | subject_contains
  matchValue: text("match_value").notNull(),
  action: text("action").notNull(), // archive | skip | important | label
  label: text("label"),
  appliedCount: integer("applied_count").notNull().default(0),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});
