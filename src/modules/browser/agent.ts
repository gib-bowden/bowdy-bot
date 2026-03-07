import type Anthropic from "@anthropic-ai/sdk";
import { getClient } from "../../ai/client.js";
import { logger } from "../../logger.js";
import { getPage } from "./session.js";
import { executeAction, type BrowserAction } from "./actions.js";

const MAX_ITERATIONS = 20;
const MAX_SCREENSHOTS_IN_HISTORY = 3;
const MODEL = "claude-haiku-4-5-20251001";

export type BrowserTaskResult =
  | { status: "done"; summary: string }
  | { status: "needs_input"; question: string; context: string }
  | { status: "error"; error: string }
  | { status: "max_iterations"; summary: string };

// Conversation state preserved between browser_task and browser_task_continue
let conversationMessages: Anthropic.MessageParam[] = [];
let currentGoal: string = "";

const SYSTEM_PROMPT = `You control a browser to accomplish tasks. You can see the page via screenshots.

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
- After each action you'll receive a new screenshot showing the result`;

function buildSystemPrompt(goal: string): string {
  return `${SYSTEM_PROMPT}\n\nYour goal: ${goal}`;
}

function parseAction(text: string): BrowserAction | null {
  // Extract JSON from a code block or raw JSON
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

function trimScreenshotHistory(messages: Anthropic.MessageParam[]): void {
  // Count screenshots from the end, strip older ones
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
          // Replace old screenshot with a text placeholder
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
    logger.debug({ iteration, goal: currentGoal }, "Browser agent iteration");

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

    // Add assistant response to history
    conversationMessages.push({ role: "assistant", content: assistantText });

    // Check for completion signals
    if (assistantText.includes("[DONE]")) {
      const summary = assistantText.split("[DONE]").pop()?.trim() || "Task completed";
      return { status: "done", summary };
    }

    if (assistantText.includes("[NEED_INPUT]")) {
      const question = assistantText.split("[NEED_INPUT]").pop()?.trim() || "I need more information";
      return {
        status: "needs_input",
        question,
        context: `On page: ${page.url()}`,
      };
    }

    // Parse and execute action
    const action = parseAction(assistantText);
    if (!action) {
      // Haiku didn't produce a valid action — ask it to try again
      conversationMessages.push({
        role: "user",
        content: [{ type: "text", text: "I couldn't parse an action from your response. Please respond with a valid JSON action block." }],
      });
      continue;
    }

    logger.debug({ action: action.action }, "Executing browser action");
    const result = await executeAction(page, action);

    if ("error" in result && !("screenshot" in result)) {
      // Fatal error — no screenshot possible
      conversationMessages.push({
        role: "user",
        content: [{ type: "text", text: `Action failed: ${result.error}` }],
      });
      continue;
    }

    // Send screenshot back to Haiku
    const userContent: Anthropic.ContentBlockParam[] = [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: (result as { screenshot: Buffer }).screenshot.toString("base64"),
        },
      },
      {
        type: "text",
        text: `Page: ${(result as { metadata: { url: string; title: string } }).metadata.url} — ${(result as { metadata: { url: string; title: string } }).metadata.title}`,
      },
    ];

    conversationMessages.push({ role: "user", content: userContent });
  }

  return {
    status: "max_iterations",
    summary: `Reached maximum of ${MAX_ITERATIONS} iterations. Last page: ${page.url()}`,
  };
}

export async function startBrowserTask(url: string, goal: string): Promise<BrowserTaskResult> {
  // Reset conversation state
  conversationMessages = [];
  currentGoal = goal;

  const page = await getPage();

  try {
    // Navigate to initial URL and take screenshot
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

    return await runLoop();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Browser task failed");
    return { status: "error", error: message };
  }
}

export async function continueBrowserTask(userResponse: string): Promise<BrowserTaskResult> {
  if (conversationMessages.length === 0) {
    return { status: "error", error: "No active browser session to continue. Start a new browser_task first." };
  }

  // Add user's response and tell Haiku to continue
  conversationMessages.push({
    role: "user",
    content: [{ type: "text", text: `User responded: ${userResponse}\n\nPlease continue with the task.` }],
  });

  try {
    return await runLoop();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Browser task continue failed");
    return { status: "error", error: message };
  }
}
