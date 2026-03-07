import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing
vi.mock("../../ai/client.js", () => ({ getClient: vi.fn() }));
vi.mock("../../logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./session.js", () => ({
  getPage: vi.fn().mockResolvedValue({
    goto: vi.fn(),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake")),
    title: vi.fn().mockResolvedValue("Test"),
    url: vi.fn().mockReturnValue("https://example.com"),
  }),
}));

import { startBrowserTask, isBrowserBusy } from "./agent.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("busy lock", () => {
  it("rejects a second task while one is in progress", async () => {
    // Start a task that will hang (never resolves the AI call)
    const { getClient } = await import("../../ai/client.js");
    let resolveFirst!: (value: unknown) => void;
    const hangingPromise = new Promise((resolve) => { resolveFirst = resolve; });

    vi.mocked(getClient).mockReturnValue({
      messages: {
        create: () => hangingPromise,
      },
    } as never);

    // Start first task (will hang on the AI call)
    const first = startBrowserTask("https://example.com", "test goal");
    // Give it a tick to get past goto/screenshot and set busy=true
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(isBrowserBusy()).toBe(true);

    // Second task should be rejected immediately
    const second = await startBrowserTask("https://other.com", "other goal");
    expect(second.status).toBe("error");
    expect(second.status === "error" && second.error).toMatch(/already in progress/);

    // Clean up: resolve the hanging promise so the first task finishes
    resolveFirst({
      content: [{ type: "text", text: "[DONE] finished" }],
    });
    await first;
  });

  it("rejects tasks with blocked URLs without acquiring the lock", async () => {
    const result = await startBrowserTask("file:///etc/passwd", "read secrets");
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error).toMatch(/Blocked scheme/);
    expect(isBrowserBusy()).toBe(false);
  });
});
