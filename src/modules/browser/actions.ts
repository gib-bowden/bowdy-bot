import type { Page, Frame } from "playwright";
import { logger } from "../../logger.js";

export type BrowserAction =
  | { action: "click"; selector?: string; x?: number; y?: number; label?: number }
  | { action: "type"; selector?: string; text: string; press_enter?: boolean }
  | { action: "select"; selector: string; value?: string; label?: string }
  | { action: "scroll"; direction: "up" | "down"; amount?: number }
  | { action: "wait"; seconds?: number }
  | { action: "go_back" }
  | { action: "navigate"; url: string }
  | { action: "screenshot" }
  | { action: "hover"; selector?: string; x?: number; y?: number; label?: number }
  | { action: "press_key"; key: string }
  | { action: "fill"; selector: string; text: string };

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
  kind: "result";
  screenshot: Buffer;
  metadata: { url: string; title: string };
  error?: string;
  unchanged?: boolean;
}

export interface ActionError {
  kind: "error";
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

const FRAME_TIMEOUT_MS = 2000;

async function tryInFrames<T>(page: Page, fn: (frame: Frame) => Promise<T>): Promise<T> {
  try {
    return await fn(page.mainFrame());
  } catch {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) {
        continue;
      }
      try {
        return await fn(frame);
      } catch {
        continue;
      }
    }
    throw new Error("Selector not found in main frame or any iframe");
  }
}

export async function executeAction(
  page: Page,
  action: BrowserAction,
): Promise<ActionResult | ActionError> {
  // Capture before-state for click actions to detect "nothing changed"
  const isClick = action.action === "click";
  const beforeUrl = isClick ? page.url() : undefined;
  const beforeTitle = isClick ? await page.title() : undefined;

  try {
    switch (action.action) {
      case "navigate": {
        const urlError = validateUrl(action.url);
        if (urlError) {
          return { kind: "error", error: urlError };
        }
        await page.goto(action.url, { waitUntil: "load", timeout: 15000 });
        await settle(page);
        break;
      }

      case "click": {
        // Listen for popups (new tabs) — non-blocking, only resolves if one actually fires
        let popupPage: Page | null = null;
        const popupHandler = (p: Page) => { popupPage = p; };
        page.context().on("page", popupHandler);

        if (action.selector) {
          const selector = action.selector;
          try {
            await tryInFrames(page, (f) => f.click(selector, { timeout: FRAME_TIMEOUT_MS }));
          } catch {
            // Retry with force if an overlay/navbar intercepts the click
            await tryInFrames(page, (f) => f.click(selector, { force: true, timeout: FRAME_TIMEOUT_MS }));
          }
        } else if (action.x !== undefined && action.y !== undefined) {
          await page.mouse.click(action.x, action.y);
        } else {
          page.context().off("page", popupHandler);
          return { kind: "error", error: "click requires selector or x/y coordinates" };
        }

        page.context().off("page", popupHandler);

        // If the click opened a new tab, switch to it.
        // TODO: This works for navigational new tabs (target="_blank") but will break
        // OAuth/payment popups (Stripe, Google sign-in) that rely on the popup's
        // opener reference. Handle those cases once navigation-based evals are solid.
        if (popupPage) {
          const openedPage = popupPage as Page;
          await openedPage.waitForLoadState("load", { timeout: 10000 }).catch(() => {});
          const newUrl = openedPage.url();
          await openedPage.close().catch(() => {});
          if (newUrl && newUrl !== "about:blank") {
            await page.goto(newUrl, { waitUntil: "load", timeout: 15000 })
              .catch((err) => logger.warn({ err, newUrl }, "Failed to navigate to popup URL"));
          }
        }

        await settle(page);
        break;
      }

      case "type":
        if (action.selector) {
          const selector = action.selector;
          try {
            await tryInFrames(page, (f) => f.fill(selector, action.text, { timeout: FRAME_TIMEOUT_MS }));
          } catch {
            logger.warn({ selector: action.selector }, "fill failed across all frames, falling back to keyboard.type");
            await page.keyboard.type(action.text);
          }
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
          const label = action.label;
          await tryInFrames(page, (f) => f.selectOption(action.selector, { label }, { timeout: FRAME_TIMEOUT_MS }));
        } else if (action.value) {
          const value = action.value;
          await tryInFrames(page, (f) => f.selectOption(action.selector, value, { timeout: FRAME_TIMEOUT_MS }));
        } else {
          return { kind: "error", error: "select requires value or label" };
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

      case "hover":
        if (action.selector) {
          const selector = action.selector;
          await tryInFrames(page, (f) => f.hover(selector, { timeout: FRAME_TIMEOUT_MS }));
        } else if (action.x !== undefined && action.y !== undefined) {
          await page.mouse.move(action.x, action.y);
        } else {
          return { kind: "error", error: "hover requires selector or x/y coordinates" };
        }
        await settle(page);
        break;

      case "press_key":
        await page.keyboard.press(action.key);
        if (action.key === "Enter" || action.key === "Escape" || action.key === "Tab") {
          await settle(page);
        }
        break;

      case "fill": {
        const fillSelector = action.selector;
        await tryInFrames(page, (f) => f.fill(fillSelector, action.text, { timeout: FRAME_TIMEOUT_MS }));
        await settle(page);
        break;
      }

      case "screenshot":
        // Just take the screenshot, no other action
        break;

      default:
        return { kind: "error", error: `Unknown action: ${(action as BrowserAction).action}` };
    }

    const screenshot = await takeScreenshot(page);
    const afterUrl = page.url();
    const afterTitle = await page.title();
    const unchanged = isClick && afterUrl === beforeUrl && afterTitle === beforeTitle;
    return {
      kind: "result",
      screenshot,
      metadata: { url: afterUrl, title: afterTitle },
      ...(unchanged ? { unchanged: true } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ action: action.action, err: message }, "Browser action failed");

    // Still try to return a screenshot on error so the agent can see the state
    try {
      const screenshot = await takeScreenshot(page);
      return {
        kind: "result",
        screenshot,
        metadata: { url: page.url(), title: await page.title() },
        error: message,
      };
    } catch {
      return { kind: "error", error: message };
    }
  }
}

export function isActionResult(result: ActionResult | ActionError): result is ActionResult {
  return result.kind === "result";
}
