import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockScheduleJob = vi.fn();
const mockSendGroupMeMessage = vi.fn();
const mockSelect = vi.fn();
const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn();
const mockUpdateRun = vi.fn();

vi.mock("node-schedule", () => ({
  default: {
    scheduleJob: (...args: unknown[]) => mockScheduleJob(...args),
  },
}));

vi.mock("../platform/groupme.js", () => ({
  sendGroupMeMessage: (...args: unknown[]) => mockSendGroupMeMessage(...args),
  splitMessage: (text: string) => [text],
}));

vi.mock("../db/client.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          all: () => mockSelect(),
        }),
      }),
    }),
    update: () => ({
      set: (...args: unknown[]) => {
        mockUpdateSet(...args);
        return {
          where: (...wArgs: unknown[]) => {
            mockUpdateWhere(...wArgs);
            return { run: mockUpdateRun };
          },
        };
      },
    }),
  }),
  schema: {
    reminders: { fired: "fired", id: "id" },
  },
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { scheduleReminder, cancelScheduledReminder, recoverReminders } from "./reminders.js";

const ctx = { groupmeBotId: "bot-123" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scheduleReminder", () => {
  it("schedules a job for a future date", () => {
    const mockJob = { cancel: vi.fn() };
    mockScheduleJob.mockReturnValue(mockJob);

    const future = new Date(Date.now() + 60_000);
    scheduleReminder("r1", future, "Test reminder", ctx);

    expect(mockScheduleJob).toHaveBeenCalledWith(future, expect.any(Function));
  });

  it("fires immediately when scheduleJob returns null (past date)", () => {
    mockScheduleJob.mockReturnValue(null);
    mockSendGroupMeMessage.mockResolvedValue(undefined);

    const past = new Date(Date.now() - 60_000);
    scheduleReminder("r1", past, "Overdue reminder", ctx);

    expect(mockSendGroupMeMessage).toHaveBeenCalledWith("bot-123", "⏰ Reminder: Overdue reminder");
  });

  it("sends message and marks fired when job callback executes", async () => {
    let jobCallback: (() => Promise<void>) | undefined;
    mockScheduleJob.mockImplementation((_date: Date, cb: () => Promise<void>) => {
      jobCallback = cb;
      return { cancel: vi.fn() };
    });
    mockSendGroupMeMessage.mockResolvedValue(undefined);

    const future = new Date(Date.now() + 60_000);
    scheduleReminder("r1", future, "Fire me", ctx);

    expect(jobCallback).toBeDefined();
    await jobCallback!();

    expect(mockSendGroupMeMessage).toHaveBeenCalledWith("bot-123", "⏰ Reminder: Fire me");
    expect(mockUpdateSet).toHaveBeenCalledWith({ fired: true });
  });
});

describe("cancelScheduledReminder", () => {
  it("cancels an active job", () => {
    const mockCancel = vi.fn();
    mockScheduleJob.mockReturnValue({ cancel: mockCancel });

    scheduleReminder("r1", new Date(Date.now() + 60_000), "Cancel me", ctx);
    cancelScheduledReminder("r1");

    expect(mockCancel).toHaveBeenCalled();
  });

  it("does nothing for unknown id", () => {
    // Should not throw
    cancelScheduledReminder("nonexistent");
  });
});

describe("recoverReminders", () => {
  it("re-schedules future reminders and fires past ones", () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    const pastDate = new Date(Date.now() - 3_600_000).toISOString();

    mockSelect.mockReturnValue([
      { id: "r1", message: "Future one", dueAt: futureDate },
      { id: "r2", message: "Past one", dueAt: pastDate },
    ]);

    mockScheduleJob.mockReturnValue({ cancel: vi.fn() });
    mockSendGroupMeMessage.mockResolvedValue(undefined);

    recoverReminders(ctx);

    // Future one gets scheduled
    expect(mockScheduleJob).toHaveBeenCalledWith(
      new Date(futureDate),
      expect.any(Function),
    );

    // Past one fires immediately (sends message)
    expect(mockSendGroupMeMessage).toHaveBeenCalledWith("bot-123", "⏰ Reminder: Past one");
  });

  it("handles empty reminders list", () => {
    mockSelect.mockReturnValue([]);

    recoverReminders(ctx);

    expect(mockScheduleJob).not.toHaveBeenCalled();
    expect(mockSendGroupMeMessage).not.toHaveBeenCalled();
  });
});
