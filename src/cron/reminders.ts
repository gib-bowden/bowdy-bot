import schedule from "node-schedule";
import { eq, and } from "drizzle-orm";
import { getDb, schema } from "../db/client.js";
import { sendGroupMeMessage, splitMessage } from "../platform/groupme.js";
import { logger } from "../logger.js";

const SPLIT_DELAY_MS = 500;

export interface ReminderContext {
  groupmeBotId: string;
}

const activeJobs = new Map<string, schedule.Job>();

export function scheduleReminder(
  id: string,
  dueAt: Date,
  message: string,
  ctx: ReminderContext,
): void {
  const job = schedule.scheduleJob(dueAt, async () => {
    try {
      const text = `⏰ Reminder: ${message}`;
      const chunks = splitMessage(text);
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, SPLIT_DELAY_MS));
        }
        await sendGroupMeMessage(ctx.groupmeBotId, chunks[i]!);
      }
    } catch (err) {
      logger.error({ err, reminderId: id }, "Failed to send reminder");
    }
    markReminderFired(id);
    activeJobs.delete(id);
  });

  if (job) {
    activeJobs.set(id, job);
    logger.info({ reminderId: id, dueAt: dueAt.toISOString(), message }, "Reminder scheduled");
  } else {
    // Job date is in the past — fire immediately
    logger.info({ reminderId: id, message }, "Reminder due date in the past, firing immediately");
    fireImmediately(id, message, ctx);
  }
}

export function cancelScheduledReminder(id: string): void {
  activeJobs.get(id)?.cancel();
  activeJobs.delete(id);
}

export function recoverReminders(ctx: ReminderContext): void {
  const db = getDb();
  const unfired = db
    .select()
    .from(schema.reminders)
    .where(eq(schema.reminders.fired, false))
    .all();

  logger.info({ count: unfired.length }, "Recovering unfired reminders");

  for (const reminder of unfired) {
    const dueAt = new Date(reminder.dueAt);
    if (dueAt.getTime() <= Date.now()) {
      fireImmediately(reminder.id, reminder.message, ctx);
    } else {
      scheduleReminder(reminder.id, dueAt, reminder.message, ctx);
    }
  }
}

function markReminderFired(id: string): void {
  const db = getDb();
  db.update(schema.reminders)
    .set({ fired: true })
    .where(eq(schema.reminders.id, id))
    .run();
}

async function fireImmediately(
  id: string,
  message: string,
  ctx: ReminderContext,
): Promise<void> {
  try {
    await sendGroupMeMessage(ctx.groupmeBotId, `⏰ Reminder: ${message}`);
  } catch (err) {
    logger.error({ err, reminderId: id }, "Failed to send overdue reminder");
  }
  markReminderFired(id);
}
