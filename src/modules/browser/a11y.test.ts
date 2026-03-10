import { describe, it, expect } from "vitest";
import { formatA11yTree, formatScrollContext } from "./a11y.js";
import type { A11yElement, StructuralElement } from "./types.js";

describe("formatA11yTree", () => {
  it("formats elements with bounds", () => {
    const elements: A11yElement[] = [
      { label: 1, role: "button", name: "Sign In", locator: "getByRole('button', { name: 'Sign In' })", bounds: { x: 100, y: 50, width: 80, height: 30 } },
      { label: 2, role: "textbox", name: "Email", locator: "getByRole('textbox', { name: 'Email' })", bounds: { x: 50, y: 100, width: 200, height: 25 } },
    ];

    const result = formatA11yTree(elements);
    expect(result).toBe(
      '[1] button "Sign In" (100,50 80x30)\n[2] textbox "Email" (50,100 200x25)',
    );
  });

  it("formats elements without bounds", () => {
    const elements: A11yElement[] = [
      { label: 1, role: "link", name: "Home", locator: "getByRole('link', { name: 'Home' })" },
    ];

    const result = formatA11yTree(elements);
    expect(result).toBe('[1] link "Home"');
  });

  it("returns empty string for empty array", () => {
    expect(formatA11yTree([])).toBe("");
  });

  it("rounds fractional coordinates", () => {
    const elements: A11yElement[] = [
      { label: 1, role: "checkbox", name: "Agree", locator: "getByRole('checkbox', { name: 'Agree' })", bounds: { x: 10.7, y: 20.3, width: 15.5, height: 15.5 } },
    ];

    const result = formatA11yTree(elements);
    expect(result).toBe('[1] checkbox "Agree" (11,20 16x16)');
  });

  it("handles elements with empty name", () => {
    const elements: A11yElement[] = [
      { label: 1, role: "button", name: "", locator: "getByRole('button')", bounds: { x: 0, y: 0, width: 40, height: 40 } },
    ];

    const result = formatA11yTree(elements);
    expect(result).toBe('[1] button "" (0,0 40x40)');
  });

  it("interleaves structural elements by y-position", () => {
    const elements: A11yElement[] = [
      { label: 1, role: "button", name: "Sign In", locator: "getByRole('button', { name: 'Sign In' })", bounds: { x: 100, y: 50, width: 80, height: 30 } },
      { label: 2, role: "textbox", name: "Email", locator: "getByRole('textbox', { name: 'Email' })", bounds: { x: 50, y: 200, width: 200, height: 25 } },
    ];
    const structural: StructuralElement[] = [
      { tag: "h1", text: "Welcome", bounds: { x: 0, y: 10, width: 400, height: 40 } },
      { tag: "h2", text: "Login Form", bounds: { x: 0, y: 120, width: 300, height: 30 } },
    ];

    const result = formatA11yTree(elements, structural);
    const lines = result.split("\n");
    expect(lines).toEqual([
      '--- h1 "Welcome" ---',
      '[1] button "Sign In" (100,50 80x30)',
      '--- h2 "Login Form" ---',
      '[2] textbox "Email" (50,200 200x25)',
    ]);
  });

  it("handles structural elements with empty text", () => {
    const elements: A11yElement[] = [
      { label: 1, role: "button", name: "Click", locator: "getByRole('button')", bounds: { x: 10, y: 100, width: 50, height: 30 } },
    ];
    const structural: StructuralElement[] = [
      { tag: "nav", text: "", bounds: { x: 0, y: 0, width: 1280, height: 60 } },
    ];

    const result = formatA11yTree(elements, structural);
    const lines = result.split("\n");
    expect(lines).toEqual([
      "--- nav ---",
      '[1] button "Click" (10,100 50x30)',
    ]);
  });

  it("works with empty structural array (same as no structural)", () => {
    const elements: A11yElement[] = [
      { label: 1, role: "link", name: "Home", locator: "getByRole('link', { name: 'Home' })" },
    ];

    const withEmpty = formatA11yTree(elements, []);
    const without = formatA11yTree(elements);
    expect(withEmpty).toBe(without);
  });
});

describe("formatScrollContext", () => {
  it("reports full page visible when no scrollable content", () => {
    expect(formatScrollContext({ scrollY: 0, scrollHeight: 800, viewportHeight: 800 }))
      .toBe("Viewport: full page visible (no scrollable content)");
  });

  it("reports full page visible when content is smaller than viewport", () => {
    expect(formatScrollContext({ scrollY: 0, scrollHeight: 400, viewportHeight: 800 }))
      .toBe("Viewport: full page visible (no scrollable content)");
  });

  it("reports top of page", () => {
    expect(formatScrollContext({ scrollY: 0, scrollHeight: 2000, viewportHeight: 800 }))
      .toBe("Viewport: top of page (0px / 2000px) — content below");
  });

  it("reports bottom of page", () => {
    // maxScroll = 2000 - 800 = 1200, scrollY = 1200
    expect(formatScrollContext({ scrollY: 1200, scrollHeight: 2000, viewportHeight: 800 }))
      .toBe("Viewport: bottom of page (2000px / 2000px)");
  });

  it("reports middle of page with percentage", () => {
    // maxScroll = 2000 - 800 = 1200, scrollY = 600, pct = 50%
    expect(formatScrollContext({ scrollY: 600, scrollHeight: 2000, viewportHeight: 800 }))
      .toBe("Viewport: 50% scrolled (600px / 2000px) — content above and below");
  });

  it("reports 45% scrolled", () => {
    // maxScroll = 2000 - 800 = 1200, scrollY = 540, pct = 45%
    expect(formatScrollContext({ scrollY: 540, scrollHeight: 2000, viewportHeight: 800 }))
      .toBe("Viewport: 45% scrolled (540px / 2000px) — content above and below");
  });
});
