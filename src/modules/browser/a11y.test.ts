import { describe, it, expect } from "vitest";
import { formatA11yTree } from "./a11y.js";
import type { A11yElement } from "./types.js";

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
});
