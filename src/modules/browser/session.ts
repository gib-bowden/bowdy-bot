import { Camoufox } from "camoufox-js";
import type { Browser, Page } from "playwright-core";
import { logger } from "../../logger.js";

let browser: Browser | null = null;
let page: Page | null = null;
let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const VIEWPORT = { width: 1280, height: 800 };

function resetInactivityTimer(): void {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
  }
  inactivityTimer = setTimeout(() => {
    logger.info("Browser inactivity timeout — closing");
    closeBrowser();
  }, INACTIVITY_TIMEOUT_MS);
}

export async function getPage(): Promise<Page> {
  if (!browser || !browser.isConnected()) {
    const headless = process.platform === "linux" ? "virtual" as const : false;
    logger.info({ headless }, "Launching Camoufox");
    browser = await Camoufox({
      headless,
      window: [VIEWPORT.width, VIEWPORT.height],
    });
  }

  // Local binding so TS narrows after the null-check above
  const b = browser!;
  if (!page || page.isClosed()) {
    const ctx = await b.newContext({ viewport: VIEWPORT });
    page = await ctx.newPage();
  }

  resetInactivityTimer();
  return page;
}

export async function closeBrowser(): Promise<void> {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
  if (page) {
    try {
      if (!page.isClosed()) {
        const result = page.close();
        if (result && typeof result.catch === "function") {
          await result.catch(() => {});
        }
      }
    } catch {
      // page already dead
    }
    page = null;
  }
  if (browser) {
    try {
      const result = browser.close();
      if (result && typeof result.catch === "function") {
        await result.catch(() => {});
      }
    } catch {
      // browser already dead
    }
    browser = null;
  }
  logger.info("Browser closed");
}

// Note: no "exit" handler — async browser.close() can't resolve in the synchronous "exit" event.
// SIGTERM/SIGINT handlers below cover graceful shutdown.

async function shutdownBrowser(): Promise<void> {
  await closeBrowser();
  process.exit(0);
}

process.on("SIGTERM", () => { shutdownBrowser(); });
process.on("SIGINT", () => { shutdownBrowser(); });
