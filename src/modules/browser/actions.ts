import type { Page, Frame } from "playwright-core";
import { logger } from "../../logger.js";

export type BrowserAction =
  | { action: "click"; selector?: string; x?: number; y?: number; label?: number }
  | { action: "type"; selector?: string; text: string; press_enter?: boolean }
  | { action: "select"; selector: string; value?: string; label?: string }
  | { action: "scroll"; direction: "up" | "down"; selector?: string; x?: number; y?: number }
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
  popupFailedUrl?: string;
}

export interface ActionError {
  kind: "error";
  error: string;
}

export async function takeScreenshot(page: Page): Promise<Buffer> {
  return await page.screenshot({ type: "jpeg", quality: 70 });
}

async function settle(page: Page): Promise<void> {
  // Phase 1: Wait for network idle (3s timeout for long-polling/websocket pages)
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});

  // Phase 2: Wait for DOM stability — resolve after 500ms of no mutations, hard cap 2s
  await page.evaluate(() => {
    return new Promise<void>((resolve) => {
      if (!document.body) {
        resolve();
        return;
      }

      let settled = false;
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      let hardCapTimer: ReturnType<typeof setTimeout> | null = null;
      const QUIET_MS = 500;
      const HARD_CAP_MS = 2000;

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        observer.disconnect();
        if (quietTimer) {
          clearTimeout(quietTimer);
        }
        if (hardCapTimer) {
          clearTimeout(hardCapTimer);
        }
        resolve();
      };

      const observer = new MutationObserver(() => {
        if (quietTimer) {
          clearTimeout(quietTimer);
        }
        quietTimer = setTimeout(finish, QUIET_MS);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });

      // Start the quiet timer immediately (resolves if no mutations at all)
      quietTimer = setTimeout(finish, QUIET_MS);

      // Hard cap for continuously-animated pages
      hardCapTimer = setTimeout(finish, HARD_CAP_MS);
    });
  }).catch(() => {});
}

const FRAME_TIMEOUT_MS = 2000;

async function tryInFrames<T>(page: Page, fn: (frame: Frame) => Promise<T>): Promise<T> {
  try {
    return await fn(page.mainFrame());
  } catch {
    const childFrames = page.frames().filter((f) => f !== page.mainFrame());

    // Only sort by visibility when there are multiple child frames
    if (childFrames.length > 1) {
      const frameMeta = await Promise.all(
        childFrames.map(async (frame) => {
          let area = 0;
          let visible = false;
          try {
            const el = await frame.frameElement();
            const box = await el.boundingBox();
            if (box) {
              area = box.width * box.height;
              visible = box.width > 0 && box.height > 0;
            }
          } catch {
            // Can't determine visibility, treat as non-visible
          }
          return { frame, area, visible };
        }),
      );

      frameMeta.sort((a, b) => {
        if (a.visible !== b.visible) {
          return a.visible ? -1 : 1;
        }
        return b.area - a.area;
      });

      childFrames.length = 0;
      childFrames.push(...frameMeta.map((m) => m.frame));
    }

    for (const frame of childFrames) {
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
  let popupFailedUrl: string | undefined;

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
              .catch((err) => {
                logger.warn({ err, newUrl }, "Failed to navigate to popup URL");
                popupFailedUrl = newUrl;
              });
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
        const delta = action.direction === "down" ? 500 : -500;
        if (action.selector) {
          const selector = action.selector;
          const box = await tryInFrames(page, async (f) => {
            const el = f.locator(selector).first();
            return await el.boundingBox({ timeout: FRAME_TIMEOUT_MS });
          });
          if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          } else {
            logger.warn({ selector }, "Scroll target not found, scrolling at current mouse position");
          }
        } else if (action.x !== undefined && action.y !== undefined) {
          await page.mouse.move(action.x, action.y);
        }
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

      case "press_key": {
        const KEY_ALIASES: Record<string, string> = { Return: "Enter", Esc: "Escape" };
        const resolvedKey = KEY_ALIASES[action.key] || action.key;
        await page.keyboard.press(resolvedKey);
        if (resolvedKey === "Enter" || resolvedKey === "Escape" || resolvedKey === "Tab") {
          await settle(page);
        }
        break;
      }

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
      ...(popupFailedUrl ? { popupFailedUrl } : {}),
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

// --- Transient error retry ---

const TRANSIENT_PATTERNS = [
  /timeout/i, /net::ERR_CONNECTION_RESET/i, /net::ERR_CONNECTION_TIMED_OUT/i,
  /execution context was destroyed/i, /frame was detached/i,
  /Target closed/i, /is not stable/i, /intercepted by another element/i,
];

export function isTransientError(error: string): boolean {
  return TRANSIENT_PATTERNS.some((p) => p.test(error));
}

export async function executeActionWithRetry(
  page: Page,
  action: BrowserAction,
  maxRetries = 2,
): Promise<ActionResult | ActionError> {
  let lastResult = await executeAction(page, action);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const errorMsg = lastResult.error;

    if (!errorMsg || !isTransientError(errorMsg)) {
      return lastResult;
    }

    const delay = 200 * Math.pow(2, attempt);
    logger.warn({ action: action.action, attempt: attempt + 1, delay }, "Retrying transient error");
    await new Promise((resolve) => setTimeout(resolve, delay));
    lastResult = await executeAction(page, action);
  }

  return lastResult;
}

export function isActionResult(result: ActionResult | ActionError): result is ActionResult {
  return result.kind === "result";
}
