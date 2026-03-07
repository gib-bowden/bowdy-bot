import { chromium, type Browser, type Page } from "playwright";
import { logger } from "../../logger.js";

let browser: Browser | null = null;
let page: Page | null = null;
let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const VIEWPORT = { width: 1280, height: 720 };

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
    logger.info("Launching Chromium");
    browser = await chromium.launch({ headless: true });
  }

  if (!page || page.isClosed()) {
    const context = await browser.newContext({ viewport: VIEWPORT });
    page = await context.newPage();
  }

  resetInactivityTimer();
  return page;
}

export async function closeBrowser(): Promise<void> {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
  if (page && !page.isClosed()) {
    await page.close().catch(() => {});
    page = null;
  }
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  logger.info("Browser closed");
}

// Cleanup on process exit
function cleanup(): void {
  if (browser) {
    browser.close().catch(() => {});
    browser = null;
    page = null;
  }
}

process.on("exit", cleanup);
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
