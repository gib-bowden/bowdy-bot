import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright-core";
import { getClient } from "../../ai/client.js";
import { logger } from "../../logger.js";
import { getInteractiveElements, formatA11yTree } from "./a11y.js";
import { captureWithLabels } from "./set-of-mark.js";
import { executeAction, isActionResult, type BrowserAction } from "./actions.js";
import type { SubTask, ActorResult, PageMetadata, A11yElement } from "./types.js";
import { recordSessionTurn } from "./eval/capture.js";

export const ACTOR_MODEL = process.env["ACTOR_MODEL"] || "claude-haiku-4-5";
const MAX_SCREENSHOTS_IN_HISTORY = 2;

const RETRY_NUDGE =
  "You have failed multiple actions in a row. Try a completely different approach: use x/y coordinates instead of selectors, use keyboard navigation (Tab/Enter), or use the need_input tool to ask the user for help.";

/** Detect errors that indicate a site is actively blocking our headless browser */
function isBlockingError(error: string): boolean {
  return /ERR_HTTP2_PROTOCOL_ERROR|ERR_CONNECTION_RESET|ERR_SSL_PROTOCOL_ERROR|403 Forbidden/i.test(error);
}

export const ACTOR_TOOLS: Anthropic.Tool[] = [
  {
    name: "browser_click",
    description: "Click an element on the page. Prefer clicking by label number [N]. Fall back to CSS selectors or x/y coordinates if needed.",
    input_schema: {
      type: "object" as const,
      properties: {
        label: { type: "number", description: "Label number from the accessibility tree" },
        selector: { type: "string", description: "CSS selector" },
        x: { type: "number", description: "X coordinate" },
        y: { type: "number", description: "Y coordinate" },
      },
    },
  },
  {
    name: "browser_type",
    description: "Type text, optionally into a specific element. If no selector is provided, types into the currently focused element.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Text to type" },
        selector: { type: "string", description: "CSS selector to type into" },
        press_enter: { type: "boolean", description: "Press Enter after typing" },
      },
      required: ["text"],
    },
  },
  {
    name: "browser_fill",
    description: "Fill a form field with text (clears existing content first).",
    input_schema: {
      type: "object" as const,
      properties: {
        selector: { type: "string", description: "CSS selector of the input" },
        text: { type: "string", description: "Text to fill" },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "browser_hover",
    description: "Hover over an element. Prefer hovering by label number [N].",
    input_schema: {
      type: "object" as const,
      properties: {
        label: { type: "number", description: "Label number from the accessibility tree" },
        selector: { type: "string", description: "CSS selector" },
        x: { type: "number", description: "X coordinate" },
        y: { type: "number", description: "Y coordinate" },
      },
    },
  },
  {
    name: "browser_select",
    description: "Select an option from a dropdown/select element.",
    input_schema: {
      type: "object" as const,
      properties: {
        selector: { type: "string", description: "CSS selector of the select element" },
        value: { type: "string", description: "Option value or label text to select" },
      },
      required: ["selector", "value"],
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the page up or down.",
    input_schema: {
      type: "object" as const,
      properties: {
        direction: { type: "string", enum: ["up", "down"], description: "Scroll direction" },
        amount: { type: "number", description: "Pixels to scroll (default 500)" },
      },
      required: ["direction"],
    },
  },
  {
    name: "browser_press_key",
    description: "Press a keyboard key (e.g. Enter, Escape, Tab, ArrowDown).",
    input_schema: {
      type: "object" as const,
      properties: {
        key: { type: "string", description: "Key to press" },
      },
      required: ["key"],
    },
  },
  {
    name: "browser_wait",
    description: "Wait for a specified number of seconds.",
    input_schema: {
      type: "object" as const,
      properties: {
        seconds: { type: "number", description: "Seconds to wait (default 2)" },
      },
    },
  },
  {
    name: "browser_go_back",
    description: "Navigate back to the previous page.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "browser_navigate",
    description: "Navigate to a URL. ONLY use URLs that appear verbatim in the accessibility tree or page content. NEVER guess, modify, or construct URLs.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL to navigate to (must be from the page)" },
      },
      required: ["url"],
    },
  },
  {
    name: "task_complete",
    description: "Signal that the sub-task is complete. Before calling this, verify the current page URL and screenshot match the expected outcome. Do NOT call this if the page shows an error.",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: { type: "string", description: "Summary of what was accomplished" },
      },
      required: ["summary"],
    },
  },
  {
    name: "need_input",
    description: "Signal that user input is needed (credentials, CAPTCHA, ambiguous choice, etc.).",
    input_schema: {
      type: "object" as const,
      properties: {
        question: { type: "string", description: "Question to ask the user" },
      },
      required: ["question"],
    },
  },
];

