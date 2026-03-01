import schedule from "node-schedule";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { runMorningBriefing } from "./morning-briefing.js";
import { recoverReminders } from "./reminders.js";

export interface SchedulerContext {
  groupmeBotId: string;
  timezone: string;
}

export function startScheduler(ctx: SchedulerContext): void {
  // Morning briefing — daily at configured hour
  if (config.enableMorningBriefing) {
    const hour = parseInt(config.morningBriefingHour, 10);
    schedule.scheduleJob({ hour, minute: 0, tz: ctx.timezone }, () => {
      runMorningBriefing(ctx);
    });
    logger.info({ hour, timezone: ctx.timezone }, "Morning briefing scheduled");
  }

  // Recover unfired reminders from SQLite on startup
  recoverReminders(ctx);
}
