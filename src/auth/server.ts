import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";
import { config } from "../config.js";
import { logger } from "../logger.js";
import {
  getConsentUrl,
  handleAuthCallback,
  listAccounts,
  removeAccount,
  setDefaultAccount,
} from "./google.js";
import {
  getKrogerConsentUrl,
  handleKrogerCallback,
  listKrogerAccounts,
} from "./kroger.js";

export type RequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function html(body: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Bowdy Bot — Accounts</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 1.4em; }
  h2 { font-size: 1.1em; margin-top: 28px; border-bottom: 1px solid #eee; padding-bottom: 6px; }
  .account { padding: 12px; border: 1px solid #ddd; border-radius: 8px; margin: 8px 0; display: flex; justify-content: space-between; align-items: center; }
  .account.default { border-color: #4285f4; background: #f0f7ff; }
  .account.kroger.default { border-color: #2196f3; background: #e3f2fd; }
  .name { font-weight: 600; }
  .email { color: #666; font-size: 0.9em; }
  .badge { background: #4285f4; color: white; font-size: 0.75em; padding: 2px 8px; border-radius: 10px; margin-left: 8px; }
  .actions form { display: inline; margin-left: 12px; }
  .actions button { background: none; border: none; cursor: pointer; font-size: 0.85em; color: #4285f4; padding: 0; }
  .actions button.danger { color: #d32f2f; }
  .btn { display: inline-block; padding: 10px 24px; background: #4285f4; color: white; text-decoration: none; border-radius: 6px; margin-top: 16px; }
  .btn:hover { background: #3367d6; }
  .btn.kroger { background: #2196f3; }
  .btn.kroger:hover { background: #1976d2; }
  .msg { padding: 12px; background: #e8f5e9; border-radius: 8px; margin: 12px 0; }
  .err { padding: 12px; background: #fce4ec; border-radius: 8px; margin: 12px 0; }
</style></head><body>${body}</body></html>`;
}

function accountsPage(message?: string, error?: string): string {
  const googleAccountsList = listAccounts();
  let krogerAccountsList: ReturnType<typeof listKrogerAccounts> = [];
  try {
    krogerAccountsList = listKrogerAccounts();
  } catch {
    // Kroger not configured
  }

  let body = "<h1>Bowdy Bot — Accounts</h1>";

  if (message) body += `<div class="msg">${esc(message)}</div>`;
  if (error) body += `<div class="err">${esc(error)}</div>`;

  // Google section
  body += "<h2>Google</h2>";
  if (googleAccountsList.length === 0) {
    body += "<p>No Google accounts connected yet.</p>";
  } else {
    for (const a of googleAccountsList) {
      body += `<div class="account${a.isDefault ? " default" : ""}">
        <div><span class="name">${esc(a.name)}</span>${a.isDefault ? '<span class="badge">default</span>' : ""}
          <br><span class="email">${esc(a.email)}</span></div>
        <div class="actions">
          ${!a.isDefault ? `<form method="POST" action="/oauth/default"><input type="hidden" name="email" value="${esc(a.email)}"><button type="submit">Set default</button></form>` : ""}
          <form method="POST" action="/oauth/remove"><input type="hidden" name="email" value="${esc(a.email)}"><button type="submit" class="danger">Remove</button></form>
        </div></div>`;
    }
  }
  body += `<a class="btn" href="/oauth/start">Connect Google Account</a>`;

  // Kroger section
  body += "<h2>Kroger</h2>";
  if (krogerAccountsList.length === 0) {
    body += "<p>No Kroger accounts connected yet.</p>";
  } else {
    for (const a of krogerAccountsList) {
      const storeInfo = a.storeName ? `${a.storeName}${a.storeAddress ? ` — ${a.storeAddress}` : ""}` : "No store set";
      body += `<div class="account kroger${a.isDefault ? " default" : ""}">
        <div><span class="name">Kroger User</span>${a.isDefault ? '<span class="badge">default</span>' : ""}
          <br><span class="email">${esc(a.krogerUserId)}</span>
          <br><span class="email">${esc(storeInfo)}</span></div>
        </div>`;
    }
  }
  body += `<a class="btn kroger" href="/kroger/start">Connect Kroger Account</a>`;

  return html(body);
}

function parseFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () =>
      resolve(new URLSearchParams(Buffer.concat(chunks).toString())),
    );
    req.on("error", reject);
  });
}

export function createOAuthHandler(): RequestHandler {
  return async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host ?? "localhost"}`);

    try {
      if (url.pathname === "/" && req.method === "GET") {
        const msg = url.searchParams.get("msg") ?? undefined;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(accountsPage(msg));
        return true;
      }

      if (url.pathname === "/oauth/start" && req.method === "GET") {
        const consentUrl = getConsentUrl();
        res.writeHead(302, { Location: consentUrl });
        res.end();
        return true;
      }

      if (url.pathname === "/oauth/callback" && req.method === "GET") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            accountsPage(undefined, `Google authorization failed: ${error}`),
          );
          return true;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(accountsPage(undefined, "Missing authorization code"));
          return true;
        }

        const { email, name } = await handleAuthCallback(code);
        res.writeHead(302, {
          Location: `/?msg=${encodeURIComponent(`Connected ${name} (${email})`)}`,
        });
        res.end();
        return true;
      }

      if (url.pathname === "/oauth/remove" && req.method === "POST") {
        const form = await parseFormBody(req);
        const email = form.get("email");
        if (email) {
          removeAccount(email);
          res.writeHead(303, {
            Location: `/?msg=${encodeURIComponent(`Removed ${email}`)}`,
          });
        } else {
          res.writeHead(303, { Location: "/" });
        }
        res.end();
        return true;
      }

      if (url.pathname === "/oauth/default" && req.method === "POST") {
        const form = await parseFormBody(req);
        const email = form.get("email");
        if (email) {
          setDefaultAccount(email);
          res.writeHead(303, {
            Location: `/?msg=${encodeURIComponent(`${email} set as default`)}`,
          });
        } else {
          res.writeHead(303, { Location: "/" });
        }
        res.end();
        return true;
      }
    } catch (err) {
      logger.error({ err }, "OAuth server error");
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(
        accountsPage(undefined, `Server error: ${(err as Error).message}`),
      );
      return true;
    }

    return false;
  };
}

export function createKrogerOAuthHandler(): RequestHandler {
  return async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host ?? "localhost"}`);

    try {
      if (url.pathname === "/kroger/start" && req.method === "GET") {
        const consentUrl = getKrogerConsentUrl();
        res.writeHead(302, { Location: consentUrl });
        res.end();
        return true;
      }

      if (url.pathname === "/kroger/callback" && req.method === "GET") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            accountsPage(undefined, `Kroger authorization failed: ${error}`),
          );
          return true;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(accountsPage(undefined, "Missing authorization code"));
          return true;
        }

        const { userId } = await handleKrogerCallback(code);
        res.writeHead(302, {
          Location: `/?msg=${encodeURIComponent(`Connected Kroger account (${userId})`)}`,
        });
        res.end();
        return true;
      }
    } catch (err) {
      logger.error({ err }, "Kroger OAuth server error");
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(
        accountsPage(undefined, `Server error: ${(err as Error).message}`),
      );
      return true;
    }

    return false;
  };
}

export function createCombinedHandler(handlers: RequestHandler[]): RequestHandler {
  return async (req, res) => {
    for (const handler of handlers) {
      if (await handler(req, res)) return true;
    }
    return false;
  };
}

export function startOAuthServer(externalHandler?: RequestHandler): void {
  const port = parseInt(config.googleOAuthPort, 10);
  const handler = externalHandler ?? createOAuthHandler();

  const server = createServer(async (req, res) => {
    const handled = await handler(req, res);
    if (!handled) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  });

  server.listen(port, () => {
    logger.info(`OAuth server running at http://localhost:${port}`);
  });
}
