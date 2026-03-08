import type Anthropic from "@anthropic-ai/sdk";
import { getClient } from "../../ai/client.js";
import { logger } from "../../logger.js";
import { getPage } from "./session.js";
import { executeAction, validateUrl, type BrowserAction, type ActionResult } from "./actions.js";
import { startSession, recordSessionTurn, endSession, type SessionTurn } from "./eval/capture.js";

const MAX_ITERATIONS = 20;
const MAX_SCREENSHOTS_IN_HISTORY = 3;
export const DEFAULT_BROWSER_MODEL = "claude-sonnet-4-6";
const MODEL = process.env["EVAL_MODEL"] || DEFAULT_BROWSER_MODEL;
const RETRY_NUDGE = "You have failed multiple actions in a row. Try a completely different approach: use x/y coordinates instead of selectors, type without a selector, or use [NEED_INPUT] to ask the user for help.";

export type BrowserTaskResult =
  | { status: "done"; summary: string }
  | { status: "needs_input"; question: string; context: string }
  | { status: "error"; error: string }
  | { status: "max_iterations"; summary: string };

// Session state — single-session only, with busy lock
let conversationMessages: Anthropic.MessageParam[] = [];
let currentGoal: string = "";
let busy = false;
let consecutiveErrors = 0;

export function isBrowserBusy(): boolean {
  return busy;
}

export const SYSTEM_PROMPT = `You control a browser to accomplish tasks. You can see the page via screenshots.

Available actions (respond with a JSON code block):
\`\`\`json
{ "action": "navigate", "url": "https://..." }
{ "action": "click", "selector": "css selector" }
{ "action": "click", "x": 100, "y": 200 }
{ "action": "type", "selector": "css selector", "text": "...", "press_enter": true }
{ "action": "type", "text": "..." }
{ "action": "select", "selector": "css selector", "label": "Option text" }
{ "action": "scroll", "direction": "down", "amount": 500 }
{ "action": "wait", "seconds": 2 }
{ "action": "go_back" }
{ "action": "screenshot" }
\`\`\`

Rules:
- Respond with exactly ONE action JSON block per message
- You may include brief reasoning text before the JSON block
- When the task is complete, respond with [DONE] followed by a summary of what was accomplished
- If you need information from the user to proceed, respond with [NEED_INPUT] followed by your question
- Prefer CSS selectors for clicking/typing when possible; use x/y coordinates as a fallback
- \`type\` without a selector types into the currently focused element — useful when selectors fail
- After each action, verify the screenshot shows the expected result before proceeding
- Only navigate to URLs visible on the page — never guess or construct URLs
- If an action fails twice, switch strategy: try coordinates instead of selectors, use keyboard typing without a selector, or use [NEED_INPUT]
- After each action you'll receive a new screenshot showing the result`;

export function buildSystemPrompt(goal: string): string {
  return `${SYSTEM_PROMPT}\n\nYour goal: ${goal}`;
}

export function parseAction(text: string): BrowserAction | null {
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1]! : null;

  if (!jsonStr) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonStr.trim());
    if (parsed && typeof parsed.action === "string") {
      return parsed as BrowserAction;
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

function isActionResult(result: unknown): result is ActionResult {
  return typeof result === "object" && result !== null && "screenshot" in result;
}

function trimScreenshotHistory(messages: Anthropic.MessageParam[]): void {
  let screenshotCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "user" || !Array.isArray(msg.content)) {
      continue;
    }

    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j]!;
      if (block.type === "image") {
        screenshotCount++;
        if (screenshotCount > MAX_SCREENSHOTS_IN_HISTORY) {
          (msg.content as Anthropic.ContentBlockParam[])[j] = {
            type: "text",
            text: "[previous screenshot — see latest]",
          };
        }
      }
    }
  }
}

function buildSessionTurn(
  iteration: number,
  assistantText: string,
  action: BrowserAction | null,
  outcome: SessionTurn["action_outcome"],
  opts?: { error?: string; url?: string; title?: string; consecutiveErrors?: number },
): SessionTurn {
  const errors = opts?.consecutiveErrors ?? consecutiveErrors;
  return {
    iteration,
    timestamp: new Date().toISOString(),
    assistant_text: assistantText,
    parsed_action: action,
    action_outcome: outcome,
    action_error: opts?.error,
    screenshot_file: null,
    page_url: opts?.url,
    page_title: opts?.title,
    consecutive_errors: errors,
    retry_nudge_injected: errors >= 2,
  };
}

