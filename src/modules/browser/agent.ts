import { logger } from "../../logger.js";
import { config } from "../../config.js";
import { getPage } from "./session.js";
import { validateUrl, takeScreenshot } from "./actions.js";
import { saveCookies } from "./cookies.js";
import { startSession, endSession } from "./eval/capture.js";
import { runRouterLoop, ROUTER_MODEL } from "./router.js";
import { generateSessionId, startMetricsSession, endMetricsSession } from "./metrics.js";
import type { ProgressEntry, PageMetadata } from "./types.js";
import { DEFAULT_BROWSER_MODEL } from "./types.js";
import type { BrowserTaskResult } from "./types.js";

export { DEFAULT_BROWSER_MODEL, type BrowserTaskResult };

// Session state — single-session only, with busy lock
let busy = false;
let routerGoal = "";
let routerProgressLog: ProgressEntry[] = [];
let metricsSessionId: string | null = null;
let sessionTimeout: ReturnType<typeof setTimeout> | null = null;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function resetSessionTimeout(): void {
  if (sessionTimeout) {
    clearTimeout(sessionTimeout);
  }
  sessionTimeout = setTimeout(() => {
    if (busy) {
      logger.warn("Browser session timed out — releasing busy lock");
      resetSession();
    }
  }, SESSION_TIMEOUT_MS);
}

function clearSessionTimeout(): void {
  if (sessionTimeout) {
    clearTimeout(sessionTimeout);
    sessionTimeout = null;
  }
}

function resetSession(): void {
  if (metricsSessionId) {
    endMetricsSession("timeout");
  }
  busy = false;
  routerGoal = "";
  routerProgressLog = [];
  metricsSessionId = null;
  clearSessionTimeout();
}

export function isBrowserBusy(): boolean {
  return busy;
}

export async function startBrowserTask(url: string, goal: string): Promise<BrowserTaskResult> {
  if (busy) {
    return { status: "error", error: "A browser task is already in progress. Wait for it to finish or ask the user to try again later." };
  }

  // Validate URL before starting
  const urlError = validateUrl(url);
  if (urlError) {
    return { status: "error", error: urlError };
  }

  logger.info({ url, goal }, "Starting browser task");

  busy = true;
  routerGoal = goal;
  routerProgressLog = [];
  metricsSessionId = generateSessionId();
  startMetricsSession(metricsSessionId, goal, url);
  resetSessionTimeout();

  const page = await getPage();

  try {
    await page.goto(url, { waitUntil: "load", timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const screenshot = await takeScreenshot(page);
    const pageTitle = await page.title();

    startSession({
      goal,
      startUrl: url,
      model: ROUTER_MODEL,
      initialScreenshot: screenshot,
      pageUrl: url,
      pageTitle,
    });

    const pageMetadata: PageMetadata = { url, title: pageTitle };
    const { result, progressLog, routerIterations } = await runRouterLoop(page, goal, screenshot, pageMetadata);

    routerProgressLog = progressLog;

    if (result.status !== "needs_input") {
      if (config.tokenEncryptionKey) {
        await saveCookies(page).catch(() => {});
      }
      endMetricsSession(result.status, routerIterations);
      endSession(result);
      resetSession();
    }
    return result;
  } catch (err) {
    endMetricsSession("error");
    resetSession();
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Browser task failed");
    const errorResult: BrowserTaskResult = { status: "error", error: message };
    endSession(errorResult);
    return errorResult;
  }
}

export async function continueBrowserTask(userResponse: string): Promise<BrowserTaskResult> {
  if (!routerGoal) {
    return { status: "error", error: "No active browser session to continue. Start a new browser_task first." };
  }

  logger.info({ userResponse: userResponse.slice(0, 200) }, "Continuing browser task");
  resetSessionTimeout();

  const page = await getPage();

  try {
    const screenshot = await takeScreenshot(page);
    const pageMetadata: PageMetadata = {
      url: page.url(),
      title: await page.title(),
    };

    const { result, progressLog, routerIterations } = await runRouterLoop(
      page,
      routerGoal,
      screenshot,
      pageMetadata,
      { existingProgressLog: routerProgressLog, userResponse },
    );

    routerProgressLog = progressLog;

    if (result.status !== "needs_input") {
      if (config.tokenEncryptionKey) {
        await saveCookies(page).catch(() => {});
      }
      endMetricsSession(result.status, routerIterations);
      endSession(result);
      resetSession();
    }
    return result;
  } catch (err) {
    endMetricsSession("error");
    resetSession();
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Browser task continue failed");
    const errorResult: BrowserTaskResult = { status: "error", error: message };
    endSession(errorResult);
    return errorResult;
  }
}
