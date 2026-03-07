import type { Page } from "playwright";
import { logger } from "../../logger.js";

export type BrowserAction =
  | { action: "click"; selector?: string; x?: number; y?: number }
  | { action: "type"; selector?: string; text: string; press_enter?: boolean }
  | { action: "select"; selector: string; value?: string; label?: string }
  | { action: "scroll"; direction: "up" | "down"; amount?: number }
  | { action: "wait"; seconds?: number }
  | { action: "go_back" }
  | { action: "navigate"; url: string }
  | { action: "screenshot" };

/**
 * Validate that a URL is safe to navigate to (no SSRF).
 * Allows only http/https schemes and blocks private/internal IPs.
 */
export function validateUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Blocked scheme: ${parsed.protocol} — only http/https allowed`;
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
    return "Blocked: localhost access not allowed";
  }

  // Block cloud metadata endpoints
  if (hostname === "169.254.169.254" || hostname === "metadata.google.internal") {
    return "Blocked: cloud metadata endpoint";
  }

  // Block private IP ranges (10.x, 172.16-31.x, 192.168.x)
  const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipMatch) {
    const [, a, b] = ipMatch.map(Number);
    if (a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || a === 0) {
      return "Blocked: private IP range";
    }
  }

  return null;
}

export interface ActionResult {
  screenshot: Buffer;
  metadata: { url: string; title: string };
}

export interface ActionError {
  error: string;
}

const SETTLE_DELAY_MS = 1000;

async function takeScreenshot(page: Page): Promise<Buffer> {
  return await page.screenshot({ type: "jpeg", quality: 75 });
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("load").catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
}

export async function executeAction(
  page: Page,
  action: BrowserAction,
): Promise<ActionResult | ActionError> {
  try {
    switch (action.action) {
      case "navigate": {
        const urlError = validateUrl(action.url);
        if (urlError) {
          return { error: urlError };
        }
        await page.goto(action.url, { waitUntil: "load", timeout: 15000 });
        await settle(page);
        break;
      }

      case "click":
        if (action.selector) {
          try {
            await page.click(action.selector, { timeout: 5000 });
          } catch {
            // Retry with force if an overlay/navbar intercepts the click
            await page.click(action.selector, { force: true, timeout: 5000 });
          }
        } else if (action.x !== undefined && action.y !== undefined) {
          await page.mouse.click(action.x, action.y);
        } else {
          return { error: "click requires selector or x/y coordinates" };
        }
        await settle(page);
        break;

      case "type":
        if (action.selector) {
          await page.fill(action.selector, action.text);
        } else {
          await page.keyboard.type(action.text);
        }
        if (action.press_enter) {
          await page.keyboard.press("Enter");
          await settle(page);
        }
        break;

      case "select":
        if (action.label) {
          await page.selectOption(action.selector, { label: action.label });
        } else if (action.value) {
          await page.selectOption(action.selector, action.value);
        } else {
          return { error: "select requires value or label" };
        }
        await settle(page);
        break;

      case "scroll": {
        const amount = action.amount ?? 500;
        const delta = action.direction === "down" ? amount : -amount;
        await page.mouse.wheel(0, delta);
        await new Promise((resolve) => setTimeout(resolve, 500));
        break;
      }

      case "wait": {
        const seconds = action.seconds ?? 2;
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        break;
      }

      case "go_back":
        await page.goBack({ waitUntil: "load", timeout: 10000 }).catch(() => {});
        await settle(page);
        break;

      case "screenshot":
        // Just take the screenshot, no other action
        break;

      default:
        return { error: `Unknown action: ${(action as BrowserAction).action}` };
    }

    const screenshot = await takeScreenshot(page);
    return {
      screenshot,
      metadata: { url: page.url(), title: await page.title() },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ action: action.action, err: message }, "Browser action failed");

    // Still try to return a screenshot on error so the agent can see the state
    try {
      const screenshot = await takeScreenshot(page);
      return {
        screenshot,
        metadata: { url: page.url(), title: await page.title() },
      };
    } catch {
      return { error: message };
    }
  }
}
