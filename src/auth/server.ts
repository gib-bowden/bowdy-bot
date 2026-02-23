import { createServer, IncomingMessage } from "node:http";
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
<html><head><meta charset="utf-8"><title>Bowdy Bot — Google Accounts</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 1.4em; }
  .account { padding: 12px; border: 1px solid #ddd; border-radius: 8px; margin: 8px 0; display: flex; justify-content: space-between; align-items: center; }
  .account.default { border-color: #4285f4; background: #f0f7ff; }
  .name { font-weight: 600; }
  .email { color: #666; font-size: 0.9em; }
  .badge { background: #4285f4; color: white; font-size: 0.75em; padding: 2px 8px; border-radius: 10px; margin-left: 8px; }
  .actions form { display: inline; margin-left: 12px; }
  .actions button { background: none; border: none; cursor: pointer; font-size: 0.85em; color: #4285f4; padding: 0; }
  .actions button.danger { color: #d32f2f; }
  .btn { display: inline-block; padding: 10px 24px; background: #4285f4; color: white; text-decoration: none; border-radius: 6px; margin-top: 16px; }
  .btn:hover { background: #3367d6; }
  .msg { padding: 12px; background: #e8f5e9; border-radius: 8px; margin: 12px 0; }
  .err { padding: 12px; background: #fce4ec; border-radius: 8px; margin: 12px 0; }
</style></head><body>${body}</body></html>`;
}

function accountsPage(message?: string, error?: string): string {
  const accounts = listAccounts();
  let body = "<h1>Bowdy Bot — Google Accounts</h1>";

  if (message) body += `<div class="msg">${esc(message)}</div>`;
  if (error) body += `<div class="err">${esc(error)}</div>`;

  if (accounts.length === 0) {
    body += "<p>No Google accounts connected yet.</p>";
  } else {
    for (const a of accounts) {
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
  return html(body);
}

function parseFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString())));
    req.on("error", reject);
  });
}

export function startOAuthServer(): void {
  const port = parseInt(config.googleOAuthPort, 10);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${port}`);

    try {
      if (url.pathname === "/" && req.method === "GET") {
        const msg = url.searchParams.get("msg") ?? undefined;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(accountsPage(msg));
        return;
      }

      if (url.pathname === "/oauth/start" && req.method === "GET") {
        const consentUrl = getConsentUrl();
        res.writeHead(302, { Location: consentUrl });
        res.end();
        return;
      }

      if (url.pathname === "/oauth/callback" && req.method === "GET") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(accountsPage(undefined, `Google authorization failed: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(accountsPage(undefined, "Missing authorization code"));
          return;
        }

        const { email, name } = await handleAuthCallback(code);
        res.writeHead(302, { Location: `/?msg=${encodeURIComponent(`Connected ${name} (${email})`)}` });
        res.end();
        return;
      }

      if (url.pathname === "/oauth/remove" && req.method === "POST") {
        const form = await parseFormBody(req);
        const email = form.get("email");
        if (email) {
          removeAccount(email);
          res.writeHead(303, { Location: `/?msg=${encodeURIComponent(`Removed ${email}`)}` });
        } else {
          res.writeHead(303, { Location: "/" });
        }
        res.end();
        return;
      }

      if (url.pathname === "/oauth/default" && req.method === "POST") {
        const form = await parseFormBody(req);
        const email = form.get("email");
        if (email) {
          setDefaultAccount(email);
          res.writeHead(303, { Location: `/?msg=${encodeURIComponent(`${email} set as default`)}` });
        } else {
          res.writeHead(303, { Location: "/" });
        }
        res.end();
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (err) {
      logger.error({ err }, "OAuth server error");
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(accountsPage(undefined, `Server error: ${(err as Error).message}`));
    }
  });

  server.listen(port, () => {
    logger.info(`Google OAuth server running at http://localhost:${port}`);
  });
}
