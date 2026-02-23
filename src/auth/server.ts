import { createServer } from "node:http";
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
  .actions a { margin-left: 12px; font-size: 0.85em; }
  .btn { display: inline-block; padding: 10px 24px; background: #4285f4; color: white; text-decoration: none; border-radius: 6px; margin-top: 16px; }
  .btn:hover { background: #3367d6; }
  .msg { padding: 12px; background: #e8f5e9; border-radius: 8px; margin: 12px 0; }
  .err { padding: 12px; background: #fce4ec; border-radius: 8px; margin: 12px 0; }
</style></head><body>${body}</body></html>`;
}

function accountsPage(message?: string, error?: string): string {
  const accounts = listAccounts();
  let body = "<h1>Bowdy Bot — Google Accounts</h1>";

  if (message) body += `<div class="msg">${message}</div>`;
  if (error) body += `<div class="err">${error}</div>`;

  if (accounts.length === 0) {
    body += "<p>No Google accounts connected yet.</p>";
  } else {
    for (const a of accounts) {
      body += `<div class="account${a.isDefault ? " default" : ""}">
        <div><span class="name">${a.name}</span>${a.isDefault ? '<span class="badge">default</span>' : ""}
          <br><span class="email">${a.email}</span></div>
        <div class="actions">
          ${!a.isDefault ? `<a href="/oauth/default?email=${encodeURIComponent(a.email)}">Set default</a>` : ""}
          <a href="/oauth/remove?email=${encodeURIComponent(a.email)}" style="color:#d32f2f">Remove</a>
        </div></div>`;
    }
  }

  body += `<a class="btn" href="/oauth/start">Connect Google Account</a>`;
  return html(body);
}

export function startOAuthServer(): void {
  const port = parseInt(config.googleOAuthPort, 10);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${port}`);

    try {
      if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(accountsPage());
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

      if (url.pathname === "/oauth/remove" && req.method === "GET") {
        const email = url.searchParams.get("email");
        if (email) {
          removeAccount(email);
          res.writeHead(302, { Location: `/?msg=${encodeURIComponent(`Removed ${email}`)}` });
        } else {
          res.writeHead(302, { Location: "/" });
        }
        res.end();
        return;
      }

      if (url.pathname === "/oauth/default" && req.method === "GET") {
        const email = url.searchParams.get("email");
        if (email) {
          setDefaultAccount(email);
          res.writeHead(302, { Location: `/?msg=${encodeURIComponent(`${email} set as default`)}` });
        } else {
          res.writeHead(302, { Location: "/" });
        }
        res.end();
        return;
      }

      // Handle message param on index
      if (url.pathname === "/" && url.searchParams.has("msg")) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(accountsPage(url.searchParams.get("msg")!));
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
