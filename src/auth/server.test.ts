import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http, { createServer, type Server } from "node:http";
import { createOAuthHandler } from "./server.js";

vi.mock("../config.js", () => ({
  config: {
    googleOAuthPort: "3001",
    googleOAuthRedirectUri: "http://localhost:3001/oauth/callback",
  },
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("./google.js", () => ({
  getConsentUrl: vi.fn(() => "https://accounts.google.com/o/oauth2/auth?fake=1"),
  handleAuthCallback: vi.fn(async () => ({ email: "test@gmail.com", name: "Test User" })),
  listAccounts: vi.fn(() => []),
  removeAccount: vi.fn(),
  setDefaultAccount: vi.fn(),
}));

function fetch(
  server: Server,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === "string") return reject(new Error("no address"));

    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: addr.port,
      method,
      path,
    };

    if (body) {
      options.headers = { "Content-Type": "application/x-www-form-urlencoded" };
    }

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk.toString()));
      res.on("end", () =>
        resolve({
          status: res.statusCode!,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: data,
        }),
      );
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function startTestServer(): Promise<Server> {
  return new Promise((resolve) => {
    const handler = createOAuthHandler();
    const server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("FALLTHROUGH");
      }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

describe("createOAuthHandler", () => {
  let server: Server;

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(() => {
    server.close();
  });

  it("handles GET / and returns accounts page HTML", async () => {
    const res = await fetch(server, "GET", "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.body).toContain("Bowdy Bot");
    expect(res.body).toContain("Connect Google Account");
  });

  it("handles GET /oauth/start with a redirect to Google", async () => {
    const res = await fetch(server, "GET", "/oauth/start");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("accounts.google.com");
  });

  it("handles GET /oauth/callback with code", async () => {
    const res = await fetch(server, "GET", "/oauth/callback?code=test-code");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("msg=");
    expect(res.headers.location).toContain("Connected");
  });

  it("handles GET /oauth/callback with error param", async () => {
    const res = await fetch(server, "GET", "/oauth/callback?error=access_denied");
    expect(res.status).toBe(200);
    expect(res.body).toContain("authorization failed");
  });

  it("handles GET /oauth/callback with missing code", async () => {
    const res = await fetch(server, "GET", "/oauth/callback");
    expect(res.status).toBe(400);
    expect(res.body).toContain("Missing authorization code");
  });

  it("handles POST /oauth/remove", async () => {
    const res = await fetch(server, "POST", "/oauth/remove", "email=test%40gmail.com");
    expect(res.status).toBe(303);
    expect(res.headers.location).toContain("Removed");
  });

  it("handles POST /oauth/default", async () => {
    const res = await fetch(server, "POST", "/oauth/default", "email=test%40gmail.com");
    expect(res.status).toBe(303);
    expect(res.headers.location).toContain("set%20as%20default");
  });

  it("falls through for POST / (platform webhook route)", async () => {
    const res = await fetch(server, "POST", "/");
    expect(res.status).toBe(200);
    expect(res.body).toBe("FALLTHROUGH");
  });

  it("falls through for POST /webhook", async () => {
    const res = await fetch(server, "POST", "/webhook");
    expect(res.status).toBe(200);
    expect(res.body).toBe("FALLTHROUGH");
  });

  it("falls through for GET /some-random-path", async () => {
    const res = await fetch(server, "GET", "/some-random-path");
    expect(res.status).toBe(200);
    expect(res.body).toBe("FALLTHROUGH");
  });
});
