import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";
import { getClient } from "../../ai/client.js";
import { logger } from "../../logger.js";
import { getInteractiveElements, formatA11yTree } from "./a11y.js";
import { captureWithLabels } from "./set-of-mark.js";
import { executeAction, parseAction, isActionResult, type BrowserAction, type ActionResult } from "./actions.js";
import type { SubTask, ActorResult, PageMetadata, A11yElement } from "./types.js";
import { recordSessionTurn } from "./eval/capture.js";

export const ACTOR_MODEL = process.env["ACTOR_MODEL"] || "claude-haiku-4-5-20251001";
const MAX_SCREENSHOTS_IN_HISTORY = 2;

const RETRY_NUDGE =
  "You have failed multiple actions in a row. Try a completely different approach: use x/y coordinates instead of selectors, use keyboard navigation (Tab/Enter), or respond with [NEED_INPUT] to ask the user for help.";

export const ACTOR_SYSTEM_PROMPT = `You execute browser automation sub-tasks. You see a labeled screenshot and an accessibility tree listing interactive elements.

Available actions (respond with a JSON code block):
\`\`\`
{ "action": "click", "label": 3 }
{ "action": "click", "selector": "css selector" }
{ "action": "click", "x": 100, "y": 200 }
{ "action": "type", "selector": "css selector", "text": "...", "press_enter": true }
{ "action": "type", "text": "..." }
{ "action": "fill", "selector": "css selector", "text": "..." }
{ "action": "hover", "label": 5 }
{ "action": "hover", "selector": "css selector" }
{ "action": "select", "selector": "css selector", "label": "Option text" }
{ "action": "scroll", "direction": "down", "amount": 500 }
{ "action": "press_key", "key": "Escape" }
{ "action": "wait", "seconds": 2 }
{ "action": "go_back" }
{ "action": "navigate", "url": "https://..." }
\`\`\`

Prefer clicking by label number [N] from the accessibility tree. Fall back to CSS selectors or x/y coordinates if needed.
Respond with brief reasoning then exactly ONE action JSON block.
If you need user input (credentials, CAPTCHA, etc.), respond with [NEED_INPUT] followed by your question.
If the sub-task is already complete based on what you see, respond with [DONE] followed by a summary.`;

