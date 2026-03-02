import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Push schema directly to SQLite (no migration files needed for dev).
 * Creates tables if they don't exist.
 */
export function ensureSchema(): void {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const sqlite = new Database(config.dbPath);
  sqlite.pragma("journal_mode = WAL");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    DROP TABLE IF EXISTS tasks;

    CREATE TABLE IF NOT EXISTS google_accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      access_token TEXT,
      token_expiry TEXT,
      scopes TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kroger_accounts (
      id TEXT PRIMARY KEY,
      kroger_user_id TEXT NOT NULL UNIQUE,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      token_expiry TEXT,
      scopes TEXT NOT NULL,
      store_id TEXT,
      store_name TEXT,
      store_address TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS product_preferences (
      id TEXT PRIMARY KEY,
      generic_name TEXT NOT NULL UNIQUE,
      upc TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      brand TEXT,
      size TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    DROP TABLE IF EXISTS cart_items;

    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      due_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      platform TEXT NOT NULL,
      fired INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversation_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS email_triage_sessions (
      id TEXT PRIMARY KEY,
      account_email TEXT NOT NULL,
      triage_email_thread_id TEXT,
      triage_email_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      email_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS email_triage_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES email_triage_sessions(id),
      gmail_message_id TEXT NOT NULL,
      gmail_thread_id TEXT NOT NULL,
      account_email TEXT NOT NULL,
      subject TEXT,
      sender TEXT,
      snippet TEXT,
      received_at TEXT,
      category TEXT,
      summary TEXT,
      suggested_action TEXT,
      action_taken TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS email_rules (
      id TEXT PRIMARY KEY,
      account_email TEXT,
      match_type TEXT NOT NULL,
      match_value TEXT NOT NULL,
      action TEXT NOT NULL,
      label TEXT,
      applied_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(match_type, match_value, account_email)
    );
  `);

  sqlite.close();
  logger.info("Schema ensured");
}
