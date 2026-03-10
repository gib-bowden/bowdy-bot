import { describe, it, expect, vi } from "vitest";
import { validateUrl, isTransientError, executeActionWithRetry } from "./actions.js";
import type { BrowserAction } from "./actions.js";

describe("validateUrl", () => {
  it("allows normal http/https URLs", () => {
    expect(validateUrl("https://www.google.com")).toBeNull();
    expect(validateUrl("http://example.com/path?q=1")).toBeNull();
    expect(validateUrl("https://booking.localhoney.com/appointments")).toBeNull();
  });

  it("blocks non-http schemes", () => {
    expect(validateUrl("file:///etc/passwd")).toMatch(/Blocked scheme/);
    expect(validateUrl("javascript:alert(1)")).toMatch(/Blocked scheme/);
    expect(validateUrl("ftp://example.com")).toMatch(/Blocked scheme/);
    expect(validateUrl("data:text/html,<h1>hi</h1>")).toMatch(/Blocked scheme/);
  });

  it("blocks localhost", () => {
    expect(validateUrl("http://localhost")).toMatch(/localhost/);
    expect(validateUrl("http://localhost:3000/admin")).toMatch(/localhost/);
    expect(validateUrl("http://127.0.0.1")).toMatch(/localhost/);
    expect(validateUrl("http://127.0.0.1:8080")).toMatch(/localhost/);
  });

  it("blocks cloud metadata endpoints", () => {
    expect(validateUrl("http://169.254.169.254/latest/meta-data/")).toMatch(/metadata/);
    expect(validateUrl("http://metadata.google.internal/computeMetadata/v1/")).toMatch(/metadata/);
  });

  it("blocks private IP ranges", () => {
    expect(validateUrl("http://10.0.0.1")).toMatch(/private/);
    expect(validateUrl("http://10.255.255.255")).toMatch(/private/);
    expect(validateUrl("http://172.16.0.1")).toMatch(/private/);
    expect(validateUrl("http://172.31.255.255")).toMatch(/private/);
    expect(validateUrl("http://192.168.1.1")).toMatch(/private/);
    expect(validateUrl("http://0.0.0.0")).toMatch(/private/);
  });

  it("allows public IPs that look similar to private ranges", () => {
    expect(validateUrl("http://172.32.0.1")).toBeNull();
    expect(validateUrl("http://192.169.1.1")).toBeNull();
    expect(validateUrl("http://11.0.0.1")).toBeNull();
  });

  it("rejects invalid URLs", () => {
    expect(validateUrl("not a url")).toMatch(/Invalid/);
    expect(validateUrl("")).toMatch(/Invalid/);
  });
});

describe("isTransientError", () => {
  it("matches transient error patterns", () => {
    expect(isTransientError("Timeout 30000ms exceeded")).toBe(true);
    expect(isTransientError("net::ERR_CONNECTION_RESET")).toBe(true);
    expect(isTransientError("net::ERR_CONNECTION_TIMED_OUT")).toBe(true);
    expect(isTransientError("execution context was destroyed")).toBe(true);
    expect(isTransientError("frame was detached")).toBe(true);
    expect(isTransientError("Target closed")).toBe(true);
    expect(isTransientError("Element is not stable")).toBe(true);
    expect(isTransientError("Click was intercepted by another element")).toBe(true);
  });

  it("does not match permanent errors", () => {
    expect(isTransientError("Element not found")).toBe(false);
    expect(isTransientError("click requires selector or x/y coordinates")).toBe(false);
    expect(isTransientError("Unknown action: dance")).toBe(false);
    expect(isTransientError("Blocked scheme: ftp:")).toBe(false);
  });
});

describe("executeActionWithRetry", () => {
  it("returns immediately on success", async () => {
    const mockPage = {
      mouse: { click: vi.fn() },
      url: vi.fn().mockReturnValue("https://example.com"),
      title: vi.fn().mockResolvedValue("Example"),
      screenshot: vi.fn().mockResolvedValue(Buffer.from("screenshot")),
    } as never;

    const action: BrowserAction = { action: "screenshot" };
    const result = await executeActionWithRetry(mockPage, action);
    expect(result.kind).toBe("result");
  });

  it("does not retry permanent errors", async () => {
    const screenshotFn = vi.fn().mockResolvedValue(Buffer.from("screenshot"));
    const popupHandler = { on: vi.fn(), off: vi.fn() };
    const mockPage = {
      url: vi.fn().mockReturnValue("https://example.com"),
      title: vi.fn().mockResolvedValue("Example"),
      screenshot: screenshotFn,
      mouse: { click: vi.fn().mockRejectedValue(new Error("Element not found")) },
      context: vi.fn().mockReturnValue(popupHandler),
    } as never;

    const action: BrowserAction = { action: "click", x: 100, y: 200 };
    const result = await executeActionWithRetry(mockPage, action);
    expect(result.kind).toBe("result");
    if (result.kind === "result") {
      expect(result.error).toBe("Element not found");
    }
  });
});
