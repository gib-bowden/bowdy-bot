import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";
import * as schema from "./schema.js";
import { logger } from "../logger.js";

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!db) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    const sqlite = new Database(config.dbPath);
    sqlite.pragma("journal_mode = WAL");
    db = drizzle(sqlite, { schema });
    logger.info({ path: config.dbPath }, "Database connected");
  }
  return db;
}

export { schema };
