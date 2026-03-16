import type { Page, Frame, Locator, Request as PwRequest, Response as PwResponse } from "playwright-core";
import { logger } from "../../logger.js";
import { recordActionMetric } from "./metrics.js";
import { getPageManager } from "./session.js";

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
  popupOpened?: boolean;
  dialogInfo?: { type: string; message: string };
}

export interface ActionError {
  kind: "error";
  error: string;
}

export async function takeScreenshot(page: Page): Promise<Buffer> {
  return await page.screenshot({ type: "jpeg", quality: 70 });
}

/**
 * Lightweight DOM mutation observer — resolves after 200ms of no mutations, 1s hard cap.
 * Used as a secondary safety net after network-aware settling.
 */
async function briefDomSettle(page: Page): Promise<void> {
  await page.evaluate(() => {
    return new Promise<void>((resolve) => {
      if (!document.body) {
        resolve();
        return;
      }

      let settled = false;
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      let hardCapTimer: ReturnType<typeof setTimeout> | null = null;
      const QUIET_MS = 200;
      const HARD_CAP_MS = 1000;

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

      quietTimer = setTimeout(finish, QUIET_MS);
      hardCapTimer = setTimeout(finish, HARD_CAP_MS);
    });
  }).catch(() => {});
}

/**
 * Request-aware settling: wraps an action callback, tracks network requests,
 * and waits appropriately based on whether a navigation or XHR occurred.
 */
