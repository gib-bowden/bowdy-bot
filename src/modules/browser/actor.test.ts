import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../ai/client.js", () => ({ getClient: vi.fn() }));
vi.mock("../../logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./a11y.js", () => ({
  getPageSnapshot: vi.fn(),
  getScrollPosition: vi.fn(),
  formatScrollContext: vi.fn(),
  formatA11yTree: vi.fn(),
}));
vi.mock("./set-of-mark.js", () => ({
  captureWithLabels: vi.fn(),
}));
vi.mock("./actions.js", () => ({
  executeActionWithRetry: vi.fn(),
  isActionResult: vi.fn((result: unknown) => typeof result === "object" && result !== null && (result as Record<string, unknown>).kind === "result"),
  takeScreenshot: vi.fn().mockResolvedValue(Buffer.from("screenshot")),
}));

import { resolveLabel, toolToBrowserAction, executeSubTask } from "./actor.js";
import { getClient } from "../../ai/client.js";
import { getPageSnapshot, getScrollPosition, formatScrollContext, formatA11yTree } from "./a11y.js";
import { captureWithLabels } from "./set-of-mark.js";
import { executeActionWithRetry } from "./actions.js";
import type { A11yElement, SubTask } from "./types.js";

beforeEach(() => {
  vi.clearAllMocks();
});

const elements: A11yElement[] = [
  {
    label: 1,
    role: "button",
    name: "Submit",
    locator: "getByRole('button', { name: 'Submit' })",
    bounds: { x: 100, y: 200, width: 80, height: 30 },
  },
  {
    label: 2,
    role: "link",
    name: "Home",
    locator: "getByRole('link', { name: 'Home' })",
    // No bounds — will fall back to locator
  },
  {
    label: 3,
    role: "textbox",
    name: "Search",
    locator: "getByRole('textbox', { name: 'Search' })",
    bounds: { x: 50, y: 100, width: 200, height: 30 },
  },
];

describe("resolveLabel", () => {
  it("resolves click by label to coordinates when bounds exist", async () => {
    const result = await resolveLabel(
      { action: "click", label: 1 } as never,
      elements,
    );
    expect(result).toEqual({
      action: "click",
      x: 140, // 100 + 80/2
      y: 215, // 200 + 30/2
    });
  });

  it("resolves click by label to locator when no bounds", async () => {
    const result = await resolveLabel(
      { action: "click", label: 2 } as never,
      elements,
    );
    expect(result).toEqual({
      action: "click",
      selector: "getByRole('link', { name: 'Home' })",
    });
  });

  it("returns error when label not found", async () => {
    const result = await resolveLabel(
      { action: "click", label: 99 } as never,
      elements,
    );
    expect(result).toEqual({
      error: "Label [99] not found in accessibility tree",
    });
  });

  it("resolves hover by label to coordinates when bounds exist", async () => {
    const result = await resolveLabel(
      { action: "hover", label: 3 } as never,
      elements,
    );
    expect(result).toEqual({
      action: "hover",
      x: 150, // 50 + 200/2
      y: 115, // 100 + 30/2
    });
  });

  it("returns error for hover with unknown label", async () => {
    const result = await resolveLabel(
      { action: "hover", label: 50 } as never,
      elements,
    );
    expect(result).toEqual({
      error: "Label [50] not found in accessibility tree",
    });
  });

  it("passes through actions without label field unchanged", async () => {
    const action = { action: "click" as const, selector: "#my-button" };
    const result = await resolveLabel(action, elements);
    expect(result).toEqual(action);
  });

  it("passes through non-click/hover actions unchanged", async () => {
    const action = { action: "scroll" as const, direction: "down" as const, amount: 500 };
    const result = await resolveLabel(action, elements);
    expect(result).toEqual(action);
  });

  it("uses fresh coordinates from page when available", async () => {
    const mockPage = {
      getByRole: vi.fn().mockReturnValue({
        first: () => ({
          boundingBox: vi.fn().mockResolvedValue({ x: 110, y: 210, width: 80, height: 30 }),
        }),
      }),
    };

    const result = await resolveLabel(
      { action: "click", label: 1 } as never,
      elements,
      mockPage as never,
    );
    expect(result).toEqual({
      action: "click",
      x: 150, // 110 + 80/2
      y: 225, // 210 + 30/2
    });
  });

  it("falls back to cached bounds when fresh lookup fails", async () => {
    const mockPage = {
      getByRole: vi.fn().mockReturnValue({
        first: () => ({
          boundingBox: vi.fn().mockRejectedValue(new Error("timeout")),
        }),
      }),
    };

    const result = await resolveLabel(
      { action: "click", label: 1 } as never,
      elements,
      mockPage as never,
    );
    // Falls back to cached bounds: 100 + 80/2 = 140, 200 + 30/2 = 215
    expect(result).toEqual({
      action: "click",
      x: 140,
      y: 215,
    });
  });
});

