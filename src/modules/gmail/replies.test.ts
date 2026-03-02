import { describe, it, expect, vi } from "vitest";

vi.mock("../../config.js", () => ({ config: {} }));
vi.mock("../../ai/client.js", () => ({ getClient: vi.fn() }));
vi.mock("../../db/client.js", () => ({ getDb: vi.fn(), schema: {} }));
vi.mock("../../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { parseSimpleReply, parseItemReferences } from "./replies.js";

describe("parseItemReferences", () => {
  it("parses a single number", () => {
    expect(parseItemReferences("1")).toEqual(["1"]);
  });

  it("parses a number with letter suffix", () => {
    expect(parseItemReferences("4a")).toEqual(["4a"]);
  });

  it("parses comma-separated numbers", () => {
    expect(parseItemReferences("1,2,3")).toEqual(["1", "2", "3"]);
  });

  it("parses comma-separated refs with letter suffixes", () => {
    expect(parseItemReferences("4a, 4c")).toEqual(["4a", "4c"]);
  });

  it("parses numeric ranges", () => {
    expect(parseItemReferences("2-5")).toEqual(["2", "3", "4", "5"]);
  });

  it("parses mixed refs and ranges", () => {
    expect(parseItemReferences("1, 3-5, 7a")).toEqual(["1", "3", "4", "5", "7a"]);
  });

  it("ignores invalid parts", () => {
    expect(parseItemReferences("abc, 1")).toEqual(["1"]);
  });

  it("lowercases letter suffixes", () => {
    expect(parseItemReferences("4A")).toEqual(["4a"]);
  });
});

describe("parseSimpleReply", () => {
  it("parses a single action", () => {
    expect(parseSimpleReply("1 archive")).toEqual([
      { itemRef: "1", action: "archive" },
    ]);
  });

  it("parses multiple items with same action", () => {
    expect(parseSimpleReply("1,2,3 archive")).toEqual([
      { itemRef: "1", action: "archive" },
      { itemRef: "2", action: "archive" },
      { itemRef: "3", action: "archive" },
    ]);
  });

  it("parses multi-line replies with different actions", () => {
    const text = "1 archive\n2 calendar\n3 task";
    expect(parseSimpleReply(text)).toEqual([
      { itemRef: "1", action: "archive" },
      { itemRef: "2", action: "calendar" },
      { itemRef: "3", action: "task" },
    ]);
  });

  it("parses letter-suffixed refs", () => {
    expect(parseSimpleReply("4a,4c archive")).toEqual([
      { itemRef: "4a", action: "archive" },
      { itemRef: "4c", action: "archive" },
    ]);
  });

  it("parses ranges", () => {
    expect(parseSimpleReply("1-3 archive")).toEqual([
      { itemRef: "1", action: "archive" },
      { itemRef: "2", action: "archive" },
      { itemRef: "3", action: "archive" },
    ]);
  });

  it("is case insensitive for actions", () => {
    expect(parseSimpleReply("1 ARCHIVE")).toEqual([
      { itemRef: "1", action: "archive" },
    ]);
  });

  it("handles all valid actions", () => {
    const actions = ["archive", "calendar", "task", "keep", "unsubscribe", "spam"];
    for (const action of actions) {
      const result = parseSimpleReply(`1 ${action}`);
      expect(result).toEqual([{ itemRef: "1", action }]);
    }
  });

  it("ignores lines that are not commands", () => {
    expect(parseSimpleReply("hello archive")).toEqual([]);
    expect(parseSimpleReply("please archive these")).toEqual([]);
    expect(parseSimpleReply("")).toEqual([]);
  });

  it("ignores lines with unknown actions", () => {
    expect(parseSimpleReply("1 delete")).toEqual([]);
  });

  it("skips blank lines", () => {
    const text = "1 archive\n\n\n2 keep";
    expect(parseSimpleReply(text)).toEqual([
      { itemRef: "1", action: "archive" },
      { itemRef: "2", action: "keep" },
    ]);
  });
});
