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

  // Email triage — scan at configured morning/evening hours, poll replies every 30 min
  if (config.enableEmailTriage) {
    const morningHour = parseInt(config.emailTriageMorningHour, 10);
    const eveningHour = parseInt(config.emailTriageEveningHour, 10);

    const runTriage = async () => {
      const { runScheduledTriage } = await import("./email-triage.js");
      runScheduledTriage();
    };

    // Triage scans at morning + evening
    schedule.scheduleJob({ hour: morningHour, minute: 0, tz: ctx.timezone }, runTriage);
    schedule.scheduleJob({ hour: eveningHour, minute: 0, tz: ctx.timezone }, runTriage);

    logger.info(
      { morningHour, eveningHour, timezone: ctx.timezone },
      "Email triage scheduled",
    );
  }

  // Recover unfired reminders from SQLite on startup
  recoverReminders(ctx);
}
