import { getClient } from "../ai/client.js";
import { sendGroupMeMessage, splitMessage } from "../platform/groupme.js";
import { logger } from "../logger.js";

const SPLIT_DELAY_MS = 500;

export interface BriefingContext {
  groupmeBotId: string;
  timezone: string;
}

export async function runMorningBriefing(ctx: BriefingContext): Promise<void> {
  logger.info("Running morning briefing");

  try {
    // Gather data from calendar and tasks (both optional — fail gracefully)
    let calendarData = "";
    let tasksData = "";

    try {
      const { getCalendarClient, getCalendarId } = await import("../modules/calendar/client.js");
      const { nowInTz, endOfDayInTz } = await import("../modules/calendar/index.js");
      const calendar = await getCalendarClient();
      const calendarId = getCalendarId();
      const today = new Date().toLocaleDateString("sv-SE", { timeZone: ctx.timezone });

      const response = await calendar.events.list({
        calendarId,
        timeMin: nowInTz(),
        timeMax: endOfDayInTz(today),
        singleEvents: true,
        orderBy: "startTime",
        timeZone: ctx.timezone,
      });

      const events = (response.data.items || []).map((event) => ({
        title: event.summary,
        start: event.start?.dateTime || event.start?.date,
        end: event.end?.dateTime || event.end?.date,
        location: event.location || null,
      }));

      calendarData = events.length > 0
        ? `Today's calendar events:\n${JSON.stringify(events, null, 2)}`
        : "No calendar events today.";
    } catch (err) {
      logger.warn({ err }, "Failed to fetch calendar for morning briefing");
      calendarData = "Calendar data unavailable.";
    }

    try {
      const { getTasksClient } = await import("../modules/google-tasks/client.js");
      const client = await getTasksClient();
      const listsResponse = await client.tasklists.list({ maxResults: 100 });
      const allTasks: Array<{ title: string; list: string; dueDate: string | null }> = [];

      for (const taskList of listsResponse.data.items || []) {
        if (!taskList.id || !taskList.title) continue;
        // Skip the Kroger Cart list
        if (taskList.title.toLowerCase() === "kroger cart") continue;

        const tasksResponse = await client.tasks.list({
          tasklist: taskList.id,
          maxResults: 100,
          showCompleted: false,
        });

        for (const task of tasksResponse.data.items || []) {
          if (!task.title) continue;
          allTasks.push({
            title: task.title,
            list: taskList.title,
            dueDate: task.due?.split("T")[0] ?? null,
          });
        }
      }

      tasksData = allTasks.length > 0
        ? `Open tasks:\n${JSON.stringify(allTasks, null, 2)}`
        : "No open tasks.";
    } catch (err) {
      logger.warn({ err }, "Failed to fetch tasks for morning briefing");
      tasksData = "Tasks data unavailable.";
    }

    // Generate briefing via Claude
    const client = getClient();
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: ctx.timezone,
    });

    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: `You are Bowdy Bot, a family AI assistant for the Bowden household. Generate a brief, friendly morning briefing for the family group chat.

Today is ${today}.

${calendarData}

${tasksData}

Write a concise morning message (2-4 sentences max). Include:
- A brief greeting
- Key events for today (if any)
- Any tasks with today's due date (if any)
- Keep it casual and warm — this is a family chat

If there are no events or tasks, just give a friendly good morning. Do NOT use excessive emojis. One or two is fine.`,
        },
      ],
    });

    const briefingText =
      response.content[0]?.type === "text" ? response.content[0].text : "";

    if (!briefingText) {
      logger.warn("Morning briefing generated empty text");
      return;
    }

    // Send to GroupMe
    const chunks = splitMessage(briefingText);
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, SPLIT_DELAY_MS));
      }
      await sendGroupMeMessage(ctx.groupmeBotId, chunks[i]!);
    }

    logger.info("Morning briefing sent");
  } catch (err) {
    logger.error({ err }, "Morning briefing failed");
  }
}