export function resolveLabel(
  action: BrowserAction,
  elements: A11yElement[],
): BrowserAction | { error: string } {
  if (action.action === "click" && "label" in action && typeof action.label === "number") {
    const el = elements.find((e) => e.label === action.label);
    if (!el) {
      return { error: `Label [${action.label}] not found in accessibility tree` };
    }
    if (el.bounds) {
      return {
        action: "click",
        x: el.bounds.x + el.bounds.width / 2,
        y: el.bounds.y + el.bounds.height / 2,
      };
    }
    return { action: "click", selector: el.locator };
  }

  if (action.action === "hover" && action.label !== undefined) {
    const el = elements.find((e) => e.label === action.label);
    if (!el) {
      return { error: `Label [${action.label}] not found in accessibility tree` };
    }
    if (el.bounds) {
      return { action: "hover", x: el.bounds.x + el.bounds.width / 2, y: el.bounds.y + el.bounds.height / 2 };
    }
    return { action: "hover", selector: el.locator };
  }

  return action;
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

async function getPageMetadata(page: Page): Promise<PageMetadata> {
  return {
    url: page.url(),
    title: await page.title(),
  };
}

export function detectSignal(text: string): "done" | "need_input" | null {
  if (text.includes("[DONE]")) {
    return "done";
  }
  if (text.includes("[NEED_INPUT]")) {
    return "need_input";
  }
  return null;
}

export async function executeSubTask(
  page: Page,
  subTask: SubTask,
  initialMetadata: PageMetadata,
): Promise<ActorResult> {
  const client = getClient();
  const maxAttempts = subTask.maxAttempts || 5;
  const messages: Anthropic.MessageParam[] = [];
  let consecutiveErrors = 0;

  // Build initial user message with screenshot + a11y tree
  let elements: A11yElement[];
  let labeledScreenshot: Buffer;
  try {
    elements = await getInteractiveElements(page);
    labeledScreenshot = await captureWithLabels(page, elements);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Failed to extract interactive elements");
    const metadata = await getPageMetadata(page);
    const screenshot = await page.screenshot({ type: "jpeg", quality: 75 });
    return {
      status: "escalate",
      reason: `Failed to extract interactive elements: ${message}`,
      screenshot,
      metadata,
    };
  }
  const a11yTree = formatA11yTree(elements);

  messages.push({
    role: "user",
    content: [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: labeledScreenshot.toString("base64"),
        },
      },
      {
        type: "text",
        text: `Page: ${initialMetadata.url} — ${initialMetadata.title}\n\nAccessibility tree:\n${a11yTree}\n\nSub-task: ${subTask.instruction}`,
      },
    ],
  });

  let currentElements = elements;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    logger.info(
      { attempt, subTaskId: subTask.id, instruction: subTask.instruction },
      "Actor iteration",
    );

    trimScreenshotHistory(messages);

    const response = await client.messages.create({
      model: ACTOR_MODEL,
      max_tokens: 1024,
      system: ACTOR_SYSTEM_PROMPT,
      messages,
    });

    const assistantText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    logger.info(
      { attempt, reasoning: assistantText.slice(0, 500) },
      "Actor response",
    );

    messages.push({ role: "assistant", content: assistantText });

    // Check for signals
    const signal = detectSignal(assistantText);

    if (signal === "done") {
      const summary =
        assistantText.split("[DONE]").pop()?.trim() || "Sub-task completed";
      const metadata = await getPageMetadata(page);
      const screenshot = await page.screenshot({ type: "jpeg", quality: 75 });
      recordSessionTurn({
        iteration: attempt,
        timestamp: new Date().toISOString(),
        assistant_text: assistantText,
        parsed_action: null,
        action_outcome: "signal_done",
        screenshot_file: null,
        page_url: metadata.url,
        page_title: metadata.title,
        consecutive_errors: consecutiveErrors,
        retry_nudge_injected: false,
        layer: "actor",
        subtask_id: subTask.id,
      }, screenshot);
      return { status: "success", summary, screenshot, metadata };
    }

    if (signal === "need_input") {
      const question =
        assistantText.split("[NEED_INPUT]").pop()?.trim() ||
        "I need more information";
      recordSessionTurn({
        iteration: attempt,
        timestamp: new Date().toISOString(),
        assistant_text: assistantText,
        parsed_action: null,
        action_outcome: "signal_need_input",
        screenshot_file: null,
        consecutive_errors: consecutiveErrors,
        retry_nudge_injected: false,
        layer: "actor",
        subtask_id: subTask.id,
      });
      return {
        status: "needs_input",
        question,
        context: `Sub-task: ${subTask.instruction}\nPage: ${page.url()}`,
      };
    }

    // Parse action
    const action = parseAction(assistantText);
    if (!action) {
      consecutiveErrors++;
      logger.warn({ attempt }, "Actor returned unparseable action");
      recordSessionTurn({
        iteration: attempt,
        timestamp: new Date().toISOString(),
        assistant_text: assistantText,
        parsed_action: null,
        action_outcome: "parse_failure",
        screenshot_file: null,
        consecutive_errors: consecutiveErrors,
        retry_nudge_injected: false,
        layer: "actor",
        subtask_id: subTask.id,
      });
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "I couldn't parse an action from your response. Please respond with a valid JSON action block.",
          },
        ],
      });

      if (consecutiveErrors >= 4) {
        const metadata = await getPageMetadata(page);
        const screenshot = await page.screenshot({ type: "jpeg", quality: 75 });
        return {
          status: "escalate",
          reason: `Failed to parse action after ${consecutiveErrors} consecutive errors`,
          screenshot,
          metadata,
        };
      }
      continue;
    }

    // Resolve label references
    const resolved = resolveLabel(action, currentElements);
    if ("error" in resolved) {
      consecutiveErrors++;
      logger.warn({ attempt, error: resolved.error }, "Label resolution failed");
      recordSessionTurn({
        iteration: attempt,
        timestamp: new Date().toISOString(),
        assistant_text: assistantText,
        parsed_action: action,
        action_outcome: "error_no_screenshot",
        action_error: resolved.error,
        screenshot_file: null,
        consecutive_errors: consecutiveErrors,
        retry_nudge_injected: false,
        layer: "actor",
        subtask_id: subTask.id,
      });
      messages.push({
        role: "user",
        content: [{ type: "text", text: `Action failed: ${resolved.error}. Try a different approach.` }],
      });

      if (consecutiveErrors >= 4) {
        const metadata = await getPageMetadata(page);
        const screenshot = await page.screenshot({ type: "jpeg", quality: 75 });
        return {
          status: "escalate",
          reason: resolved.error,
          screenshot,
          metadata,
        };
      }
      continue;
    }

    // Execute action
    logger.info({ attempt, action: resolved }, "Actor executing action");
    const result = await executeAction(page, resolved);

    if (!isActionResult(result)) {
      consecutiveErrors++;
      logger.warn(
        { attempt, error: result.error, consecutiveErrors },
        "Actor action failed (no screenshot)",
      );
      recordSessionTurn({
        iteration: attempt,
        timestamp: new Date().toISOString(),
        assistant_text: assistantText,
        parsed_action: resolved,
        action_outcome: "error_no_screenshot",
        action_error: result.error,
        screenshot_file: null,
        consecutive_errors: consecutiveErrors,
        retry_nudge_injected: consecutiveErrors >= 3,
        layer: "actor",
        subtask_id: subTask.id,
      });

      let errorText = `Action failed: ${result.error}`;
      if (consecutiveErrors >= 3) {
        errorText += `\n\n${RETRY_NUDGE}`;
      }

      if (consecutiveErrors >= 4) {
        const metadata = await getPageMetadata(page);
        const screenshot = await page.screenshot({ type: "jpeg", quality: 75 });
        return {
          status: "escalate",
          reason: `Action failed: ${result.error}`,
          screenshot,
          metadata,
        };
      }

      messages.push({
        role: "user",
        content: [{ type: "text", text: errorText }],
      });
      continue;
    }

    // Action succeeded (possibly with error)
    if (result.error) {
      consecutiveErrors++;
      logger.warn(
        { attempt, error: result.error, consecutiveErrors },
        "Actor action failed (with screenshot)",
      );
    } else {
      consecutiveErrors = 0;
    }

    recordSessionTurn({
      iteration: attempt,
      timestamp: new Date().toISOString(),
      assistant_text: assistantText,
      parsed_action: resolved,
      action_outcome: result.error ? "error_with_screenshot" : "success",
      action_error: result.error,
      screenshot_file: null,
      consecutive_errors: consecutiveErrors,
      retry_nudge_injected: consecutiveErrors >= 3,
      layer: "actor",
      subtask_id: subTask.id,
    }, result.screenshot);

    // Escalate before building next message — avoids wasted nudge
    if (consecutiveErrors >= 4) {
      const metadata = await getPageMetadata(page);
      return {
        status: "escalate",
        reason: `${consecutiveErrors} consecutive failures`,
        screenshot: result.screenshot,
        metadata,
      };
    }

    // Refresh a11y tree for next iteration
    let newLabeledScreenshot: Buffer;
    try {
      currentElements = await getInteractiveElements(page);
      newLabeledScreenshot = await captureWithLabels(page, currentElements);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message }, "Failed to refresh a11y tree, falling back to previous elements");
      newLabeledScreenshot = await page.screenshot({ type: "jpeg", quality: 75 });
    }
    const newA11yTree = formatA11yTree(currentElements);
    const metadata = await getPageMetadata(page);

    const userContent: Anthropic.ContentBlockParam[] = [];

    if (result.error) {
      userContent.push({ type: "text", text: `Action error: ${result.error}` });
    }

    userContent.push(
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: newLabeledScreenshot.toString("base64"),
        },
      },
      {
        type: "text",
        text: `Page: ${metadata.url} — ${metadata.title}\n\nAccessibility tree:\n${newA11yTree}\n\nSub-task: ${subTask.instruction}`,
      },
    );

    if (consecutiveErrors >= 3) {
      userContent.push({ type: "text", text: RETRY_NUDGE });
    }

    messages.push({ role: "user", content: userContent });
  }

  // Exhausted max attempts
  const metadata = await getPageMetadata(page);
  const screenshot = await page.screenshot({ type: "jpeg", quality: 75 });
  return {
    status: "escalate",
    reason: `Exhausted ${maxAttempts} attempts for sub-task: ${subTask.instruction}`,
    screenshot,
    metadata,
  };
}
