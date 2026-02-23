import type Anthropic from "@anthropic-ai/sdk";
import type { Module } from "../types.js";
import { getTasksClient } from "./client.js";

const taskListCache = new Map<string, string>();

async function resolveTaskListId(name: string): Promise<string> {
  name = name.toLowerCase();
  const cached = taskListCache.get(name);
  if (cached) return cached;

  const client = await getTasksClient();

  // Fetch all task lists and populate cache
  const response = await client.tasklists.list({ maxResults: 100 });
  for (const list of response.data.items || []) {
    if (list.id && list.title) {
      taskListCache.set(list.title.toLowerCase(), list.id);
    }
  }

  const existing = taskListCache.get(name);
  if (existing) return existing;

  // Create if missing
  const created = await client.tasklists.insert({
    requestBody: { title: name },
  });

  const id = created.data.id!;
  taskListCache.set(name, id);
  return id;
}

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
          description:
            "Due date in ISO format (YYYY-MM-DD). Interpret relative dates like 'this week' (end of current week = Friday), 'tomorrow', 'next Monday', etc.",
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
  const client = await getTasksClient();
  const title = input["title"] as string;
  const list = (input["list"] as string) || "general";
  const dueDate = input["due_date"] as string | undefined;

  const taskListId = await resolveTaskListId(list);

  const requestBody: { title: string; due?: string } = { title };
  if (dueDate) {
    requestBody.due = `${dueDate}T00:00:00.000Z`;
  }

  const response = await client.tasks.insert({ tasklist: taskListId, requestBody });

  return {
    success: true,
    id: response.data.id,
    title: response.data.title,
    list,
    dueDate: dueDate || null,
  };
}

async function listTasks(input: Record<string, unknown>): Promise<unknown> {
  const client = await getTasksClient();
  const list = (input["list"] as string) || "all";
  const includeCompleted = (input["include_completed"] as boolean) ?? false;

  if (list === "all") {
    const listsResponse = await client.tasklists.list({ maxResults: 100 });
    const allItems: Array<{
      id: string;
      title: string;
      list: string;
      dueDate: string | null;
      completed: boolean;
    }> = [];

    for (const taskList of listsResponse.data.items || []) {
      if (!taskList.id || !taskList.title) continue;
      const listName = taskList.title.toLowerCase();
      taskListCache.set(listName, taskList.id);

      const tasksResponse = await client.tasks.list({
        tasklist: taskList.id,
        maxResults: 100,
        showCompleted: includeCompleted,
        showHidden: includeCompleted,
      });

      for (const task of tasksResponse.data.items || []) {
        if (!task.title) continue;
        const dueDate = task.due?.split("T")[0] ?? null;
        allItems.push({
          id: task.id!,
          title: task.title,
          list: listName,
          dueDate,
          completed: task.status === "completed",
        });
      }
    }

    return { list: "all", count: allItems.length, items: allItems };
  }

  const taskListId = await resolveTaskListId(list);
  const tasksResponse = await client.tasks.list({
    tasklist: taskListId,
    maxResults: 100,
    showCompleted: includeCompleted,
    showHidden: includeCompleted,
  });

  const items = (tasksResponse.data.items || [])
    .filter((t) => t.title)
    .map((t) => ({
      id: t.id!,
      title: t.title!,
      list,
      dueDate: t.due?.split("T")[0] ?? null,
      completed: t.status === "completed",
    }));

  return { list, count: items.length, items };
}

async function completeTask(input: Record<string, unknown>): Promise<unknown> {
  const client = await getTasksClient();
  const title = (input["title"] as string).toLowerCase();

  // Search across all lists for a partial title match
  const listsResponse = await client.tasklists.list({ maxResults: 100 });

  for (const taskList of listsResponse.data.items || []) {
    if (!taskList.id || !taskList.title) continue;
    const listName = taskList.title.toLowerCase();
    taskListCache.set(listName, taskList.id);

    const tasksResponse = await client.tasks.list({
      tasklist: taskList.id,
      maxResults: 100,
      showCompleted: false,
    });

    const match = (tasksResponse.data.items || []).find((t) =>
      t.title?.toLowerCase().includes(title),
    );

    if (match && match.id) {
      await client.tasks.patch({
        tasklist: taskList.id,
        task: match.id,
        requestBody: { status: "completed" },
      });

      return { success: true, title: match.title, list: listName };
    }
  }

  return { success: false, error: `No open task matching "${input["title"]}" found` };
}

export const googleTasksModule: Module = {
  name: "tasks",
  description: "Task and grocery list management via Google Tasks",
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
