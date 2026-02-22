import type Anthropic from "@anthropic-ai/sdk";
import type { Module } from "../types.js";
import { getDb, schema } from "../../db/client.js";
import { eq, and } from "drizzle-orm";
import { ulid } from "ulid";

const tools: Anthropic.Tool[] = [
  {
    name: "add_task",
    description:
      "Add a task or item to a list. Use list='grocery' for grocery/shopping items, list='general' for to-do items, or any other list name the user specifies. Set due_date when the user mentions a deadline or timeframe.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "The task or item to add" },
        list: {
          type: "string",
          description: "Which list to add to: 'grocery', 'general', or a custom name",
          default: "general",
        },
        due_date: {
          type: "string",
          description: "Due date in ISO format (YYYY-MM-DD). Interpret relative dates like 'this week' (end of current week = Friday), 'tomorrow', 'next Monday', etc.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "list_tasks",
    description:
      "List tasks/items on a list. Use list='grocery' for grocery items, list='general' for to-do items, or 'all' for everything. Can filter by completed status.",
    input_schema: {
      type: "object" as const,
      properties: {
        list: {
          type: "string",
          description: "Which list to show: 'grocery', 'general', 'all', or a custom name",
          default: "all",
        },
        include_completed: {
          type: "boolean",
          description: "Whether to include completed items",
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: "complete_task",
    description: "Mark a task as completed by its title (partial match supported).",
    input_schema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "The task title (or partial match) to mark as completed",
        },
      },
      required: ["title"],
    },
  },
];

async function addTask(input: Record<string, unknown>): Promise<unknown> {
  const db = getDb();
  const title = input["title"] as string;
  const list = (input["list"] as string) || "general";
  const dueDate = (input["due_date"] as string) || null;
  const id = ulid();

  await db.insert(schema.tasks).values({
    id,
    title,
    list,
    dueDate,
    completed: false,
    createdAt: new Date().toISOString(),
  });

  return { success: true, id, title, list, dueDate };
}

async function listTasks(input: Record<string, unknown>): Promise<unknown> {
  const db = getDb();
  const list = (input["list"] as string) || "all";
  const includeCompleted = (input["include_completed"] as boolean) ?? false;

  let results;
  if (list === "all") {
    if (includeCompleted) {
      results = await db.select().from(schema.tasks);
    } else {
      results = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.completed, false));
    }
  } else {
    if (includeCompleted) {
      results = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.list, list));
    } else {
      results = await db
        .select()
        .from(schema.tasks)
        .where(and(eq(schema.tasks.list, list), eq(schema.tasks.completed, false)));
    }
  }

  return {
    list,
    count: results.length,
    items: results.map((t) => ({
      id: t.id,
      title: t.title,
      list: t.list,
      dueDate: t.dueDate,
      completed: t.completed,
    })),
  };
}

async function completeTask(input: Record<string, unknown>): Promise<unknown> {
  const db = getDb();
  const title = (input["title"] as string).toLowerCase();

  // Find matching task
  const allTasks = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.completed, false));

  const match = allTasks.find((t) => t.title.toLowerCase().includes(title));

  if (!match) {
    return { success: false, error: `No open task matching "${input["title"]}" found` };
  }

  await db
    .update(schema.tasks)
    .set({ completed: true, completedAt: new Date().toISOString() })
    .where(eq(schema.tasks.id, match.id));

  return { success: true, title: match.title, list: match.list };
}

export const tasksModule: Module = {
  name: "tasks",
  description: "Task and grocery list management",
  tools,
  async executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "add_task":
        return addTask(input);
      case "list_tasks":
        return listTasks(input);
      case "complete_task":
        return completeTask(input);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  },
};
