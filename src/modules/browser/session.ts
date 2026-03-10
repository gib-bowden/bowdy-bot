import { Camoufox } from "camoufox-js";
import type { Browser, Page } from "playwright-core";
import { logger } from "../../logger.js";
import { config } from "../../config.js";
import { loadCookies } from "./cookies.js";

let browser: Browser | null = null;
let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const VIEWPORT = { width: 1280, height: 800 };
const POPUP_TIMEOUT_MS = 60 * 1000; // 60 seconds

// --- PageManager: handles primary page + optional popup ---

class PageManager {
  private primaryPage: Page | null = null;
  private popupPage: Page | null = null;
  private popupTimer: ReturnType<typeof setTimeout> | null = null;

  activePage(): Page {
    if (this.popupPage && !this.popupPage.isClosed()) {
      return this.popupPage;
    }
    // If popup was auto-closed, clean up
    if (this.popupPage) {
      this.clearPopup();
    }
    return this.primaryPage!;
  }

  setPrimaryPage(p: Page): void {
    this.primaryPage = p;
  }

  getPrimaryPage(): Page | null {
    return this.primaryPage;
  }

  openPopup(p: Page): void {
    // Only one popup at a time
    if (this.popupPage && !this.popupPage.isClosed()) {
      logger.warn("Second popup opened — closing it and keeping current popup");
      p.close().catch(() => {});
      return;
    }

    this.popupPage = p;
    logger.info({ popupUrl: p.url() }, "Popup opened — switching active page");

    // Auto-detect popup close
    p.on("close", () => {
      logger.info("Popup closed — switching back to primary page");
      this.clearPopup();
    });

    // Timeout — force-close popup if actor doesn't handle it
    this.popupTimer = setTimeout(() => {
      if (this.popupPage && !this.popupPage.isClosed()) {
        logger.warn("Popup timed out — force-closing");
        this.popupPage.close().catch(() => {});
      }
      this.clearPopup();
    }, POPUP_TIMEOUT_MS);
  }

  async closePopup(): Promise<Page> {
    if (this.popupPage && !this.popupPage.isClosed()) {
      await this.popupPage.close().catch(() => {});
    }
    this.clearPopup();
    return this.primaryPage!;
  }

  hasPopup(): boolean {
    return this.popupPage !== null && !this.popupPage.isClosed();
  }

  private clearPopup(): void {
    this.popupPage = null;
    if (this.popupTimer) {
      clearTimeout(this.popupTimer);
      this.popupTimer = null;
    }
  }

  isAlive(): boolean {
    return this.primaryPage !== null && !this.primaryPage.isClosed();
  }

  async closeAll(): Promise<void> {
    if (this.popupPage) {
      try {
        if (!this.popupPage.isClosed()) {
          await this.popupPage.close().catch(() => {});
        }
      } catch {
        // popup already dead
      }
      this.clearPopup();
    }
    if (this.primaryPage) {
      try {
        if (!this.primaryPage.isClosed()) {
          await this.primaryPage.close().catch(() => {});
        }
      } catch {
        // page already dead
      }
      this.primaryPage = null;
    }
  }
}

const pageManager = new PageManager();

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

  const b = browser!;
  if (!pageManager.isAlive()) {
    const ctx = await b.newContext({ viewport: VIEWPORT });
    if (config.tokenEncryptionKey) {
      await loadCookies(ctx);
    }
    const newPage = await ctx.newPage();
    pageManager.setPrimaryPage(newPage);
  }

  resetInactivityTimer();
  return pageManager.activePage();
}

export function getPageManager(): PageManager {
  return pageManager;
}

export async function closeBrowser(): Promise<void> {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
  await pageManager.closeAll();
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
