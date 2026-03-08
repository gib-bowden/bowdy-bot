import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../ai/client.js", () => ({ getClient: vi.fn() }));
vi.mock("../../logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./a11y.js", () => ({
  getInteractiveElements: vi.fn(),
  formatA11yTree: vi.fn(),
}));
vi.mock("./set-of-mark.js", () => ({
  captureWithLabels: vi.fn(),
}));
vi.mock("./actions.js", () => ({
  executeAction: vi.fn(),
  parseAction: vi.fn(),
  isActionResult: vi.fn((result: unknown) => typeof result === "object" && result !== null && "screenshot" in result),
}));

import { resolveLabel, detectSignal, executeSubTask } from "./actor.js";
import { getClient } from "../../ai/client.js";
import { getInteractiveElements, formatA11yTree } from "./a11y.js";
import { captureWithLabels } from "./set-of-mark.js";
import { executeAction, parseAction } from "./actions.js";
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
  it("resolves click by label to coordinates when bounds exist", () => {
    const result = resolveLabel(
      { action: "click", label: 1 } as never,
      elements,
    );
    expect(result).toEqual({
      action: "click",
      x: 140, // 100 + 80/2
      y: 215, // 200 + 30/2
    });
  });

  it("resolves click by label to locator when no bounds", () => {
    const result = resolveLabel(
      { action: "click", label: 2 } as never,
      elements,
    );
    expect(result).toEqual({
      action: "click",
      selector: "getByRole('link', { name: 'Home' })",
    });
  });

  it("returns error when label not found", () => {
    const result = resolveLabel(
      { action: "click", label: 99 } as never,
      elements,
    );
    expect(result).toEqual({
      error: "Label [99] not found in accessibility tree",
    });
  });

  it("resolves hover by label to coordinates when bounds exist", () => {
    const result = resolveLabel(
      { action: "hover", label: 3 } as never,
      elements,
    );
    expect(result).toEqual({
      action: "hover",
      x: 150, // 50 + 200/2
      y: 115, // 100 + 30/2
    });
  });

  it("returns error for hover with unknown label", () => {
    const result = resolveLabel(
      { action: "hover", label: 50 } as never,
      elements,
    );
    expect(result).toEqual({
      error: "Label [50] not found in accessibility tree",
    });
  });

  it("passes through actions without label field unchanged", () => {
    const action = { action: "click" as const, selector: "#my-button" };
    const result = resolveLabel(action, elements);
    expect(result).toEqual(action);
  });

  it("passes through non-click/hover actions unchanged", () => {
    const action = { action: "scroll" as const, direction: "down" as const, amount: 500 };
    const result = resolveLabel(action, elements);
    expect(result).toEqual(action);
  });
});

describe("detectSignal", () => {
  it("detects [DONE] signal", () => {
    expect(detectSignal("The task is complete. [DONE] Summary here.")).toBe("done");
  });

  it("detects [NEED_INPUT] signal", () => {
    expect(detectSignal("I need credentials. [NEED_INPUT] What is your password?")).toBe("need_input");
  });

  it("returns null for no signal", () => {
    expect(detectSignal("Let me click the button now.")).toBeNull();
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
    vi.mocked(getInteractiveElements).mockResolvedValue(elements);
    vi.mocked(formatA11yTree).mockReturnValue("[1] button \"Submit\"");
    vi.mocked(captureWithLabels).mockResolvedValue(Buffer.from("labeled-screenshot"));
  }

  it("returns success when model emits [DONE]", async () => {
    setupMocks();
    const page = mockPage();

    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "The button is already submitted. [DONE] Form was already submitted." }],
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

  it("returns needs_input when model emits [NEED_INPUT]", async () => {
    setupMocks();
    const page = mockPage();

    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "I need login credentials. [NEED_INPUT] What is your username and password?" }],
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
          content: [{ type: "text", text: "I'll click submit.\n```json\n{\"action\":\"click\",\"label\":1}\n```" }],
        });
      }
      return Promise.resolve({
        content: [{ type: "text", text: "[DONE] Form submitted successfully." }],
      });
    });
    vi.mocked(getClient).mockReturnValue({
      messages: { create: mockCreate },
    } as never);

    vi.mocked(parseAction).mockReturnValueOnce({ action: "click", label: 1 });
    vi.mocked(executeAction).mockResolvedValueOnce({
      screenshot: Buffer.from("result-screenshot"),
      metadata: { url: "https://example.com/success", title: "Success" },
    });

    const result = await executeSubTask(page, subTask, {
      url: "https://example.com",
      title: "Example",
    });

    expect(result.status).toBe("success");
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(executeAction)).toHaveBeenCalledOnce();
  });

  it("escalates after repeated failures", async () => {
    setupMocks();
    const page = mockPage();

    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "```json\n{\"action\":\"click\",\"selector\":\"#missing\"}\n```" }],
    });
    vi.mocked(getClient).mockReturnValue({
      messages: { create: mockCreate },
    } as never);

    vi.mocked(parseAction).mockReturnValue({ action: "click", selector: "#missing" });
    vi.mocked(executeAction).mockResolvedValue({ error: "Element not found" });

    const result = await executeSubTask(
      page,
      { ...subTask, maxAttempts: 5 },
      { url: "https://example.com", title: "Example" },
    );

    expect(result.status).toBe("escalate");
  });

  it("injects retry nudge after 3 consecutive errors", async () => {
    setupMocks();
    const page = mockPage();

    let callCount = 0;
    const mockCreate = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 4) {
        return Promise.resolve({
          content: [{ type: "text", text: "```json\n{\"action\":\"click\",\"selector\":\"#bad\"}\n```" }],
        });
      }
      return Promise.resolve({
        content: [{ type: "text", text: "[DONE] Finally got it." }],
      });
    });
    vi.mocked(getClient).mockReturnValue({
      messages: { create: mockCreate },
    } as never);

    vi.mocked(parseAction).mockReturnValue({ action: "click", selector: "#bad" });
    vi.mocked(executeAction).mockResolvedValue({
      screenshot: Buffer.from("error-screenshot"),
      metadata: { url: "https://example.com", title: "Example" },
      error: "Click intercepted",
    });

    const result = await executeSubTask(
      page,
      { ...subTask, maxAttempts: 6 },
      { url: "https://example.com", title: "Example" },
    );

    // Should escalate at attempt 4 (consecutive errors >= 4 after action result)
    expect(result.status).toBe("escalate");
  });
});
