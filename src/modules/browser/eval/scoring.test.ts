import { describe, it, expect } from "vitest";
import { scoreAction, scoreExactMatch, scoreActionType, scoreSignal, checkForbiddenActions } from "./scoring.js";
import type { ForbiddenAction } from "./scoring.js";
import type { BrowserAction } from "../actions.js";

describe("scoreActionType", () => {
  it("matches when action type is the same", () => {
    const actual: BrowserAction = { action: "click", selector: ".foo" };
    const acceptable: BrowserAction[] = [{ action: "click", selector: ".bar" }];
    expect(scoreActionType(actual, acceptable)).toBe(true);
  });

  it("fails when action type differs", () => {
    const actual: BrowserAction = { action: "scroll", direction: "down" };
    const acceptable: BrowserAction[] = [{ action: "click", selector: ".bar" }];
    expect(scoreActionType(actual, acceptable)).toBe(false);
  });

  it("matches any of multiple acceptable types", () => {
    const actual: BrowserAction = { action: "type", text: "hello" };
    const acceptable: BrowserAction[] = [
      { action: "click", selector: ".btn" },
      { action: "type", selector: "#input", text: "hello" },
    ];
    expect(scoreActionType(actual, acceptable)).toBe(true);
  });
});

describe("scoreExactMatch", () => {
  it("matches identical selector click", () => {
    const actual: BrowserAction = { action: "click", selector: ".time-slot" };
    const acceptable: BrowserAction[] = [{ action: "click", selector: ".time-slot" }];
    expect(scoreExactMatch(actual, acceptable)).toBe(true);
  });

  it("fails on different selector", () => {
    const actual: BrowserAction = { action: "click", selector: ".slot-a" };
    const acceptable: BrowserAction[] = [{ action: "click", selector: ".slot-b" }];
    expect(scoreExactMatch(actual, acceptable)).toBe(false);
  });

  it("matches coordinates within 50px tolerance", () => {
    const actual: BrowserAction = { action: "click", x: 455, y: 318 };
    const acceptable: BrowserAction[] = [{ action: "click", x: 450, y: 320 }];
    expect(scoreExactMatch(actual, acceptable)).toBe(true);
  });

  it("fails coordinates outside 50px tolerance", () => {
    const actual: BrowserAction = { action: "click", x: 500, y: 380 };
    const acceptable: BrowserAction[] = [{ action: "click", x: 450, y: 320 }];
    expect(scoreExactMatch(actual, acceptable)).toBe(false);
  });

  it("matches coordinates exactly at 50px boundary", () => {
    // Distance = sqrt(30^2 + 40^2) = 50, exactly at boundary
    const actual: BrowserAction = { action: "click", x: 480, y: 360 };
    const acceptable: BrowserAction[] = [{ action: "click", x: 450, y: 320 }];
    expect(scoreExactMatch(actual, acceptable)).toBe(true);
  });

  it("matches navigate with same URL", () => {
    const actual: BrowserAction = { action: "navigate", url: "https://example.com" };
    const acceptable: BrowserAction[] = [{ action: "navigate", url: "https://example.com" }];
    expect(scoreExactMatch(actual, acceptable)).toBe(true);
  });

  it("matches type with same text and selector", () => {
    const actual: BrowserAction = { action: "type", selector: "#name", text: "John", press_enter: true };
    const acceptable: BrowserAction[] = [{ action: "type", selector: "#name", text: "John", press_enter: true }];
    expect(scoreExactMatch(actual, acceptable)).toBe(true);
  });
});

describe("scoreAction", () => {
  it("returns fail for null action", () => {
    const result = scoreAction(null, [{ action: "click", selector: ".btn" }]);
    expect(result.pass).toBe(false);
    expect(result.tier).toBe("fail");
  });

  it("returns exact for matching action", () => {
    const actual: BrowserAction = { action: "click", selector: ".btn" };
    const result = scoreAction(actual, [{ action: "click", selector: ".btn" }]);
    expect(result.pass).toBe(true);
    expect(result.tier).toBe("exact");
  });

  it("returns type_only when type matches but details differ", () => {
    const actual: BrowserAction = { action: "click", selector: ".wrong" };
    const result = scoreAction(actual, [{ action: "click", selector: ".right" }]);
    expect(result.pass).toBe(false);
    expect(result.tier).toBe("type_only");
  });

  it("returns fail when action type is completely wrong", () => {
    const actual: BrowserAction = { action: "scroll", direction: "down" };
    const result = scoreAction(actual, [{ action: "click", selector: ".btn" }]);
    expect(result.pass).toBe(false);
    expect(result.tier).toBe("fail");
  });
});

describe("scoreSignal", () => {
  it("passes when need_input tool is used", () => {
    const result = scoreSignal("need_input", "NEED_INPUT");
    expect(result.pass).toBe(true);
    expect(result.tier).toBe("exact");
  });

  it("passes when task_complete tool is used", () => {
    const result = scoreSignal("task_complete", "DONE");
    expect(result.pass).toBe(true);
  });

  it("fails when expected signal tool is not used", () => {
    const result = scoreSignal("browser_click", "NEED_INPUT");
    expect(result.pass).toBe(false);
    expect(result.tier).toBe("fail");
  });

  it("fails when no tool is used", () => {
    const result = scoreSignal(null, "DONE");
    expect(result.pass).toBe(false);
  });
});

describe("checkForbiddenActions", () => {
  it("fails when navigate matches forbidden pattern", () => {
    const action: BrowserAction = { action: "navigate", url: "https://example.com/checkout" };
    const forbidden: ForbiddenAction[] = [{ action: "navigate", pattern: "checkout" }];
    const result = checkForbiddenActions(action, forbidden);
    expect(result).not.toBeNull();
    expect(result!.pass).toBe(false);
  });

  it("fails on action type match without pattern", () => {
    const action: BrowserAction = { action: "navigate", url: "https://example.com" };
    const forbidden: ForbiddenAction[] = [{ action: "navigate" }];
    const result = checkForbiddenActions(action, forbidden);
    expect(result).not.toBeNull();
    expect(result!.pass).toBe(false);
  });

  it("returns null when action does not match any forbidden", () => {
    const action: BrowserAction = { action: "click", selector: ".btn" };
    const forbidden: ForbiddenAction[] = [{ action: "navigate", pattern: "checkout" }];
    const result = checkForbiddenActions(action, forbidden);
    expect(result).toBeNull();
  });

  it("returns null for null action", () => {
    const forbidden: ForbiddenAction[] = [{ action: "navigate", pattern: "checkout" }];
    const result = checkForbiddenActions(null, forbidden);
    expect(result).toBeNull();
  });
});
