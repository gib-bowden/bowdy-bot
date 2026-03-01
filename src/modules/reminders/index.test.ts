import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockUpdate = vi.fn();

// Track scheduled reminders
const mockScheduleReminder = vi.fn();
const mockCancelScheduledReminder = vi.fn();

vi.mock("../../cron/reminders.js", () => ({
  scheduleReminder: (...args: unknown[]) => mockScheduleReminder(...args),
  cancelScheduledReminder: (...args: unknown[]) => mockCancelScheduledReminder(...args),
}));

// Mock DB — chain .values().run() for insert, .from().where().all() for select
vi.mock("../../db/client.js", () => {
  const valuesRun = { values: vi.fn(() => ({ run: vi.fn() })) };
  const setWhereRun = { set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) };

  return {
    getDb: () => ({
      insert: () => valuesRun,
      select: () => ({
        from: () => ({
          where: () => ({
            all: () => mockSelect(),
          }),
        }),
      }),
      update: () => setWhereRun,
    }),
    schema: {
      reminders: { fired: "fired", id: "id" },
    },
  };
});

vi.mock("../../config.js", () => ({
  config: { platform: "groupme", groupmeBotId: "bot-123" },
}));

import { remindersModule } from "./index.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("create_reminder", () => {
  it("creates a reminder and schedules it", async () => {
    const result = (await remindersModule.executeTool("create_reminder", {
      message: "Pick up dry cleaning",
      due_at: "2026-03-01T14:00:00",
    })) as Record<string, unknown>;

    expect(result["success"]).toBe(true);
    expect(result["message"]).toBe("Pick up dry cleaning");
    expect(result["id"]).toBeDefined();
    expect(mockScheduleReminder).toHaveBeenCalledWith(
      result["id"],
      expect.any(Date),
      "Pick up dry cleaning",
      { groupmeBotId: "bot-123" },
    );
  });

  it("rejects invalid dates", async () => {
    const result = (await remindersModule.executeTool("create_reminder", {
      message: "Test",
      due_at: "not-a-date",
    })) as Record<string, unknown>;

    expect(result["success"]).toBe(false);
    expect(result["error"]).toContain("Invalid date");
    expect(mockScheduleReminder).not.toHaveBeenCalled();
  });
});

describe("list_reminders", () => {
  it("returns unfired reminders", async () => {
    mockSelect.mockReturnValue([
      {
        id: "r1",
        message: "Buy milk",
        dueAt: "2026-03-02T10:00:00.000Z",
        createdAt: "2026-03-01T08:00:00.000Z",
      },
      {
        id: "r2",
        message: "Call dentist",
        dueAt: "2026-03-03T09:00:00.000Z",
        createdAt: "2026-03-01T08:00:00.000Z",
      },
    ]);

    const result = (await remindersModule.executeTool("list_reminders", {})) as Record<string, unknown>;

    expect(result["count"]).toBe(2);
    expect(result["reminders"]).toEqual([
      expect.objectContaining({ id: "r1", message: "Buy milk" }),
      expect.objectContaining({ id: "r2", message: "Call dentist" }),
    ]);
  });

  it("returns empty when no reminders", async () => {
    mockSelect.mockReturnValue([]);

    const result = (await remindersModule.executeTool("list_reminders", {})) as Record<string, unknown>;

    expect(result["count"]).toBe(0);
    expect(result["reminders"]).toEqual([]);
  });
});

describe("cancel_reminder", () => {
  it("cancels a matching reminder", async () => {
    mockSelect.mockReturnValue([
      { id: "r1", message: "Buy milk", dueAt: "2026-03-02T10:00:00.000Z" },
    ]);

    const result = (await remindersModule.executeTool("cancel_reminder", {
      message: "milk",
    })) as Record<string, unknown>;

    expect(result["success"]).toBe(true);
    expect(result["message"]).toBe("Buy milk");
    expect(mockCancelScheduledReminder).toHaveBeenCalledWith("r1");
  });

  it("errors when no matching reminder found", async () => {
    mockSelect.mockReturnValue([]);

    const result = (await remindersModule.executeTool("cancel_reminder", {
      message: "nonexistent",
    })) as Record<string, unknown>;

    expect(result["success"]).toBe(false);
    expect(result["error"]).toContain("No pending reminder");
  });

  it("matches case-insensitively", async () => {
    mockSelect.mockReturnValue([
      { id: "r1", message: "Buy MILK", dueAt: "2026-03-02T10:00:00.000Z" },
    ]);

    const result = (await remindersModule.executeTool("cancel_reminder", {
      message: "milk",
    })) as Record<string, unknown>;

    expect(result["success"]).toBe(true);
    expect(result["message"]).toBe("Buy MILK");
  });
});
