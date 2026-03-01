import type Anthropic from "@anthropic-ai/sdk";
import { eq, and } from "drizzle-orm";
import { ulid } from "ulid";
import type { Module } from "../types.js";
import { getDb, schema } from "../../db/client.js";
import { scheduleReminder, cancelScheduledReminder } from "../../cron/reminders.js";
import { config } from "../../config.js";

const tools: Anthropic.Tool[] = [
  {
    name: "create_reminder",
    description:
      "Create a reminder that will be sent to the group chat at the specified time. Claude should convert natural language times to ISO datetime strings.",
    input_schema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description: "The reminder message (e.g. 'Pick up dry cleaning')",
        },
        due_at: {
          type: "string",
          description:
            "When to fire the reminder as ISO 8601 datetime (e.g. 2026-03-01T14:00:00). Use the family timezone.",
        },
      },
      required: ["message", "due_at"],
    },
  },
  {
    name: "list_reminders",
    description: "List all pending (unfired) reminders.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "cancel_reminder",
    description:
      "Cancel a pending reminder by its message text (partial match supported).",
    input_schema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description: "The reminder message text (or partial match) to cancel",
        },
      },
      required: ["message"],
    },
  },
];

function createReminder(input: Record<string, unknown>): unknown {
  const message = input["message"] as string;
  const dueAtStr = input["due_at"] as string;
  const dueAt = new Date(dueAtStr);

  if (isNaN(dueAt.getTime())) {
    return { success: false, error: `Invalid date: ${dueAtStr}` };
  }

  const id = ulid();
  const db = getDb();

  db.insert(schema.reminders)
    .values({
      id,
      message,
      dueAt: dueAt.toISOString(),
      createdBy: "chat",
      platform: config.platform,
      fired: false,
    })
    .run();

  // Schedule the job if GroupMe is configured
  if (config.groupmeBotId) {
    scheduleReminder(id, dueAt, message, {
      groupmeBotId: config.groupmeBotId,
    });
  }

  return {
    success: true,
    id,
    message,
    due_at: dueAt.toISOString(),
  };
}

function listReminders(): unknown {
  const db = getDb();
  const reminders = db
    .select()
    .from(schema.reminders)
    .where(eq(schema.reminders.fired, false))
    .all();

  return {
    count: reminders.length,
    reminders: reminders.map((r) => ({
      id: r.id,
      message: r.message,
      due_at: r.dueAt,
      created_at: r.createdAt,
    })),
  };
}

function cancelReminder(input: Record<string, unknown>): unknown {
  const searchText = (input["message"] as string).toLowerCase();
  const db = getDb();

  const unfired = db
    .select()
    .from(schema.reminders)
    .where(eq(schema.reminders.fired, false))
    .all();

  const match = unfired.find((r) =>
    r.message.toLowerCase().includes(searchText),
  );

  if (!match) {
    return {
      success: false,
      error: `No pending reminder matching "${input["message"]}" found`,
    };
  }

  // Mark as fired (soft delete) and cancel the scheduled job
  db.update(schema.reminders)
    .set({ fired: true })
    .where(eq(schema.reminders.id, match.id))
    .run();

  cancelScheduledReminder(match.id);

  return {
    success: true,
    message: match.message,
    was_due_at: match.dueAt,
  };
}

export const remindersModule: Module = {
  name: "reminders",
  description:
    "Create, list, and cancel reminders that fire at a specific time",
  tools,
  async executeTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    switch (name) {
      case "create_reminder":
        return createReminder(input);
      case "list_reminders":
        return listReminders();
      case "cancel_reminder":
        return cancelReminder(input);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  },
};
