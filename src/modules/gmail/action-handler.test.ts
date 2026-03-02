import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createTriageActionHandler } from "./action-handler.js";
import { generateActionHmac } from "./actions.js";

// Mock config
vi.mock("../../config.js", () => ({
  config: {
    tokenEncryptionKey: "a".repeat(64),
    logLevel: "silent",
  },
}));

// Mock logger
vi.mock("../../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock DB
const mockSession = {
  id: "SESSION123",
  accountEmail: "user@example.com",
  triageItemMap: JSON.stringify({ "1": ["msg1"], "2": ["msg2"] }),
  status: "sent",
};

vi.mock("../../db/client.js", () => {
  const mockDb = {
    select: vi.fn(() => mockDb),
    from: vi.fn(() => mockDb),
    where: vi.fn(() => mockDb),
    get: vi.fn(() => mockSession),
    all: vi.fn(() => []),
  };
  return {
    getDb: () => mockDb,
    schema: {
      emailTriageSessions: { id: "id" },
      emailTriageItems: { sessionId: "session_id", id: "id" },
    },
  };
});

// Mock executeTriageAction
vi.mock("./actions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./actions.js")>();
  return {
    ...actual,
    executeTriageAction: vi.fn(async () => ({
      success: true,
      message: 'Archived "Test Email"',
    })),
  };
});

function makeReq(url: string, method = "GET"): IncomingMessage {
  return { url, method, headers: { host: "localhost:3001" } } as unknown as IncomingMessage;
}

function makeRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: "",
    _headers: {} as Record<string, string>,
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    end(body?: string) {
      res._body = body ?? "";
      return res;
    },
  };
  return res as unknown as ServerResponse & { _status: number; _body: string };
}

describe("createTriageActionHandler", () => {
  let handler: ReturnType<typeof createTriageActionHandler>;
  const secret = "a".repeat(64);

  beforeEach(() => {
    vi.clearAllMocks();
    handler = createTriageActionHandler();
  });

  it("returns false for non-matching paths", async () => {
    const req = makeReq("/oauth/callback");
    const res = makeRes();
    const handled = await handler(req, res);
    expect(handled).toBe(false);
  });

  it("returns false for POST requests", async () => {
    const req = makeReq("/triage/action?session=x&item=1&action=archive&sig=abc", "POST");
    const res = makeRes();
    const handled = await handler(req, res);
    expect(handled).toBe(false);
  });

  it("returns 400 for missing params", async () => {
    const req = makeReq("/triage/action?session=x");
    const res = makeRes();
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(res._body).toContain("Missing required parameters");
  });

  it("returns 400 for invalid action name", async () => {
    const sig = generateActionHmac(secret, "SESSION123", "1", "delete");
    const req = makeReq(`/triage/action?session=SESSION123&item=1&action=delete&sig=${sig}`);
    const res = makeRes();
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(res._body).toContain("Invalid action");
  });

  it("returns 403 for invalid HMAC", async () => {
    const req = makeReq("/triage/action?session=SESSION123&item=1&action=archive&sig=0000000000000000");
    const res = makeRes();
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(403);
    expect(res._body).toContain("Invalid or expired");
  });

  it("returns 200 for valid action", async () => {
    const sig = generateActionHmac(secret, "SESSION123", "1", "archive");
    const req = makeReq(`/triage/action?session=SESSION123&item=1&action=archive&sig=${sig}`);
    const res = makeRes();
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(res._body).toContain("Done");
  });
});
