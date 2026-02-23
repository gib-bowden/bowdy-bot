import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config to use a fixed timezone
vi.mock("../../config.js", () => ({
  config: {
    timezone: "America/Chicago",
    googleCalendarId: "test@gmail.com",
  },
}));

const mockEventsList = vi.fn();
const mockEventsInsert = vi.fn();
const mockEventsDelete = vi.fn();

vi.mock("./client.js", () => ({
  getCalendarClient: vi.fn(async () => ({
    events: {
      list: mockEventsList,
      insert: mockEventsInsert,
      delete: mockEventsDelete,
    },
  })),
  getCalendarId: vi.fn(() => "test@gmail.com"),
}));

import { calendarModule, tzOffset, ensureOffset, nowInTz, futureInTz } from "./index.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("tzOffset", () => {
  it("returns an offset string like -06:00 or -05:00", () => {
    const offset = tzOffset();
    expect(offset).toMatch(/^[+-]\d{2}:\d{2}$/);
  });

  it("returns a valid CST or CDT offset for America/Chicago", () => {
    const offset = tzOffset();
    // CST = -06:00, CDT = -05:00
    expect(["-06:00", "-05:00"]).toContain(offset);
  });
});

describe("ensureOffset", () => {
  it("appends timezone offset to bare datetime", () => {
    const result = ensureOffset("2026-02-26T14:00:00");
    expect(result).toMatch(/^2026-02-26T14:00:00[+-]\d{2}:\d{2}$/);
  });

  it("preserves existing Z offset", () => {
    expect(ensureOffset("2026-02-26T20:00:00Z")).toBe("2026-02-26T20:00:00Z");
  });

  it("preserves existing positive offset", () => {
    expect(ensureOffset("2026-02-26T14:00:00+05:30")).toBe("2026-02-26T14:00:00+05:30");
  });

  it("preserves existing negative offset", () => {
    expect(ensureOffset("2026-02-26T14:00:00-08:00")).toBe("2026-02-26T14:00:00-08:00");
  });
});

describe("nowInTz", () => {
  it("returns an ISO-like string with timezone offset", () => {
    const result = nowInTz();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });
});

describe("futureInTz", () => {
  it("returns a datetime with timezone offset", () => {
    const result = futureInTz(7);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  it("is ahead of nowInTz", () => {
    const now = nowInTz();
    const future = futureInTz(1);
    // Compare date portions — future should be >= now
    expect(future.slice(0, 10) >= now.slice(0, 10)).toBe(true);
  });
});

describe("calendarModule.executeTool - list_events", () => {
  it("passes timezone-aware timeMin and timeMax to the API", async () => {
    mockEventsList.mockResolvedValue({ data: { items: [] } });

    await calendarModule.executeTool("list_events", { days: 3 });

    const call = mockEventsList.mock.calls[0]![0];
    // timeMin and timeMax should have timezone offsets, not Z
    expect(call.timeMin).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(call.timeMax).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(call.timeMin).not.toMatch(/Z$/);
    expect(call.timeMax).not.toMatch(/Z$/);
    expect(call.timeZone).toBe("America/Chicago");
  });

  it("returns mapped events", async () => {
    mockEventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: "evt-1",
            summary: "Dentist",
            start: { dateTime: "2026-02-26T10:00:00-06:00" },
            end: { dateTime: "2026-02-26T11:00:00-06:00" },
            location: "123 Main St",
          },
        ],
      },
    });

    const result = await calendarModule.executeTool("list_events", {});

    expect(result).toEqual({
      count: 1,
      days: 7,
      events: [
        {
          id: "evt-1",
          title: "Dentist",
          start: "2026-02-26T10:00:00-06:00",
          end: "2026-02-26T11:00:00-06:00",
          location: "123 Main St",
          description: null,
        },
      ],
    });
  });
});

describe("calendarModule.executeTool - create_event", () => {
  it("appends timezone offset to bare datetimes", async () => {
    mockEventsInsert.mockResolvedValue({
      data: {
        id: "evt-new",
        summary: "Meeting",
        start: { dateTime: "2026-02-26T14:00:00-06:00" },
        end: { dateTime: "2026-02-26T15:00:00-06:00" },
      },
    });

    await calendarModule.executeTool("create_event", {
      title: "Meeting",
      start: "2026-02-26T14:00:00",
      end: "2026-02-26T15:00:00",
    });

    const call = mockEventsInsert.mock.calls[0]![0];
    const body = call.requestBody;
    // Should have appended offset, not left bare
    expect(body.start.dateTime).toMatch(/^2026-02-26T14:00:00[+-]\d{2}:\d{2}$/);
    expect(body.end.dateTime).toMatch(/^2026-02-26T15:00:00[+-]\d{2}:\d{2}$/);
    expect(body.start.timeZone).toBe("America/Chicago");
  });

  it("preserves existing offsets on datetimes", async () => {
    mockEventsInsert.mockResolvedValue({
      data: {
        id: "evt-new",
        summary: "Call",
        start: { dateTime: "2026-02-26T14:00:00-08:00" },
        end: { dateTime: "2026-02-26T15:00:00-08:00" },
      },
    });

    await calendarModule.executeTool("create_event", {
      title: "Call",
      start: "2026-02-26T14:00:00-08:00",
      end: "2026-02-26T15:00:00-08:00",
    });

    const call = mockEventsInsert.mock.calls[0]![0];
    expect(call.requestBody.start.dateTime).toBe("2026-02-26T14:00:00-08:00");
    expect(call.requestBody.end.dateTime).toBe("2026-02-26T15:00:00-08:00");
  });
});

describe("calendarModule.executeTool - delete_event", () => {
  it("uses timezone-aware timeMin for search", async () => {
    mockEventsList.mockResolvedValue({
      data: {
        items: [
          { id: "evt-1", summary: "Dentist", start: { dateTime: "2026-02-26T10:00:00-06:00" } },
        ],
      },
    });
    mockEventsDelete.mockResolvedValue({});

    await calendarModule.executeTool("delete_event", { title: "Dentist" });

    const call = mockEventsList.mock.calls[0]![0];
    expect(call.timeMin).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(call.timeMin).not.toMatch(/Z$/);
    expect(mockEventsDelete).toHaveBeenCalledWith({ calendarId: "test@gmail.com", eventId: "evt-1" });
  });

  it("returns error when no match found", async () => {
    mockEventsList.mockResolvedValue({ data: { items: [] } });

    const result = await calendarModule.executeTool("delete_event", { title: "Nonexistent" });

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("No upcoming event matching"),
    });
    expect(mockEventsDelete).not.toHaveBeenCalled();
  });
});