export const ACTOR_SYSTEM_PROMPT = `You execute browser automation sub-tasks. You see a labeled screenshot and an accessibility tree listing interactive elements.

Rules:
- Prefer clicking by label number [N]. Fall back to CSS selectors or x/y coordinates if needed.
- ONLY use browser_navigate with URLs that appear verbatim in the accessibility tree or page content. NEVER guess, modify, or construct URLs.
- Before calling task_complete, verify the current page URL and screenshot match the expected outcome. If the URL is "chrome-error://" or blank, the task is NOT complete — try a different approach instead.
- Provide brief reasoning in your text response before each tool call.`;

const TOOL_TO_ACTION: Record<string, string> = {
  browser_click: "click",
  browser_type: "type",
  browser_fill: "fill",
  browser_hover: "hover",
  browser_select: "select",
  browser_scroll: "scroll",
  browser_press_key: "press_key",
  browser_wait: "wait",
  browser_go_back: "go_back",
  browser_navigate: "navigate",
};

/** Convert a tool_use block into a BrowserAction for resolveLabel + executeAction. */
export function toolToBrowserAction(name: string, input: Record<string, unknown>): BrowserAction | null {
  const action = TOOL_TO_ACTION[name];
  if (!action) {
    return null;
  }
  return { action, ...input } as BrowserAction;
}

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

      // Top-level image blocks
      if (block.type === "image") {
        screenshotCount++;
        if (screenshotCount > MAX_SCREENSHOTS_IN_HISTORY) {
          (msg.content as Anthropic.ContentBlockParam[])[j] = {
            type: "text",
            text: "[previous screenshot — see latest]",
          };
        }
      }

      // Images inside tool_result content blocks
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        const content = block.content as (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[];
        for (let k = content.length - 1; k >= 0; k--) {
          const inner = content[k]!;
          if (inner.type === "image") {
            screenshotCount++;
            if (screenshotCount > MAX_SCREENSHOTS_IN_HISTORY) {
              content[k] = {
                type: "text",
                text: "[previous screenshot — see latest]",
              };
            }
          }
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

export async function executeSubTask(
  page: Page,
  subTask: SubTask,
  initialMetadata: PageMetadata,
  blockedDomains?: Set<string>,
): Promise<ActorResult> {
  const client = getClient();
  const maxAttempts = subTask.maxAttempts || 8;
  const messages: Anthropic.MessageParam[] = [];
  let consecutiveErrors = 0;
  let actionsAttempted = 0;
  const failedDomains = new Set<string>(blockedDomains);

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

  while (actionsAttempted < maxAttempts) {
    logger.info(
      { actionsAttempted, subTaskId: subTask.id, instruction: subTask.instruction },
      "Actor iteration",
    );

    trimScreenshotHistory(messages);

    const response = await client.messages.create({
      model: ACTOR_MODEL,
      max_tokens: 1024,
      system: ACTOR_SYSTEM_PROMPT,
      messages,
      tools: ACTOR_TOOLS,
      tool_choice: { type: "any" },
    });

    // Extract reasoning text for logging
    const reasoning = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (reasoning) {
      logger.info({ actionsAttempted, reasoning: reasoning.slice(0, 500) }, "Actor reasoning");
    }

    // Find tool_use block
    const toolUseBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (!toolUseBlock) {
      // Should not happen with tool_choice: "any", but handle gracefully
      logger.warn({ actionsAttempted }, "Actor returned no tool_use block");
      break;
    }

    // Push the full assistant message (includes tool_use block for conversation threading)
    messages.push({ role: "assistant", content: response.content });

    const toolName = toolUseBlock.name;
    const toolInput = toolUseBlock.input as Record<string, unknown>;

    // --- Handle signal tools ---

    if (toolName === "task_complete") {
      const summary = String(toolInput["summary"] || "Sub-task completed");
      const metadata = await getPageMetadata(page);
      const screenshot = await page.screenshot({ type: "jpeg", quality: 75 });

      // Reject task_complete if the page is in an error state
      const isErrorPage = metadata.url.startsWith("chrome-error://") || metadata.url === "about:blank";
      if (isErrorPage) {
        logger.warn({ actionsAttempted, url: metadata.url }, "Actor claimed task_complete but page is in error state");
        messages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: toolUseBlock.id,
            is_error: true,
            content: [{ type: "text", text: `The current page is ${metadata.url} — this is a browser error page, not a successful outcome. The task is NOT complete. Try a different approach.` }],
          }],
        });
        actionsAttempted++;
        continue;
      }

      recordSessionTurn({
        iteration: actionsAttempted,
        timestamp: new Date().toISOString(),
        assistant_text: reasoning,
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

    if (toolName === "need_input") {
      const question = String(toolInput["question"] || "I need more information");
      recordSessionTurn({
        iteration: actionsAttempted,
        timestamp: new Date().toISOString(),
        assistant_text: reasoning,
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

    // --- Handle browser action tools ---

    const action = toolToBrowserAction(toolName, toolInput);
    if (!action) {
      logger.warn({ toolName }, "Actor used unknown tool");
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolUseBlock.id,
          is_error: true,
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        }],
      });
      actionsAttempted++;
      continue;
    }

    // Resolve label references
    const resolved = resolveLabel(action, currentElements);
    if ("error" in resolved) {
      consecutiveErrors++;
      logger.warn({ actionsAttempted, error: resolved.error }, "Label resolution failed");
      recordSessionTurn({
        iteration: actionsAttempted,
        timestamp: new Date().toISOString(),
        assistant_text: reasoning,
        parsed_action: action,
        action_outcome: "error_no_screenshot",
        action_error: resolved.error,
        screenshot_file: null,
        consecutive_errors: consecutiveErrors,
        retry_nudge_injected: false,
        layer: "actor",
        subtask_id: subTask.id,
      });

      let errorText = `Action failed: ${resolved.error}. Try a different approach.`;
      if (consecutiveErrors >= 3) {
        errorText += `\n\n${RETRY_NUDGE}`;
      }

      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolUseBlock.id,
          is_error: true,
          content: [{ type: "text", text: errorText }],
        }],
      });

      if (consecutiveErrors >= 4) {
        const metadata = await getPageMetadata(page);
        const screenshot = await page.screenshot({ type: "jpeg", quality: 75 });
        return {
          status: "escalate",
          reason: resolved.error,
          screenshot,
          metadata,
          ...(failedDomains.size > 0 ? { failedDomains: [...failedDomains] } : {}),
        };
      }
      actionsAttempted++;
      continue;
    }

    // Reject navigate to known-blocked domains immediately
    if (resolved.action === "navigate" && resolved.url) {
      try {
        const domain = new URL(resolved.url).hostname;
        if (failedDomains.has(domain)) {
          const metadata = await getPageMetadata(page);
          const screenshot = await page.screenshot({ type: "jpeg", quality: 75 });
          return {
            status: "escalate",
            reason: `${domain} is blocked — cannot navigate there`,
            screenshot,
            metadata,
            blockedUrl: resolved.url,
            failedDomains: [...failedDomains],
          };
        }
      } catch {
        // Invalid URL, let executeAction handle it
      }
    }

    // Execute action
    actionsAttempted++;
    logger.info({ actionsAttempted, action: resolved }, "Actor executing action");
    const result = await executeAction(page, resolved);

    if (!isActionResult(result)) {
      consecutiveErrors++;

      // Track failed domains for navigate actions
      if (resolved.action === "navigate" && resolved.url) {
        try {
          const domain = new URL(resolved.url).hostname;
          failedDomains.add(domain);
        } catch {
          // Invalid URL, ignore
        }

        // Site is blocking our browser — escalate immediately with the URL
        if (isBlockingError(result.error)) {
          const metadata = await getPageMetadata(page);
          const screenshot = await page.screenshot({ type: "jpeg", quality: 75 });
          return {
            status: "escalate",
            reason: `${resolved.url} is blocking our browser`,
            screenshot,
            metadata,
            blockedUrl: resolved.url,
            failedDomains: [...failedDomains],
          };
        }
      }

      logger.warn(
        { actionsAttempted, error: result.error, consecutiveErrors },
        "Actor action failed (no screenshot)",
      );
      recordSessionTurn({
        iteration: actionsAttempted,
        timestamp: new Date().toISOString(),
        assistant_text: reasoning,
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
      if (resolved.action === "navigate") {
        errorText += `\nThis site is blocking our browser. Do NOT retry this domain. Try a completely different site or approach.`;
      }
      if (failedDomains.size > 0) {
        errorText += `\nBlocked domains (do not retry): ${[...failedDomains].join(", ")}`;
      }
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
          ...(failedDomains.size > 0 ? { failedDomains: [...failedDomains] } : {}),
        };
      }

      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolUseBlock.id,
          is_error: true,
          content: [{ type: "text", text: errorText }],
        }],
      });
      continue;
    }

    // Popup opened but the target site blocked our browser — return immediately with the URL
    if (result.popupFailedUrl) {
      try {
        failedDomains.add(new URL(result.popupFailedUrl).hostname);
      } catch {
        // Invalid URL, skip domain tracking
      }
      const metadata = await getPageMetadata(page);
      const screenshot = await page.screenshot({ type: "jpeg", quality: 75 });
      return {
        status: "escalate",
        reason: `Click opened popup to ${result.popupFailedUrl} but the site blocked our browser`,
        screenshot,
        metadata,
        blockedUrl: result.popupFailedUrl,
        failedDomains: [...failedDomains],
      };
    }

    // Action succeeded (possibly with error)
    if (result.error) {
      consecutiveErrors++;

      // Track failed domains for navigate actions (screenshot was still captured)
      if (resolved.action === "navigate" && resolved.url) {
        try {
          const domain = new URL(resolved.url).hostname;
          failedDomains.add(domain);
        } catch {
          // Invalid URL, ignore
        }

        // Site is blocking our browser — escalate immediately with the URL
        if (isBlockingError(result.error)) {
          const metadata = await getPageMetadata(page);
          return {
            status: "escalate",
            reason: `${resolved.url} is blocking our browser`,
            screenshot: result.screenshot,
            metadata,
            blockedUrl: resolved.url,
            failedDomains: [...failedDomains],
          };
        }
      }

      logger.warn(
        { actionsAttempted, error: result.error, consecutiveErrors },
        "Actor action failed (with screenshot)",
      );
    } else {
      consecutiveErrors = 0;
    }

    recordSessionTurn({
      iteration: actionsAttempted,
      timestamp: new Date().toISOString(),
      assistant_text: reasoning,
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
        ...(failedDomains.size > 0 ? { failedDomains: [...failedDomains] } : {}),
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

    const toolResultContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = [];

    if (result.error) {
      toolResultContent.push({ type: "text", text: `Action error: ${result.error}` });
    }

    if (result.unchanged) {
      toolResultContent.push({
        type: "text",
        text: "The page didn't change after your click. If the link opens a new tab, try using browser_navigate with the link's href from the accessibility tree instead.",
      });
    }

    if (failedDomains.size > 0) {
      toolResultContent.push({
        type: "text",
        text: `Blocked domains (do not retry): ${[...failedDomains].join(", ")}`,
      });
    }

    toolResultContent.push(
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
      toolResultContent.push({ type: "text", text: RETRY_NUDGE });
    }

    messages.push({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: toolUseBlock.id,
        content: toolResultContent,
      }],
    });
  }

  // Exhausted max attempts
  const metadata = await getPageMetadata(page);
  const screenshot = await page.screenshot({ type: "jpeg", quality: 75 });
  return {
    status: "escalate",
    reason: `Exhausted ${actionsAttempted} actions for sub-task: ${subTask.instruction}`,
    screenshot,
    metadata,
    ...(failedDomains.size > 0 ? { failedDomains: [...failedDomains] } : {}),
  };
}
