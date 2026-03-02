import { describe, it, expect, vi } from "vitest";

vi.mock("../../config.js", () => ({ config: {} }));
vi.mock("../../ai/client.js", () => ({ getClient: vi.fn() }));
vi.mock("../../db/client.js", () => ({ getDb: vi.fn(), schema: {} }));
vi.mock("../../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { extractEmailAddress, normalizeSubject, groupBySender } from "./triage.js";
import type { ClassifiedEmail } from "./classify.js";

function makeEmail(overrides: {
  id?: string;
  sender?: string;
  subject?: string;
  threadId?: string;
}): ClassifiedEmail {
  return {
    message: {
      id: overrides.id ?? "msg-1",
      threadId: overrides.threadId ?? "thread-1",
      subject: overrides.subject ?? "Test Subject",
      sender: overrides.sender ?? "Test User <test@example.com>",
      snippet: "snippet",
      receivedAt: "2024-01-01T00:00:00Z",
      labelIds: ["INBOX"],
    },
    category: "fyi",
    summary: "summary",
    suggestedAction: "archive",
    ruleApplied: false,
  };
}

describe("extractEmailAddress", () => {
  it("extracts email from angle bracket format", () => {
    expect(extractEmailAddress("John Doe <john@example.com>")).toBe("john@example.com");
  });

  it("returns bare email as-is (lowercased)", () => {
    expect(extractEmailAddress("John@Example.com")).toBe("john@example.com");
  });

  it("trims whitespace", () => {
    expect(extractEmailAddress("  user@test.com  ")).toBe("user@test.com");
  });
});

describe("normalizeSubject", () => {
  it("strips Re: prefix", () => {
    expect(normalizeSubject("Re: Hello")).toBe("hello");
  });

  it("strips Fwd: prefix", () => {
    expect(normalizeSubject("Fwd: Hello")).toBe("hello");
  });

  it("strips Fw: prefix", () => {
    expect(normalizeSubject("Fw: Hello")).toBe("hello");
  });

  it("is case insensitive", () => {
    expect(normalizeSubject("RE: Hello")).toBe("hello");
    expect(normalizeSubject("FWD: Hello")).toBe("hello");
  });

  it("returns plain subject lowercased", () => {
    expect(normalizeSubject("Meeting Tomorrow")).toBe("meeting tomorrow");
  });
});

describe("groupBySender", () => {
  it("groups emails from the same sender", () => {
    const items = [
      makeEmail({ id: "1", sender: "Alice <alice@test.com>", subject: "A" }),
      makeEmail({ id: "2", sender: "Alice <alice@test.com>", subject: "B" }),
    ];
    const groups = groupBySender(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(2);
    expect(groups[0]!.senderEmail).toBe("alice@test.com");
  });

  it("separates emails from different senders", () => {
    const items = [
      makeEmail({ id: "1", sender: "Alice <alice@test.com>" }),
      makeEmail({ id: "2", sender: "Bob <bob@test.com>" }),
    ];
    const groups = groupBySender(items);
    expect(groups).toHaveLength(2);
  });

  it("preserves insertion order", () => {
    const items = [
      makeEmail({ id: "1", sender: "Alice <alice@test.com>" }),
      makeEmail({ id: "2", sender: "Bob <bob@test.com>" }),
      makeEmail({ id: "3", sender: "Alice <alice@test.com>" }),
    ];
    const groups = groupBySender(items);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.senderEmail).toBe("alice@test.com");
    expect(groups[1]!.senderEmail).toBe("bob@test.com");
  });

  it("marks identical subjects as identicalSubjects=true", () => {
    const items = [
      makeEmail({ id: "1", sender: "Alice <alice@test.com>", subject: "Same" }),
      makeEmail({ id: "2", sender: "Alice <alice@test.com>", subject: "Same" }),
    ];
    const groups = groupBySender(items);
    expect(groups[0]!.identicalSubjects).toBe(true);
  });

  it("marks different subjects as identicalSubjects=false", () => {
    const items = [
      makeEmail({ id: "1", sender: "Alice <alice@test.com>", subject: "One" }),
      makeEmail({ id: "2", sender: "Alice <alice@test.com>", subject: "Two" }),
    ];
    const groups = groupBySender(items);
    expect(groups[0]!.identicalSubjects).toBe(false);
  });

  it("treats Re:/Fwd: variants as identical subjects", () => {
    const items = [
      makeEmail({ id: "1", sender: "Alice <alice@test.com>", subject: "Meeting" }),
      makeEmail({ id: "2", sender: "Alice <alice@test.com>", subject: "Re: Meeting" }),
    ];
    const groups = groupBySender(items);
    expect(groups[0]!.identicalSubjects).toBe(true);
  });

  it("single item group has identicalSubjects=true", () => {
    const items = [makeEmail({ id: "1", sender: "Alice <alice@test.com>" })];
    const groups = groupBySender(items);
    expect(groups[0]!.identicalSubjects).toBe(true);
  });
});
