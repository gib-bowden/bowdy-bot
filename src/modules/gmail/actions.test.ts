import { describe, it, expect } from "vitest";
import {
  generateActionUrl,
  generateActionHmac,
  verifyActionHmac,
  getActionsForCategory,
  isValidAction,
} from "./actions.js";

describe("generateActionHmac / verifyActionHmac", () => {
  const secret = "a".repeat(64);

  it("generates a 16-char hex HMAC", () => {
    const hmac = generateActionHmac(secret, "SESSION1", "1", "archive");
    expect(hmac).toMatch(/^[0-9a-f]{16}$/);
  });

  it("verifies a correct HMAC", () => {
    const hmac = generateActionHmac(secret, "SESSION1", "1", "archive");
    expect(verifyActionHmac(secret, "SESSION1", "1", "archive", hmac)).toBe(true);
  });

  it("rejects a tampered session", () => {
    const hmac = generateActionHmac(secret, "SESSION1", "1", "archive");
    expect(verifyActionHmac(secret, "SESSION2", "1", "archive", hmac)).toBe(false);
  });

  it("rejects a tampered item ref", () => {
    const hmac = generateActionHmac(secret, "SESSION1", "1", "archive");
    expect(verifyActionHmac(secret, "SESSION1", "2", "archive", hmac)).toBe(false);
  });

  it("rejects a tampered action", () => {
    const hmac = generateActionHmac(secret, "SESSION1", "1", "archive");
    expect(verifyActionHmac(secret, "SESSION1", "1", "spam", hmac)).toBe(false);
  });

  it("rejects wrong-length HMAC", () => {
    expect(verifyActionHmac(secret, "SESSION1", "1", "archive", "short")).toBe(false);
  });
});

describe("generateActionUrl", () => {
  const secret = "b".repeat(64);

  it("produces a correct URL with all params", () => {
    const url = generateActionUrl("https://bowdy.example.com", secret, "SESSION1", "3a", "archive");
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://bowdy.example.com");
    expect(parsed.pathname).toBe("/triage/action");
    expect(parsed.searchParams.get("session")).toBe("SESSION1");
    expect(parsed.searchParams.get("item")).toBe("3a");
    expect(parsed.searchParams.get("action")).toBe("archive");
    expect(parsed.searchParams.get("sig")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("generates a verifiable sig", () => {
    const url = generateActionUrl("https://bowdy.example.com", secret, "S1", "1", "keep");
    const parsed = new URL(url);
    const sig = parsed.searchParams.get("sig")!;
    expect(verifyActionHmac(secret, "S1", "1", "keep", sig)).toBe(true);
  });
});

describe("getActionsForCategory", () => {
  it("returns archive and keep for action_needed", () => {
    expect(getActionsForCategory("action_needed")).toEqual(["archive", "keep"]);
  });

  it("returns archive and keep for fyi", () => {
    expect(getActionsForCategory("fyi")).toEqual(["archive", "keep"]);
  });

  it("returns archive, keep, unsubscribe for recommend_archive", () => {
    expect(getActionsForCategory("recommend_archive")).toEqual(["archive", "keep", "unsubscribe"]);
  });

  it("returns archive and keep for unknown categories", () => {
    expect(getActionsForCategory("something_else")).toEqual(["archive", "keep"]);
  });
});

describe("isValidAction", () => {
  it("accepts valid actions", () => {
    expect(isValidAction("archive")).toBe(true);
    expect(isValidAction("keep")).toBe(true);
    expect(isValidAction("unsubscribe")).toBe(true);
    expect(isValidAction("spam")).toBe(true);
  });

  it("rejects invalid actions", () => {
    expect(isValidAction("calendar")).toBe(false);
    expect(isValidAction("task")).toBe(false);
    expect(isValidAction("delete")).toBe(false);
    expect(isValidAction("")).toBe(false);
  });
});
