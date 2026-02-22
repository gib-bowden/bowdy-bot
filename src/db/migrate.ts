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

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      list TEXT NOT NULL DEFAULT 'general',
      due_date TEXT,
      completed INTEGER NOT NULL DEFAULT 0,
      created_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    DROP TABLE IF EXISTS conversation_history;
    CREATE TABLE conversation_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Add columns to existing tables (safe to fail if already exists)
  const addColumn = (table: string, column: string, type: string) => {
    try {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch {
      // Column already exists
    }
  };

  addColumn("tasks", "due_date", "TEXT");

  sqlite.close();
  logger.info("Schema ensured");
}
