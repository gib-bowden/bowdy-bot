import { describe, it, expect, vi } from "vitest";
import { captureWithLabels } from "./set-of-mark.js";
import type { A11yElement } from "./types.js";

function createMockPage() {
  const evaluateFn = vi.fn().mockResolvedValue(undefined);
  const screenshotFn = vi.fn().mockResolvedValue(Buffer.from("fake-jpeg-data"));

  const page = {
    evaluate: evaluateFn,
    screenshot: screenshotFn,
  };

  return { page, evaluateFn, screenshotFn };
}

describe("captureWithLabels", () => {
  it("injects overlays, screenshots, and removes overlays", async () => {
    const { page, evaluateFn, screenshotFn } = createMockPage();

    const elements: A11yElement[] = [
      { label: 1, role: "button", name: "Submit", locator: "getByRole('button', { name: 'Submit' })", bounds: { x: 100, y: 200, width: 80, height: 30 } },
      { label: 2, role: "link", name: "Home", locator: "getByRole('link', { name: 'Home' })", bounds: { x: 50, y: 50, width: 60, height: 20 } },
    ];

    const result = await captureWithLabels(page as never, elements);

    // Should call evaluate twice: inject + remove
    expect(evaluateFn).toHaveBeenCalledTimes(2);

    // First call: inject overlays with element data
    const injectArgs = evaluateFn.mock.calls[0]!;
    // Raw bounds passed; badge is offset -16px in the evaluate callback
    expect(injectArgs[1]).toEqual([
      { label: 1, x: 100, y: 200 },
      { label: 2, x: 50, y: 50 },
    ]);

    // Should take screenshot
    expect(screenshotFn).toHaveBeenCalledWith({ type: "jpeg", quality: 70 });

    // Should return the screenshot buffer
    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString()).toBe("fake-jpeg-data");
  });

  it("skips elements without bounds", async () => {
    const { page, evaluateFn } = createMockPage();

    const elements: A11yElement[] = [
      { label: 1, role: "button", name: "Visible", locator: "getByRole('button')", bounds: { x: 10, y: 20, width: 30, height: 15 } },
      { label: 2, role: "link", name: "Hidden", locator: "getByRole('link')" },
    ];

    await captureWithLabels(page as never, elements);

    const injectArgs = evaluateFn.mock.calls[0]!;
    expect(injectArgs[1]).toEqual([
      { label: 1, x: 10, y: 20 },
    ]);
  });

  it("handles empty elements array", async () => {
    const { page, evaluateFn, screenshotFn } = createMockPage();

    await captureWithLabels(page as never, []);

    expect(evaluateFn).toHaveBeenCalledTimes(2);
    expect(evaluateFn.mock.calls[0]![1]).toEqual([]);
    expect(screenshotFn).toHaveBeenCalled();
  });
});