async function waitForCompletion<T>(page: Page, callback: () => Promise<T>): Promise<T> {
  let sawDocumentRequest = false;
  let pendingRequests = 0;

  const onRequest = (req: PwRequest) => {
    if (req.resourceType() === "document") {
      sawDocumentRequest = true;
    }
    if (req.resourceType() === "fetch" || req.resourceType() === "xhr") {
      pendingRequests++;
    }
  };
  const onResponse = (res: PwResponse) => {
    const req = res.request();
    if (req.resourceType() === "fetch" || req.resourceType() === "xhr") {
      pendingRequests = Math.max(0, pendingRequests - 1);
    }
  };
  const onRequestFailed = (req: PwRequest) => {
    if (req.resourceType() === "fetch" || req.resourceType() === "xhr") {
      pendingRequests = Math.max(0, pendingRequests - 1);
    }
  };

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);

  try {
    const result = await callback();

    if (sawDocumentRequest) {
      // Navigation occurred — wait for full network idle
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    } else if (pendingRequests > 0) {
      // XHR/fetch in flight — poll until resolved (5s timeout)
      const deadline = Date.now() + 5000;
      while (pendingRequests > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    await briefDomSettle(page);
    return result;
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfailed", onRequestFailed);
  }
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

// --- Frame-aware locator resolution ---

const GET_BY_ROLE_RE = /^getByRole\('([^']+)'(?:,\s*\{\s*name:\s*'(.*)'\s*\})?\)$/;

/**
 * Parse a Playwright-style locator string and return a Locator that auto-traverses frames.
 * Returns null if the string doesn't match the expected pattern.
 */
export function resolveLocator(page: Page, selector: string): Locator | null {
  const match = selector.match(GET_BY_ROLE_RE);
  if (!match) {
    return null;
  }
  const role = match[1] as Parameters<Page["getByRole"]>[0];
  const name = match[2]?.replace(/\\'/g, "'");
  if (name) {
    return page.getByRole(role, { name }).first();
  }
  return page.getByRole(role).first();
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
        await waitForCompletion(page, () => page.goto(action.url, { waitUntil: "load", timeout: 15000 }));
        break;
      }

      case "click": {
        // Listen for popups (new tabs) — non-blocking, only resolves if one actually fires
        let popupPage: Page | null = null;
        const popupHandler = (p: Page) => { popupPage = p; };
        page.context().on("page", popupHandler);

        if (action.selector) {
          const selector = action.selector;
          const loc = resolveLocator(page, selector);
          if (loc) {
            try {
              await waitForCompletion(page, () => loc.click({ timeout: FRAME_TIMEOUT_MS }));
            } catch {
              await waitForCompletion(page, () => loc.click({ force: true, timeout: FRAME_TIMEOUT_MS }));
            }
          } else {
            try {
              await waitForCompletion(page, () => tryInFrames(page, (f) => f.click(selector, { timeout: FRAME_TIMEOUT_MS })));
            } catch {
              // Retry with force if an overlay/navbar intercepts the click
              await waitForCompletion(page, () => tryInFrames(page, (f) => f.click(selector, { force: true, timeout: FRAME_TIMEOUT_MS })));
            }
          }
        } else if (action.x !== undefined && action.y !== undefined) {
          await waitForCompletion(page, () => page.mouse.click(action.x!, action.y!));
        } else {
          page.context().off("page", popupHandler);
          return { kind: "error", error: "click requires selector or x/y coordinates" };
        }

        page.context().off("page", popupHandler);

        // If the click opened a new tab, use PageManager for multi-tab support
        if (popupPage) {
          const openedPage = popupPage as Page;
          await openedPage.waitForLoadState("load", { timeout: 10000 }).catch(() => {});
          const newUrl = openedPage.url();

          const pm = getPageManager();
          if (newUrl && newUrl !== "about:blank") {
            if (!pm.hasPopup()) {
              // First popup — keep it open for OAuth/payment flows
              pm.openPopup(openedPage);
              await briefDomSettle(openedPage);
              const screenshot = await takeScreenshot(openedPage);
              const afterUrl = openedPage.url();
              const afterTitle = await openedPage.title();
              return {
                kind: "result",
                screenshot,
                metadata: { url: afterUrl, title: afterTitle },
                popupOpened: true,
              };
            } else {
              // Second popup — fall back to close-and-navigate behavior
              await openedPage.close().catch(() => {});
              await page.goto(newUrl, { waitUntil: "load", timeout: 15000 })
                .catch((err) => {
                  logger.warn({ err, newUrl }, "Failed to navigate to popup URL");
                  popupFailedUrl = newUrl;
                });
            }
          } else {
            await openedPage.close().catch(() => {});
          }
        }

        break;
      }

      case "type":
        if (action.selector) {
          const selector = action.selector;
          const loc = resolveLocator(page, selector);
          if (loc) {
            try {
              await loc.fill(action.text, { timeout: FRAME_TIMEOUT_MS });
            } catch {
              logger.warn({ selector }, "locator fill failed, falling back to keyboard.type");
              await page.keyboard.type(action.text);
            }
          } else {
            try {
              await tryInFrames(page, (f) => f.fill(selector, action.text, { timeout: FRAME_TIMEOUT_MS }));
            } catch {
              logger.warn({ selector }, "fill failed across all frames, falling back to keyboard.type");
              await page.keyboard.type(action.text);
            }
          }
        } else {
          await page.keyboard.type(action.text);
        }
        if (action.press_enter) {
          await waitForCompletion(page, () => page.keyboard.press("Enter"));
        }
        break;

      case "select":
        if (action.label) {
          const label = action.label;
          await waitForCompletion(page, () => tryInFrames(page, (f) => f.selectOption(action.selector, { label }, { timeout: FRAME_TIMEOUT_MS })));
        } else if (action.value) {
          const value = action.value;
          await waitForCompletion(page, () => tryInFrames(page, (f) => f.selectOption(action.selector, value, { timeout: FRAME_TIMEOUT_MS })));
        } else {
          return { kind: "error", error: "select requires value or label" };
        }
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
        await waitForCompletion(page, () => page.goBack({ waitUntil: "load", timeout: 10000 }).catch(() => null));
        break;

      case "hover":
        if (action.selector) {
          const selector = action.selector;
          const loc = resolveLocator(page, selector);
          if (loc) {
            await loc.hover({ timeout: FRAME_TIMEOUT_MS });
          } else {
            await tryInFrames(page, (f) => f.hover(selector, { timeout: FRAME_TIMEOUT_MS }));
          }
        } else if (action.x !== undefined && action.y !== undefined) {
          await page.mouse.move(action.x, action.y);
        } else {
          return { kind: "error", error: "hover requires selector or x/y coordinates" };
        }
        await briefDomSettle(page);
        break;

      case "press_key": {
        const KEY_ALIASES: Record<string, string> = { Return: "Enter", Esc: "Escape" };
        const resolvedKey = KEY_ALIASES[action.key] || action.key;
        if (resolvedKey === "Enter" || resolvedKey === "Escape" || resolvedKey === "Tab") {
          await waitForCompletion(page, () => page.keyboard.press(resolvedKey));
        } else {
          await page.keyboard.press(resolvedKey);
        }
        break;
      }

      case "fill": {
        const fillSelector = action.selector;
        const loc = resolveLocator(page, fillSelector);
        if (loc) {
          await waitForCompletion(page, () => loc.fill(action.text, { timeout: FRAME_TIMEOUT_MS }));
        } else {
          await waitForCompletion(page, () => tryInFrames(page, (f) => f.fill(fillSelector, action.text, { timeout: FRAME_TIMEOUT_MS })));
        }
        break;
      }

      case "screenshot":
        // Just take the screenshot, no other action
        break;

      default:
        return { kind: "error", error: `Unknown action: ${(action as BrowserAction).action}` };
    }

    // Check for pending dialogs after action
    const pm = getPageManager();
    const pendingDialog = pm.getDialogManager().pending();
    const dialogInfo = pendingDialog
      ? { type: pendingDialog.type, message: pendingDialog.message }
      : undefined;

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
      ...(dialogInfo ? { dialogInfo } : {}),
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
  const startTime = performance.now();
  let retries = 0;
  let lastResult = await executeAction(page, action);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const errorMsg = lastResult.error;

    if (!errorMsg || !isTransientError(errorMsg)) {
      break;
    }

    retries++;
    const delay = 200 * Math.pow(2, attempt);
    logger.warn({ action: action.action, attempt: attempt + 1, delay }, "Retrying transient error");
    await new Promise((resolve) => setTimeout(resolve, delay));
    lastResult = await executeAction(page, action);
  }

  const durationMs = Math.round(performance.now() - startTime);
  const success = isActionResult(lastResult) && !lastResult.error;
  const url = "url" in action ? (action as { url: string }).url : page.url();
  recordActionMetric({
    action: action.action,
    success,
    durationMs,
    error: lastResult.error,
    retries,
    url,
  });

  return lastResult;
}

export function isActionResult(result: ActionResult | ActionError): result is ActionResult {
  return result.kind === "result";
}
