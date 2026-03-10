import { getDb } from "../../db/client.js";
import { browserSessionMetrics, browserActionMetrics } from "../../db/schema.js";
import { eq, lt, sql, desc } from "drizzle-orm";
import { logger } from "../../logger.js";

let currentSessionId: string | null = null;
let sessionStartTime = 0;

export function generateSessionId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `sess_${ts}_${rand}`;
}

function generateActionId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 10);
  return `act_${ts}_${rand}`;
}

export function startMetricsSession(id: string, goal: string, url: string): void {
  currentSessionId = id;
  sessionStartTime = Date.now();

  try {
    const db = getDb();
    db.insert(browserSessionMetrics).values({
      id,
      goal,
      startUrl: url,
      status: "running",
    }).run();

    // Prune old metrics on session start
    pruneOldMetrics();
  } catch (err) {
    logger.warn({ err }, "Failed to start metrics session");
  }
}

export function recordActionMetric(opts: {
  action: string;
  success: boolean;
  durationMs: number;
  error?: string;
  retries?: number;
  url?: string;
}): void {
  if (!currentSessionId) {
    return;
  }

  try {
    const db = getDb();
    db.insert(browserActionMetrics).values({
      id: generateActionId(),
      sessionId: currentSessionId,
      action: opts.action,
      success: opts.success,
      errorMessage: opts.error ?? null,
      durationMs: opts.durationMs,
      retryCount: opts.retries ?? 0,
      url: opts.url,
    }).run();
  } catch (err) {
    logger.warn({ err }, "Failed to record action metric");
  }
}

export function endMetricsSession(status: string, routerIterations?: number): void {
  if (!currentSessionId) {
    return;
  }

  try {
    const db = getDb();
    const totalDurationMs = Date.now() - sessionStartTime;

    // Count actions from the action metrics table
    const counts = db.select({
      total: sql<number>`count(*)`,
      successful: sql<number>`sum(case when ${browserActionMetrics.success} = 1 then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${browserActionMetrics.success} = 0 then 1 else 0 end)`,
    })
      .from(browserActionMetrics)
      .where(eq(browserActionMetrics.sessionId, currentSessionId))
      .get();

    db.update(browserSessionMetrics)
      .set({
        status,
        totalDurationMs,
        routerIterations: routerIterations ?? null,
        totalActions: counts?.total ?? 0,
        successfulActions: counts?.successful ?? 0,
        failedActions: counts?.failed ?? 0,
      })
      .where(eq(browserSessionMetrics.id, currentSessionId))
      .run();
  } catch (err) {
    logger.warn({ err }, "Failed to end metrics session");
  }

  currentSessionId = null;
  sessionStartTime = 0;
}

export function getMetricsSessionId(): string | null {
  return currentSessionId;
}

function pruneOldMetrics(daysToKeep = 30): void {
  try {
    const db = getDb();
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();

    // Delete old action metrics first (FK constraint)
    db.delete(browserActionMetrics)
      .where(sql`${browserActionMetrics.sessionId} IN (
        SELECT ${browserSessionMetrics.id} FROM ${browserSessionMetrics}
        WHERE ${browserSessionMetrics.createdAt} < ${cutoff}
      )`)
      .run();

    db.delete(browserSessionMetrics)
      .where(lt(browserSessionMetrics.createdAt, cutoff))
      .run();
  } catch (err) {
    logger.warn({ err }, "Failed to prune old metrics");
  }
}

export function getFailurePatterns(limit = 10): Array<{ action: string; errorMessage: string; count: number }> {
  try {
    const db = getDb();
    return db.select({
      action: browserActionMetrics.action,
      errorMessage: browserActionMetrics.errorMessage,
      count: sql<number>`count(*)`,
    })
      .from(browserActionMetrics)
      .where(eq(browserActionMetrics.success, false))
      .groupBy(browserActionMetrics.action, browserActionMetrics.errorMessage)
      .orderBy(desc(sql`count(*)`))
      .limit(limit)
      .all()
      .map((row) => ({
        action: row.action,
        errorMessage: row.errorMessage ?? "unknown",
        count: row.count,
      }));
  } catch (err) {
    logger.warn({ err }, "Failed to get failure patterns");
    return [];
  }
}
