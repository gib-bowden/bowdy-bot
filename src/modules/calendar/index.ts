import type Anthropic from "@anthropic-ai/sdk";
import type { Module } from "../types.js";
import { getCalendarClient, getCalendarId } from "./client.js";
import { config } from "../../config.js";

/** Get the current time as an ISO string with the correct timezone offset */
export function nowInTz(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: config.timezone }).replace(" ", "T") + tzOffset();
}

/** Get an ISO datetime N days from now with the correct timezone offset */
export function futureInTz(days: number): string {
  const future = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return future.toLocaleString("sv-SE", { timeZone: config.timezone }).replace(" ", "T") + tzOffset();
}

/** Get ISO datetime for start of a given date (YYYY-MM-DD) in the configured timezone */
export function startOfDayInTz(dateStr: string): string {
  return `${dateStr}T00:00:00${tzOffset()}`;
}

/** Get ISO datetime for end of a given date (YYYY-MM-DD) in the configured timezone */
export function endOfDayInTz(dateStr: string): string {
  return `${dateStr}T23:59:59${tzOffset()}`;
}

/** Get the UTC offset string (e.g. "-06:00") for the configured timezone */
export function tzOffset(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    timeZoneName: "shortOffset",
  }).formatToParts(now);
  const offsetPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  // offsetPart is like "GMT-6" or "GMT+5:30" — convert to "-06:00" or "+05:30"
  const match = offsetPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return "Z";
  const sign = match[1]!;
  const hours = match[2]!.padStart(2, "0");
  const minutes = match[3] ?? "00";
  return `${sign}${hours}:${minutes}`;
}

/** Ensure a datetime string has a timezone offset; append the local offset if missing */
export function ensureOffset(dt: string): string {
  // Already has offset (Z, +HH:MM, -HH:MM)
  if (/Z$|[+-]\d{2}:\d{2}$/.test(dt)) return dt;
  return dt + tzOffset();
}

const tools: Anthropic.Tool[] = [
  {
    name: "list_events",
    description:
      "List calendar events. Use start_date/end_date for specific date ranges (e.g. 'today' = same date for both). Falls back to 'days' ahead from now if no dates given. Use query to search by title.",
    input_schema: {
      type: "object" as const,
      properties: {
        start_date: {
          type: "string",
          description: "Start date in YYYY-MM-DD format (e.g. 2026-02-23). Events from the start of this day.",
        },
        end_date: {
          type: "string",
          description: "End date in YYYY-MM-DD format (e.g. 2026-02-23). Events through the end of this day.",
        },
        days: {
          type: "number",
          description: "Number of days ahead to look from now (default: 7). Ignored if start_date/end_date are provided.",
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
  const calendar = await getCalendarClient();
  const calendarId = getCalendarId();
  const startDate = input["start_date"] as string | undefined;
  const endDate = input["end_date"] as string | undefined;
  const days = (input["days"] as number) || 7;
  const query = input["query"] as string | undefined;

  // Use explicit date range if provided, otherwise fall back to days-from-now
  const timeMin = startDate ? startOfDayInTz(startDate) : nowInTz();
  const timeMax = endDate ? endOfDayInTz(endDate) : futureInTz(days);

  const response = await calendar.events.list({
    calendarId,
    timeMin,
    timeMax,
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

  return { count: events.length, ...(startDate ? { startDate, endDate } : { days }), events };
}

async function createEvent(input: Record<string, unknown>): Promise<unknown> {
  const calendar = await getCalendarClient();
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
      start: { dateTime: ensureOffset(start), timeZone: config.timezone },
      end: { dateTime: ensureOffset(end), timeZone: config.timezone },
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
  const calendar = await getCalendarClient();
  const calendarId = getCalendarId();
  const title = (input["title"] as string).toLowerCase();

  // Search for upcoming events matching the title
  const response = await calendar.events.list({
    calendarId,
    timeMin: nowInTz(),
    timeMax: futureInTz(90),
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
