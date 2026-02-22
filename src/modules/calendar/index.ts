import type Anthropic from "@anthropic-ai/sdk";
import type { Module } from "../types.js";
import { getCalendarClient, getCalendarId } from "./client.js";
import { config } from "../../config.js";

const tools: Anthropic.Tool[] = [
  {
    name: "list_events",
    description:
      "List upcoming calendar events. Returns events within the specified number of days from now. Use query to search for specific events by title.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: {
          type: "number",
          description: "Number of days ahead to look (default: 7)",
          default: 7,
        },
        query: {
          type: "string",
          description: "Optional text search to filter events by title",
        },
      },
      required: [],
    },
  },
  {
    name: "create_event",
    description:
      "Create a new calendar event. Claude should convert natural language times to ISO datetime strings using the family timezone.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Event title/summary" },
        start: {
          type: "string",
          description: "Start time as ISO 8601 datetime (e.g. 2026-02-25T14:00:00)",
        },
        end: {
          type: "string",
          description: "End time as ISO 8601 datetime (e.g. 2026-02-25T15:00:00)",
        },
        description: {
          type: "string",
          description: "Optional event description/notes",
        },
        location: {
          type: "string",
          description: "Optional event location",
        },
      },
      required: ["title", "start", "end"],
    },
  },
  {
    name: "delete_event",
    description:
      "Delete/cancel a calendar event by searching for it by title. Finds the next upcoming event matching the title and deletes it.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "The event title (or partial match) to find and delete",
        },
      },
      required: ["title"],
    },
  },
];

async function listEvents(input: Record<string, unknown>): Promise<unknown> {
  const calendar = getCalendarClient();
  const calendarId = getCalendarId();
  const days = (input["days"] as number) || 7;
  const query = input["query"] as string | undefined;

  const now = new Date();
  const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const response = await calendar.events.list({
    calendarId,
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    q: query,
    timeZone: config.timezone,
  });

  const events = (response.data.items || []).map((event) => ({
    id: event.id,
    title: event.summary,
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    location: event.location || null,
    description: event.description || null,
  }));

  return { count: events.length, days, events };
}

async function createEvent(input: Record<string, unknown>): Promise<unknown> {
  const calendar = getCalendarClient();
  const calendarId = getCalendarId();

  const title = input["title"] as string;
  const start = input["start"] as string;
  const end = input["end"] as string;
  const description = input["description"] as string | undefined;
  const location = input["location"] as string | undefined;

  const response = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: title,
      start: { dateTime: start, timeZone: config.timezone },
      end: { dateTime: end, timeZone: config.timezone },
      description,
      location,
    },
  });

  return {
    success: true,
    id: response.data.id,
    title: response.data.summary,
    start: response.data.start?.dateTime,
    end: response.data.end?.dateTime,
  };
}

async function deleteEvent(input: Record<string, unknown>): Promise<unknown> {
  const calendar = getCalendarClient();
  const calendarId = getCalendarId();
  const title = (input["title"] as string).toLowerCase();

  // Search for upcoming events matching the title
  const now = new Date();
  const future = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // look 90 days ahead

  const response = await calendar.events.list({
    calendarId,
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    q: title,
    timeZone: config.timezone,
  });

  const match = (response.data.items || []).find((event) =>
    event.summary?.toLowerCase().includes(title),
  );

  if (!match || !match.id) {
    return { success: false, error: `No upcoming event matching "${input["title"]}" found` };
  }

  await calendar.events.delete({ calendarId, eventId: match.id });

  return {
    success: true,
    title: match.summary,
    start: match.start?.dateTime || match.start?.date,
  };
}

export const calendarModule: Module = {
  name: "calendar",
  description: "Google Calendar integration for viewing, creating, and deleting events",
  tools,
  async executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "list_events":
        return listEvents(input);
      case "create_event":
        return createEvent(input);
      case "delete_event":
        return deleteEvent(input);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  },
};
