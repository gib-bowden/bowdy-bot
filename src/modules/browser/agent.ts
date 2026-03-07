import type Anthropic from "@anthropic-ai/sdk";
import { getClient } from "../../ai/client.js";
import { logger } from "../../logger.js";
import { getPage } from "./session.js";
import { executeAction, validateUrl, type BrowserAction, type ActionResult } from "./actions.js";
import { recordTurn } from "./eval/capture.js";

const MAX_ITERATIONS = 20;
const MAX_SCREENSHOTS_IN_HISTORY = 3;
export const DEFAULT_BROWSER_MODEL = "claude-sonnet-4-6";
const MODEL = process.env["EVAL_MODEL"] || DEFAULT_BROWSER_MODEL;

export type BrowserTaskResult =
  | { status: "done"; summary: string }
  | { status: "needs_input"; question: string; context: string }
  | { status: "error"; error: string }
  | { status: "max_iterations"; summary: string };

// Session state — single-session only, with busy lock
let conversationMessages: Anthropic.MessageParam[] = [];
let currentGoal: string = "";
let busy = false;

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
- If an action fails, try a different approach — use x/y coordinates, scroll the page, or try a different selector
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
      return { status: "done", summary };
    }

    if (assistantText.includes("[NEED_INPUT]")) {
      const question = assistantText.split("[NEED_INPUT]").pop()?.trim() || "I need more information";
      logger.info({ iteration, question }, "Browser task needs input");
      return {
        status: "needs_input",
        question,
        context: `On page: ${page.url()}`,
      };
    }

    const action = parseAction(assistantText);
    if (!action) {
      logger.warn({ iteration }, "Browser agent returned unparseable action");
      conversationMessages.push({
        role: "user",
        content: [{ type: "text", text: "I couldn't parse an action from your response. Please respond with a valid JSON action block." }],
      });
      continue;
    }

    logger.info({ iteration, action }, "Executing browser action");
    const result = await executeAction(page, action);

    if (!isActionResult(result)) {
      logger.warn({ iteration, action: action.action, error: result.error }, "Browser action failed");
      conversationMessages.push({
        role: "user",
        content: [{ type: "text", text: `Action failed: ${result.error}` }],
      });
      continue;
    }

    logger.info(
      { iteration, url: result.metadata.url, title: result.metadata.title },
      "Browser action succeeded",
    );

    recordTurn({
      goal: currentGoal,
      screenshot: result.screenshot,
      pageUrl: result.metadata.url,
      pageTitle: result.metadata.title,
      action,
      reasoning: assistantText,
    });

    const userContent: Anthropic.ContentBlockParam[] = [
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
    ];

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

  const page = await getPage();

  try {
    await page.goto(url, { waitUntil: "load", timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const screenshot = await page.screenshot({ type: "jpeg", quality: 75 });

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
          text: `I've navigated to ${url}. Page title: ${await page.title()}\n\nGoal: ${goal}\n\nWhat's your first action?`,
        },
      ],
    });

    const result = await runLoop();
    if (result.status !== "needs_input") {
      busy = false;
    }
    return result;
  } catch (err) {
    busy = false;
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Browser task failed");
    return { status: "error", error: message };
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
      busy = false;
    }
    return result;
  } catch (err) {
    busy = false;
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Browser task continue failed");
    return { status: "error", error: message };
  }
}