async function runLoop(): Promise<BrowserTaskResult> {
  const client = getClient();
  const page = await getPage();

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    logger.info({ iteration, goal: currentGoal }, "Browser agent iteration");

    trimScreenshotHistory(conversationMessages);

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(currentGoal),
      messages: conversationMessages,
    });

    const assistantText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    logger.info({ iteration, reasoning: assistantText.slice(0, 500) }, "Browser agent response");

    conversationMessages.push({ role: "assistant", content: assistantText });

    if (assistantText.includes("[DONE]")) {
      const summary = assistantText.split("[DONE]").pop()?.trim() || "Task completed";
      logger.info({ iteration, summary }, "Browser task completed");
      recordSessionTurn(buildSessionTurn(iteration, assistantText, null, "signal_done"));
      return { status: "done", summary };
    }

    if (assistantText.includes("[NEED_INPUT]")) {
      const question = assistantText.split("[NEED_INPUT]").pop()?.trim() || "I need more information";
      logger.info({ iteration, question }, "Browser task needs input");
      recordSessionTurn(buildSessionTurn(iteration, assistantText, null, "signal_need_input"));
      return {
        status: "needs_input",
        question,
        context: `On page: ${page.url()}`,
      };
    }

    const action = parseAction(assistantText);
    if (!action) {
      logger.warn({ iteration }, "Browser agent returned unparseable action");
      recordSessionTurn(buildSessionTurn(iteration, assistantText, null, "parse_failure"));
      conversationMessages.push({
        role: "user",
        content: [{ type: "text", text: "I couldn't parse an action from your response. Please respond with a valid JSON action block." }],
      });
      continue;
    }

    logger.info({ iteration, action }, "Executing browser action");
    const result = await executeAction(page, action);

    if (!isActionResult(result)) {
      consecutiveErrors++;
      logger.warn({ iteration, action: action.action, error: result.error, consecutiveErrors }, "Browser action failed");
      recordSessionTurn(buildSessionTurn(iteration, assistantText, action, "error_no_screenshot", { error: result.error }));
      let errorText = `Action failed: ${result.error}`;
      if (consecutiveErrors >= 2) {
        errorText += `\n\n${RETRY_NUDGE}`;
      }
      conversationMessages.push({
        role: "user",
        content: [{ type: "text", text: errorText }],
      });
      continue;
    }

    if (result.error) {
      consecutiveErrors++;
      logger.warn(
        { iteration, action: action.action, error: result.error, consecutiveErrors },
        "Browser action failed (with screenshot)",
      );
    } else {
      consecutiveErrors = 0;
      logger.info(
        { iteration, url: result.metadata.url, title: result.metadata.title },
        "Browser action succeeded",
      );
    }

    recordSessionTurn(
      buildSessionTurn(
        iteration,
        assistantText,
        action,
        result.error ? "error_with_screenshot" : "success",
        { error: result.error, url: result.metadata.url, title: result.metadata.title },
      ),
      result.screenshot,
    );

    const userContent: Anthropic.ContentBlockParam[] = [];

    if (result.error) {
      userContent.push({
        type: "text",
        text: `Action error: ${result.error}`,
      });
    }

    userContent.push(
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: result.screenshot.toString("base64"),
        },
      },
      {
        type: "text",
        text: `Page: ${result.metadata.url} — ${result.metadata.title}`,
      },
    );

    if (consecutiveErrors >= 2) {
      userContent.push({
        type: "text",
        text: RETRY_NUDGE,
      });
    }

    conversationMessages.push({ role: "user", content: userContent });
  }

  logger.warn({ iterations: MAX_ITERATIONS, url: page.url() }, "Browser task hit max iterations");
  return {
    status: "max_iterations",
    summary: `Reached maximum of ${MAX_ITERATIONS} iterations. Last page: ${page.url()}`,
  };
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
  conversationMessages = [];
  currentGoal = goal;
  consecutiveErrors = 0;

  const page = await getPage();

  try {
    await page.goto(url, { waitUntil: "load", timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const screenshot = await page.screenshot({ type: "jpeg", quality: 75 });
    const pageTitle = await page.title();

    startSession({
      goal,
      startUrl: url,
      model: MODEL,
      initialScreenshot: screenshot,
      pageUrl: url,
      pageTitle,
    });

    conversationMessages.push({
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: screenshot.toString("base64"),
          },
        },
        {
          type: "text",
          text: `I've navigated to ${url}. Page title: ${pageTitle}\n\nGoal: ${goal}\n\nWhat's your first action?`,
        },
      ],
    });

    const result = await runLoop();
    if (result.status !== "needs_input") {
      endSession(result);
      busy = false;
    }
    return result;
  } catch (err) {
    busy = false;
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Browser task failed");
    const errorResult: BrowserTaskResult = { status: "error", error: message };
    endSession(errorResult);
    return errorResult;
  }
}

export async function continueBrowserTask(userResponse: string): Promise<BrowserTaskResult> {
  if (conversationMessages.length === 0) {
    return { status: "error", error: "No active browser session to continue. Start a new browser_task first." };
  }

  logger.info({ userResponse: userResponse.slice(0, 200) }, "Continuing browser task");

  conversationMessages.push({
    role: "user",
    content: [{ type: "text", text: `User responded: ${userResponse}\n\nPlease continue with the task.` }],
  });

  try {
    const result = await runLoop();
    if (result.status !== "needs_input") {
      endSession(result);
      busy = false;
    }
    return result;
  } catch (err) {
    busy = false;
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Browser task continue failed");
    const errorResult: BrowserTaskResult = { status: "error", error: message };
    endSession(errorResult);
    return errorResult;
  }
}
