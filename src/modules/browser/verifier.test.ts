import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../ai/client.js", () => ({ getClient: vi.fn() }));

import { parseVerifierResponse, verify } from "./verifier.js";
import { getClient } from "../../ai/client.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseVerifierResponse", () => {
  it("parses PASS with description", () => {
    const result = parseVerifierResponse("PASS The page shows the search results for 'cats'.");
    expect(result.pass).toBe(true);
    expect(result.description).toBe("The page shows the search results for 'cats'.");
  });

  it("parses PASS with dash separator", () => {
    const result = parseVerifierResponse("PASS — Login form is visible");
    expect(result.pass).toBe(true);
    expect(result.description).toBe("Login form is visible");
  });

  it("parses PASS with colon separator", () => {
    const result = parseVerifierResponse("PASS: Form submitted successfully");
    expect(result.pass).toBe(true);
    expect(result.description).toBe("Form submitted successfully");
  });

  it("parses PASS with no description", () => {
    const result = parseVerifierResponse("PASS");
    expect(result.pass).toBe(true);
    expect(result.description).toBe("");
  });

  it("parses FAIL with description", () => {
    const result = parseVerifierResponse("FAIL The page still shows the login form.");
    expect(result.pass).toBe(false);
    expect(result.description).toBe("The page still shows the login form.");
  });

  it("parses FAIL with no description", () => {
    const result = parseVerifierResponse("FAIL");
    expect(result.pass).toBe(false);
    expect(result.description).toBe("");
  });

  it("treats unexpected format as FAIL", () => {
    const result = parseVerifierResponse("I'm not sure what happened here.");
    expect(result.pass).toBe(false);
    expect(result.description).toBe("I'm not sure what happened here.");
  });

  it("handles leading whitespace", () => {
    const result = parseVerifierResponse("  PASS Page loaded correctly");
    expect(result.pass).toBe(true);
    expect(result.description).toBe("Page loaded correctly");
  });
});

describe("verify", () => {
  it("calls Anthropic API and returns parsed result", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "PASS The search results page is displayed." }],
    });
    vi.mocked(getClient).mockReturnValue({
      messages: { create: mockCreate },
    } as never);

    const screenshot = Buffer.from("fake-screenshot");
    const result = await verify(screenshot, "Search results should be visible", {
      url: "https://example.com/search",
      title: "Search Results",
    });

    expect(result.pass).toBe(true);
    expect(result.description).toBe("The search results page is displayed.");
    expect(result.screenshot).toBe(screenshot);

    expect(mockCreate).toHaveBeenCalledOnce();
    const call = mockCreate.mock.calls[0]![0];
    expect(call.model).toBe("claude-haiku-4-5-20251001");
    expect(call.max_tokens).toBe(128);
    expect(call.temperature).toBe(0);
  });

  it("returns fail for FAIL response", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "FAIL Still on the login page." }],
    });
    vi.mocked(getClient).mockReturnValue({
      messages: { create: mockCreate },
    } as never);

    const result = await verify(Buffer.from("fake"), "Should be on dashboard", {
      url: "https://example.com/login",
      title: "Login",
    });

    expect(result.pass).toBe(false);
    expect(result.description).toBe("Still on the login page.");
  });
});
