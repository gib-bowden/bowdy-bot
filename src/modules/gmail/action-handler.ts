import { URL } from "node:url";
import type { RequestHandler } from "../../auth/server.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import {
  isValidAction,
  verifyActionHmac,
  executeTriageAction,
} from "./actions.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function resultPage(title: string, message: string, success: boolean): string {
  const color = success ? "#388e3c" : "#d32f2f";
  const icon = success ? "✅" : "❌";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #fafafa; }
  .card { background: white; border-radius: 12px; padding: 32px; max-width: 400px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  .icon { font-size: 48px; margin-bottom: 16px; }
  h1 { font-size: 1.2em; color: ${color}; margin: 0 0 8px; }
  p { color: #666; margin: 0; line-height: 1.5; }
</style></head><body>
<div class="card">
  <div class="icon">${icon}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</div>
</body></html>`;
}

/**
 * Create a RequestHandler for triage action webhooks.
 * Handles: GET /triage/action?session={id}&item={ref}&action={action}&sig={hmac}
 */
export function createTriageActionHandler(): RequestHandler {
  const secret = config.tokenEncryptionKey;

  return async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname !== "/triage/action" || req.method !== "GET") {
      return false;
    }

    const sessionId = url.searchParams.get("session");
    const itemRef = url.searchParams.get("item");
    const action = url.searchParams.get("action");
    const sig = url.searchParams.get("sig");

    // Validate required params
    if (!sessionId || !itemRef || !action || !sig) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(resultPage("Bad Request", "Missing required parameters.", false));
      return true;
    }

    // Validate action name
    if (!isValidAction(action)) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(resultPage("Bad Request", `Invalid action: "${action}".`, false));
      return true;
    }

    // Verify HMAC
    if (!secret || !verifyActionHmac(secret, sessionId, itemRef, action, sig)) {
      res.writeHead(403, { "Content-Type": "text/html" });
      res.end(resultPage("Forbidden", "Invalid or expired link.", false));
      return true;
    }

    // Look up session to get accountEmail
    const { getDb, schema } = await import("../../db/client.js");
    const { eq } = await import("drizzle-orm");
    const db = getDb();
    const session = db
      .select()
      .from(schema.emailTriageSessions)
      .where(eq(schema.emailTriageSessions.id, sessionId))
      .get();

    if (!session) {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end(resultPage("Not Found", "Triage session not found.", false));
      return true;
    }

    // Execute the action
    try {
      const result = await executeTriageAction(sessionId, session.accountEmail, itemRef, action);

      if (result.alreadyHandled) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(resultPage("Already Handled", result.message, true));
        return true;
      }

      if (result.success) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(resultPage("Done", result.message, true));
        logger.info({ sessionId, itemRef, action }, "Triage action executed via webhook");
      } else {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(resultPage("Action Failed", result.message, false));
      }
    } catch (err) {
      logger.error({ err, sessionId, itemRef, action }, "Triage action handler error");
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(resultPage("Error", "Something went wrong. Please try again.", false));
    }

    return true;
  };
}