describe("toolToBrowserAction", () => {
  it("converts browser_click to click action", () => {
    expect(toolToBrowserAction("browser_click", { label: 3 })).toEqual({ action: "click", label: 3 });
  });

  it("converts browser_type to type action", () => {
    expect(toolToBrowserAction("browser_type", { text: "hello", press_enter: true })).toEqual({
      action: "type", text: "hello", press_enter: true,
    });
  });

  it("converts browser_navigate to navigate action", () => {
    expect(toolToBrowserAction("browser_navigate", { url: "https://example.com" })).toEqual({
      action: "navigate", url: "https://example.com",
    });
  });

  it("converts browser_go_back to go_back action", () => {
    expect(toolToBrowserAction("browser_go_back", {})).toEqual({ action: "go_back" });
  });

  it("returns null for signal tools", () => {
    expect(toolToBrowserAction("task_complete", { summary: "done" })).toBeNull();
    expect(toolToBrowserAction("need_input", { question: "?" })).toBeNull();
  });

  it("returns null for unknown tools", () => {
    expect(toolToBrowserAction("unknown_tool", {})).toBeNull();
  });
});

describe("executeSubTask", () => {
  const subTask: SubTask = {
    id: "test-1",
    instruction: "Click the submit button",
    successCriteria: "Form submitted",
    maxAttempts: 5,
  };

  function mockPage() {
    return {
      url: vi.fn().mockReturnValue("https://example.com"),
      title: vi.fn().mockResolvedValue("Example"),
      screenshot: vi.fn().mockResolvedValue(Buffer.from("screenshot")),
    } as never;
  }

  function setupMocks() {
    vi.mocked(getPageSnapshot).mockResolvedValue({ interactive: elements, structural: [] });
    vi.mocked(getScrollPosition).mockResolvedValue({ scrollY: 0, scrollHeight: 800, viewportHeight: 800 });
    vi.mocked(formatScrollContext).mockReturnValue("Viewport: full page visible (no scrollable content)");
    vi.mocked(formatA11yTree).mockReturnValue("[1] button \"Submit\"");
    vi.mocked(captureWithLabels).mockResolvedValue(Buffer.from("labeled-screenshot"));
  }

  it("returns success when model emits task_complete", async () => {
    setupMocks();
    const page = mockPage();

    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "The button is already submitted." },
        { type: "tool_use", id: "toolu_1", name: "task_complete", input: { summary: "Form was already submitted." } },
      ],
    });
    vi.mocked(getClient).mockReturnValue({
      messages: { create: mockCreate },
    } as never);

    const result = await executeSubTask(page, subTask, {
      url: "https://example.com",
      title: "Example",
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.summary).toBe("Form was already submitted.");
    }
  });

  it("returns needs_input when model emits need_input", async () => {
    setupMocks();
    const page = mockPage();

    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "I need login credentials." },
        { type: "tool_use", id: "toolu_1", name: "need_input", input: { question: "What is your username and password?" } },
      ],
    });
    vi.mocked(getClient).mockReturnValue({
      messages: { create: mockCreate },
    } as never);

    const result = await executeSubTask(page, subTask, {
      url: "https://example.com",
      title: "Example",
    });

    expect(result.status).toBe("needs_input");
    if (result.status === "needs_input") {
      expect(result.question).toBe("What is your username and password?");
    }
  });

  it("executes action and loops on success", async () => {
    setupMocks();
    const page = mockPage();

    let callCount = 0;
    const mockCreate = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          content: [
            { type: "text", text: "I'll click submit." },
            { type: "tool_use", id: "toolu_1", name: "browser_click", input: { label: 1 } },
          ],
        });
      }
      return Promise.resolve({
        content: [
          { type: "text", text: "Form submitted." },
          { type: "tool_use", id: "toolu_2", name: "task_complete", input: { summary: "Form submitted successfully." } },
        ],
      });
    });
    vi.mocked(getClient).mockReturnValue({
      messages: { create: mockCreate },
    } as never);

    vi.mocked(executeActionWithRetry).mockResolvedValueOnce({
      kind: "result",
      screenshot: Buffer.from("result-screenshot"),
      metadata: { url: "https://example.com/success", title: "Success" },
    });

    const result = await executeSubTask(page, subTask, {
      url: "https://example.com",
      title: "Example",
    });

    expect(result.status).toBe("success");
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(executeActionWithRetry)).toHaveBeenCalledOnce();
  });

  it("escalates after repeated failures", async () => {
    setupMocks();
    const page = mockPage();

    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "Clicking the missing element." },
        { type: "tool_use", id: "toolu_1", name: "browser_click", input: { selector: "#missing" } },
      ],
    });
    vi.mocked(getClient).mockReturnValue({
      messages: { create: mockCreate },
    } as never);

    vi.mocked(executeActionWithRetry).mockResolvedValue({ kind: "error", error: "Element not found" });

    const result = await executeSubTask(
      page,
      { ...subTask, maxAttempts: 5 },
      { url: "https://example.com", title: "Example" },
    );

    expect(result.status).toBe("escalate");
  });

  it("rejects task_complete on chrome-error page", async () => {
    setupMocks();
    const page = mockPage();

    // First call: model claims task_complete on an error page
    // Second call: model tries again and completes properly
    let callCount = 0;
    const mockCreate = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // page.url() will return chrome-error for first task_complete
        (page as unknown as { url: ReturnType<typeof vi.fn> }).url.mockReturnValue("chrome-error://chromewebdata/");
        return Promise.resolve({
          content: [
            { type: "text", text: "Task done." },
            { type: "tool_use", id: "toolu_1", name: "task_complete", input: { summary: "Navigated successfully." } },
          ],
        });
      }
      // After rejection, page recovers
      (page as unknown as { url: ReturnType<typeof vi.fn> }).url.mockReturnValue("https://example.com");
      return Promise.resolve({
        content: [
          { type: "text", text: "Recovered." },
          { type: "tool_use", id: "toolu_2", name: "task_complete", input: { summary: "Actually done now." } },
        ],
      });
    });
    vi.mocked(getClient).mockReturnValue({
      messages: { create: mockCreate },
    } as never);

    const result = await executeSubTask(page, subTask, {
      url: "https://example.com",
      title: "Example",
    });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.summary).toBe("Actually done now.");
    }
  });

  it("injects retry nudge after 3 consecutive errors", async () => {
    setupMocks();
    const page = mockPage();

    let callCount = 0;
    const mockCreate = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 4) {
        return Promise.resolve({
          content: [
            { type: "text", text: "Trying again." },
            { type: "tool_use", id: `toolu_${callCount}`, name: "browser_click", input: { selector: "#bad" } },
          ],
        });
      }
      return Promise.resolve({
        content: [
          { type: "text", text: "Done." },
          { type: "tool_use", id: "toolu_5", name: "task_complete", input: { summary: "Finally got it." } },
        ],
      });
    });
    vi.mocked(getClient).mockReturnValue({
      messages: { create: mockCreate },
    } as never);

    vi.mocked(executeActionWithRetry).mockResolvedValue({
      kind: "result",
      screenshot: Buffer.from("error-screenshot"),
      metadata: { url: "https://example.com", title: "Example" },
      error: "Click intercepted",
    });

    const result = await executeSubTask(
      page,
      { ...subTask, maxAttempts: 6 },
      { url: "https://example.com", title: "Example" },
    );

    // Should escalate at consecutive errors >= 4
    expect(result.status).toBe("escalate");
  });

  it("returns escalation with blockedUrl when popupFailedUrl is set", async () => {
    setupMocks();
    const page = mockPage();

    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "I'll click the reservation link." },
        { type: "tool_use", id: "toolu_1", name: "browser_click", input: { label: 1 } },
      ],
    });
    vi.mocked(getClient).mockReturnValue({
      messages: { create: mockCreate },
    } as never);

    vi.mocked(executeActionWithRetry).mockResolvedValueOnce({
      kind: "result",
      screenshot: Buffer.from("result-screenshot"),
      metadata: { url: "https://example.com", title: "Example" },
      unchanged: true,
      popupFailedUrl: "https://blocked-site.com/reserve",
    });

    const result = await executeSubTask(page, subTask, {
      url: "https://example.com",
      title: "Example",
    });

    // Should immediately escalate with the blocked URL — no second API call
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("escalate");
    if (result.status === "escalate") {
      expect(result.blockedUrl).toBe("https://blocked-site.com/reserve");
      expect(result.reason).toContain("blocked our browser");
    }
  });

  it("immediately escalates with blockedUrl on first navigate blocking error", async () => {
    setupMocks();
    const page = mockPage();

    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "I'll navigate to OpenTable." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "browser_navigate",
          input: { url: "https://www.opentable.com/r/folk-nashville" },
        },
      ],
    });
    vi.mocked(getClient).mockReturnValue({
      messages: { create: mockCreate },
    } as never);

    vi.mocked(executeActionWithRetry).mockResolvedValueOnce({
      kind: "result",
      screenshot: Buffer.from("error-screenshot"),
      metadata: { url: "https://duckduckgo.com", title: "Search" },
      error: "page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://www.opentable.com/r/folk-nashville",
    });

    const result = await executeSubTask(page, subTask, {
      url: "https://duckduckgo.com",
      title: "Search",
    });

    // Should immediately escalate — no retries, no second API call
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("escalate");
    if (result.status === "escalate") {
      expect(result.blockedUrl).toBe("https://www.opentable.com/r/folk-nashville");
      expect(result.reason).toContain("blocking our browser");
      expect(result.failedDomains).toContain("www.opentable.com");
    }
  });

  it("immediately escalates when actor navigates to a blocked domain", async () => {
    setupMocks();
    const page = mockPage();

    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "I'll navigate to OpenTable." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "browser_navigate",
          input: { url: "https://www.opentable.com/r/folk" },
        },
      ],
    });
    vi.mocked(getClient).mockReturnValue({
      messages: { create: mockCreate },
    } as never);

    const blockedDomains = new Set(["www.opentable.com"]);

    const result = await executeSubTask(
      page,
      subTask,
      { url: "https://example.com", title: "Example" },
      blockedDomains,
    );

    // Should escalate without calling executeAction
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(executeActionWithRetry).not.toHaveBeenCalled();
    expect(result.status).toBe("escalate");
    if (result.status === "escalate") {
      expect(result.blockedUrl).toBe("https://www.opentable.com/r/folk");
      expect(result.failedDomains).toContain("www.opentable.com");
    }
  });

  it("passes tools and tool_choice to API call", async () => {
    setupMocks();
    const page = mockPage();

    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        { type: "tool_use", id: "toolu_1", name: "task_complete", input: { summary: "Done" } },
      ],
    });
    vi.mocked(getClient).mockReturnValue({
      messages: { create: mockCreate },
    } as never);

    await executeSubTask(page, subTask, {
      url: "https://example.com",
      title: "Example",
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "browser_click" }),
          expect.objectContaining({ name: "task_complete" }),
          expect.objectContaining({ name: "need_input" }),
        ]),
        tool_choice: { type: "auto" },
      }),
    );
  });
});
