import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright-core";
import { getClient } from "../../ai/client.js";
import { logger } from "../../logger.js";
import { getPageSnapshot, getScrollPosition, formatScrollContext, formatA11yTree } from "./a11y.js";
import { captureWithLabels } from "./set-of-mark.js";
import {
  executeActionWithRetry,
  isActionResult,
  takeScreenshot,
  type BrowserAction,
} from "./actions.js";
import type {
  SubTask,
  ActorResult,
  PageMetadata,
  A11yElement,
  StructuralElement,
} from "./types.js";
import { recordSessionTurn } from "./eval/capture.js";

export const ACTOR_MODEL = process.env["ACTOR_MODEL"] || "claude-haiku-4-5";
const MAX_SCREENSHOTS_IN_HISTORY = 2;

const RETRY_NUDGE =
  "You have failed multiple actions in a row. Try a completely different approach: use x/y coordinates instead of selectors, use keyboard navigation (Tab/Enter), or use the need_input tool to ask the user for help.";

/** Detect errors that indicate a site is actively blocking our headless browser */
function isBlockingError(error: string): boolean {
  return /ERR_HTTP2_PROTOCOL_ERROR|ERR_CONNECTION_RESET|ERR_SSL_PROTOCOL_ERROR|403 Forbidden|Target page, context or browser has been closed|browser has been closed|Browser closed/i.test(
    error,
  );
}

export const ACTOR_TOOLS: Anthropic.Tool[] = [
  {
    name: "browser_click",
    description: "Click an element on the page.",
    input_schema: {
      type: "object" as const,
      properties: {
        label: {
          type: "number",
          description: "Label number [N] from the accessibility tree",
        },
        selector: { type: "string", description: "CSS selector" },
        x: { type: "number", description: "X coordinate" },
        y: { type: "number", description: "Y coordinate" },
      },
    },
  },
  {
    name: "browser_type",
    description:
      "Type text into the focused element, or a specific element if selector is provided.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type" },
        selector: { type: "string", description: "CSS selector to type into" },
        press_enter: {
          type: "boolean",
          description: "Press Enter after typing",
        },
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
    description: "Hover over an element.",
    input_schema: {
      type: "object" as const,
      properties: {
        label: {
          type: "number",
          description: "Label number [N] from the accessibility tree",
        },
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
        selector: {
          type: "string",
          description: "CSS selector of the select element",
        },
        value: {
          type: "string",
          description: "Option value or label text to select",
        },
      },
      required: ["selector", "value"],
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the page or a specific container. Current scroll position is reported in each observation.",
    input_schema: {
      type: "object" as const,
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down"],
          description: "Scroll direction",
        },
        selector: {
          type: "string",
          description: "CSS selector of a scrollable container",
        },
        x: {
          type: "number",
          description: "X coordinate inside a scrollable area",
        },
        y: {
          type: "number",
          description: "Y coordinate inside a scrollable area",
        },
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
    description: "Navigate to a URL from the page.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL to navigate to" },
      },
      required: ["url"],
    },
  },
  {
    name: "task_complete",
    description: "Signal that the sub-task is complete.",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string",
          description: "Summary of what was accomplished",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "need_input",
    description: "Signal that user input is needed to continue.",
    input_schema: {
      type: "object" as const,
      properties: {
        question: { type: "string", description: "Question to ask the user" },
      },
      required: ["question"],
    },
  },
  {
    name: "task_failed",
    description:
      "Signal that the sub-task cannot be completed from the current page.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "Why the sub-task cannot be completed",
        },
      },
      required: ["reason"],
    },
  },
];

export const ACTOR_SYSTEM_PROMPT = `You execute browser automation sub-tasks. You see a labeled screenshot and an accessibility tree listing interactive elements.`;

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
export function toolToBrowserAction(
  name: string,
  input: Record<string, unknown>,
): BrowserAction | null {
  const action = TOOL_TO_ACTION[name];
  if (!action) {
    return null;
  }

  // Sanitize x/y coordinates — model sometimes sends strings like "1109, 342" in x
  const cleaned = { ...input };
  if ("x" in cleaned && typeof cleaned.x === "string") {
    const parts = String(cleaned.x)
      .split(",")
      .map((s) => parseFloat(s.trim()));
    if (parts.length === 2 && !isNaN(parts[0]!) && !isNaN(parts[1]!)) {
      cleaned.x = parts[0];
      cleaned.y = parts[1];
    } else if (!isNaN(parts[0]!)) {
      cleaned.x = parts[0];
    }
  }
  if ("y" in cleaned && typeof cleaned.y === "string") {
    const parsed = parseFloat(String(cleaned.y));
    if (!isNaN(parsed)) {
      cleaned.y = parsed;
    }
  }

  return { action, ...cleaned } as BrowserAction;
}

export async function resolveLabel(
  action: BrowserAction,
  elements: A11yElement[],
  page?: Page,
): Promise<BrowserAction | { error: string }> {
  if (
    action.action === "click" &&
    "label" in action &&
    typeof action.label === "number"
  ) {
    const el = elements.find((e) => e.label === action.label);
    if (!el) {
      return {
        error: `Label [${action.label}] not found in accessibility tree`,
      };
    }

    // Try fresh coordinate lookup when page is available
    const bounds = await freshBounds(el, page);
    if (bounds) {
      return {
        action: "click",
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
      };
    }
    return { action: "click", selector: el.locator };
  }

  if (action.action === "hover" && action.label !== undefined) {
    const el = elements.find((e) => e.label === action.label);
    if (!el) {
      return {
        error: `Label [${action.label}] not found in accessibility tree`,
      };
    }

    const bounds = await freshBounds(el, page);
    if (bounds) {
      return {
        action: "hover",
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
      };
    }
    return { action: "hover", selector: el.locator };
  }

  return action;
}

/** Get fresh bounding box for an element, falling back to cached bounds. */
async function freshBounds(
  el: A11yElement,
  page?: Page,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  if (page && el.bounds) {
    try {
      const role = el.role as Parameters<Page["getByRole"]>[0];
      const box = await page.getByRole(role, { name: el.name }).first().boundingBox({ timeout: 500 });
      if (box && box.width > 0 && box.height > 0) {
        // Warn if fresh coords differ significantly from cached (possible wrong element)
        const dx = Math.abs(box.x + box.width / 2 - (el.bounds.x + el.bounds.width / 2));
        const dy = Math.abs(box.y + box.height / 2 - (el.bounds.y + el.bounds.height / 2));
        if (dx > 200 || dy > 200) {
          logger.warn(
            { role, name: el.name, cached: el.bounds, fresh: box },
            "Fresh bounds differ significantly from cached — possible wrong element match",
          );
        }
        return box;
      }
    } catch {
      // Fall back to cached
    }
  }
  return el.bounds ?? null;
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
        const content = block.content as (
          | Anthropic.TextBlockParam
          | Anthropic.ImageBlockParam
        )[];
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

/** Safe screenshot + metadata for escalation paths where the browser may be dead */
async function safeEscalationState(
  page: Page,
): Promise<{ screenshot: Buffer | null; metadata: PageMetadata }> {
  try {
    const screenshot = await takeScreenshot(page);
    const metadata = await getPageMetadata(page);
    return { screenshot, metadata };
  } catch {
    return {
      screenshot: null,
      metadata: { url: "unknown", title: "Browser crashed" },
    };
  }
}

/** Generate stub tool_results for unprocessed batched tool_use blocks */
function stubResults(
  blocks: Anthropic.ToolUseBlock[],
  reason = "skipped: prior action failed",
): Anthropic.ToolResultBlockParam[] {
  return blocks.map((b) => ({
    type: "tool_result" as const,
    tool_use_id: b.id,
    content: [{ type: "text" as const, text: reason }],
  }));
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
  let textOnlyResponses = 0;
  const failedDomains = new Set<string>(blockedDomains);

  // Build initial user message with screenshot + a11y tree
  let elements: A11yElement[];
  let labeledScreenshot: Buffer;
  let structural;
  try {
    const snapshot = await getPageSnapshot(page);
    elements = snapshot.interactive;
    structural = snapshot.structural;
    labeledScreenshot = await captureWithLabels(page, elements);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Failed to extract interactive elements");
    const metadata = await getPageMetadata(page);
    const screenshot = await takeScreenshot(page);
    return {
      status: "escalate",
      reason: `Failed to extract interactive elements: ${message}`,
      screenshot,
      metadata,
    };
  }
  const scrollInfo = await getScrollPosition(page);
  const scrollLine = formatScrollContext(scrollInfo);
  const a11yTree = formatA11yTree(elements, structural);

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
        text: `Page: ${initialMetadata.url} — ${initialMetadata.title}\n${scrollLine}\n\nAccessibility tree:\n${a11yTree}\n\nSub-task: ${subTask.instruction}`,
      },
    ],
  });

  let currentElements = elements;

  while (actionsAttempted < maxAttempts) {
    logger.info(
      {
        actionsAttempted,
        subTaskId: subTask.id,
        instruction: subTask.instruction,
      },
      "Actor iteration",
    );

    trimScreenshotHistory(messages);

    const response = await client.messages.create({
      model: ACTOR_MODEL,
      max_tokens: 1024,
      system: ACTOR_SYSTEM_PROMPT,
      messages,
      tools: ACTOR_TOOLS,
      tool_choice: { type: "auto" },
    });

    // Extract reasoning text for logging
    const reasoning = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (reasoning) {
      logger.info(
        { actionsAttempted, reasoning: reasoning.slice(0, 500) },
        "Actor reasoning",
      );
    }

    // Extract all tool_use blocks
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // With tool_choice: "auto", the model may return text-only — re-prompt
    if (toolUseBlocks.length === 0) {
      textOnlyResponses++;
      logger.warn({ actionsAttempted, textOnlyResponses }, "Actor returned no tool_use blocks, re-prompting");
      if (textOnlyResponses >= 3) {
        const { screenshot, metadata } = await safeEscalationState(page);
        return {
          status: "escalate",
          reason: "Actor failed to use tools after repeated prompting",
          screenshot,
          metadata,
        };
      }
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: [{ type: "text", text: "Please take an action using one of the available tools." }],
      });
      continue;
    }

    if (toolUseBlocks.length > 1) {
      logger.info(
        { count: toolUseBlocks.length, tools: toolUseBlocks.map((b) => b.name) },
        "Actor returned batched actions",
      );
    }

    // Push the full assistant message (includes tool_use blocks for conversation threading)
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let earlyReturn: ActorResult | null = null;

    for (let i = 0; i < toolUseBlocks.length; i++) {
      const toolUseBlock = toolUseBlocks[i]!;
      const remaining = toolUseBlocks.slice(i + 1);
      const isLast = i === toolUseBlocks.length - 1;
      const toolName = toolUseBlock.name;
      const toolInput = toolUseBlock.input as Record<string, unknown>;

      // --- Handle signal tools ---

      if (toolName === "task_complete") {
        const summary = String(toolInput["summary"] || "Sub-task completed");
        const metadata = await getPageMetadata(page);
        const screenshot = await takeScreenshot(page);

        // Reject task_complete if the page is in an error state
        const isErrorPage =
          metadata.url.startsWith("chrome-error://") ||
          metadata.url === "about:blank";
        if (isErrorPage) {
          logger.warn(
            { actionsAttempted, url: metadata.url },
            "Actor claimed task_complete but page is in error state",
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUseBlock.id,
            is_error: true,
            content: [
              {
                type: "text",
                text: `The current page is ${metadata.url} — this is a browser error page, not a successful outcome. The task is NOT complete. Try a different approach.`,
              },
            ],
          });
          toolResults.push(...stubResults(remaining));
          actionsAttempted++;
          break;
        }

        recordSessionTurn(
          {
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
          },
          screenshot,
        );
        toolResults.push(...stubResults(remaining));
        earlyReturn = { status: "success", summary, screenshot, metadata };
        break;
      }

      if (toolName === "need_input") {
        const question = String(
          toolInput["question"] || "I need more information",
        );
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
        toolResults.push(...stubResults(remaining));
        earlyReturn = {
          status: "needs_input",
          question,
          context: `Sub-task: ${subTask.instruction}\nPage: ${page.url()}`,
        };
        break;
      }

      if (toolName === "task_failed") {
        const reason = String(
          toolInput["reason"] || "Sub-task cannot be completed",
        );
        const { screenshot, metadata } = await safeEscalationState(page);
        recordSessionTurn(
          {
            iteration: actionsAttempted,
            timestamp: new Date().toISOString(),
            assistant_text: reasoning,
            parsed_action: null,
            action_outcome: "signal_failed",
            screenshot_file: null,
            page_url: metadata.url,
            page_title: metadata.title,
            consecutive_errors: consecutiveErrors,
            retry_nudge_injected: false,
            layer: "actor",
            subtask_id: subTask.id,
          },
          screenshot ?? undefined,
        );
        toolResults.push(...stubResults(remaining));
        earlyReturn = {
          status: "escalate",
          reason,
          screenshot,
          metadata,
        };
        break;
      }

      // --- Handle browser action tools ---

      const action = toolToBrowserAction(toolName, toolInput);
      if (!action) {
        logger.warn({ toolName }, "Actor used unknown tool");
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUseBlock.id,
          is_error: true,
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        });
        toolResults.push(...stubResults(remaining));
        actionsAttempted++;
        break;
      }

      // Resolve label references
      const resolved = await resolveLabel(action, currentElements, page);
      if ("error" in resolved) {
        consecutiveErrors++;
        logger.warn(
          { actionsAttempted, error: resolved.error },
          "Label resolution failed",
        );
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

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUseBlock.id,
          is_error: true,
          content: [{ type: "text", text: errorText }],
        });
        toolResults.push(...stubResults(remaining));

        if (consecutiveErrors >= 4) {
          const { screenshot, metadata } = await safeEscalationState(page);
          earlyReturn = {
            status: "escalate",
            reason: resolved.error,
            screenshot,
            metadata,
            ...(failedDomains.size > 0
              ? { failedDomains: [...failedDomains] }
              : {}),
          };
        }
        actionsAttempted++;
        break;
      }

      // Reject navigate to known-blocked domains immediately
      if (resolved.action === "navigate" && resolved.url) {
        try {
          const domain = new URL(resolved.url).hostname;
          if (failedDomains.has(domain)) {
            toolResults.push(...stubResults(remaining));
            const { screenshot, metadata } = await safeEscalationState(page);
            earlyReturn = {
              status: "escalate",
              reason: `${domain} is blocked — cannot navigate there`,
              screenshot,
              metadata,
              blockedUrl: resolved.url,
              failedDomains: [...failedDomains],
            };
            break;
          }
        } catch {
          // Invalid URL, let executeAction handle it
        }
      }

      // Execute action
      actionsAttempted++;
      logger.info(
        { actionsAttempted, action: resolved, batchIndex: i, batchSize: toolUseBlocks.length },
        "Actor executing action",
      );
      const result = await executeActionWithRetry(page, resolved);

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
            toolResults.push(...stubResults(remaining));
            const { screenshot, metadata } = await safeEscalationState(page);
            earlyReturn = {
              status: "escalate",
              reason: `${resolved.url} is blocking our browser`,
              screenshot,
              metadata,
              blockedUrl: resolved.url,
              failedDomains: [...failedDomains],
            };
            break;
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

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUseBlock.id,
          is_error: true,
          content: [{ type: "text", text: errorText }],
        });
        toolResults.push(...stubResults(remaining));

        if (consecutiveErrors >= 4) {
          const { screenshot, metadata } = await safeEscalationState(page);
          earlyReturn = {
            status: "escalate",
            reason: `Action failed: ${result.error}`,
            screenshot,
            metadata,
            ...(failedDomains.size > 0
              ? { failedDomains: [...failedDomains] }
              : {}),
          };
        }
        break;
      }

      // Popup opened but the target site blocked our browser — return immediately with the URL
      if (result.popupFailedUrl) {
        try {
          failedDomains.add(new URL(result.popupFailedUrl).hostname);
        } catch {
          // Invalid URL, skip domain tracking
        }
        toolResults.push(...stubResults(remaining));
        const { screenshot, metadata } = await safeEscalationState(page);
        earlyReturn = {
          status: "escalate",
          reason: `Click opened popup to ${result.popupFailedUrl} but the site blocked our browser`,
          screenshot,
          metadata,
          blockedUrl: result.popupFailedUrl,
          failedDomains: [...failedDomains],
        };
        break;
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
            toolResults.push(...stubResults(remaining));
            const { metadata } = await safeEscalationState(page);
            earlyReturn = {
              status: "escalate",
              reason: `${resolved.url} is blocking our browser`,
              screenshot: result.screenshot,
              metadata,
              blockedUrl: resolved.url,
              failedDomains: [...failedDomains],
            };
            break;
          }
        }

        logger.warn(
          { actionsAttempted, error: result.error, consecutiveErrors },
          "Actor action failed (with screenshot)",
        );
      } else {
        consecutiveErrors = 0;
      }

      recordSessionTurn(
        {
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
        },
        result.screenshot,
      );

      // Escalate on too many consecutive errors
      if (consecutiveErrors >= 4) {
        toolResults.push(...stubResults(remaining));
        const metadata = await getPageMetadata(page);
        earlyReturn = {
          status: "escalate",
          reason: `${consecutiveErrors} consecutive failures`,
          screenshot: result.screenshot,
          metadata,
          ...(failedDomains.size > 0
            ? { failedDomains: [...failedDomains] }
            : {}),
        };
        break;
      }

      // --- Intermediate vs last action observation ---

      if (!isLast) {
        // Intermediate success — lightweight result, skip observation
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUseBlock.id,
          content: [{ type: "text", text: "ok" }],
        });
        continue;
      }

      // Last action — full observation (screenshot + a11y tree)
      const viewportOnly = ["wait", "hover", "screenshot"].includes(resolved.action);

      let newLabeledScreenshot: Buffer;
      let newA11yTree: string;
      let newStructural: StructuralElement[] | undefined;
      if (viewportOnly) {
        newLabeledScreenshot = await takeScreenshot(page);
        newA11yTree = formatA11yTree(currentElements);
      } else {
        try {
          const snapshot = await getPageSnapshot(page);
          currentElements = snapshot.interactive;
          newStructural = snapshot.structural;
          newLabeledScreenshot = await captureWithLabels(page, currentElements);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(
            { err: message },
            "Failed to refresh a11y tree, falling back to previous elements",
          );
          newLabeledScreenshot = await takeScreenshot(page);
        }
        newA11yTree = formatA11yTree(currentElements, newStructural);
      }
      const metadata = await getPageMetadata(page);
      const newScrollInfo = await getScrollPosition(page);
      const newScrollLine = formatScrollContext(newScrollInfo);

      const toolResultContent: (
        | Anthropic.TextBlockParam
        | Anthropic.ImageBlockParam
      )[] = [];

      if (result.error) {
        toolResultContent.push({
          type: "text",
          text: `Action error: ${result.error}`,
        });
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
          text: `Page: ${metadata.url} — ${metadata.title}\n${newScrollLine}\n\nAccessibility tree:\n${newA11yTree}\n\nSub-task: ${subTask.instruction}`,
        },
      );

      if (consecutiveErrors >= 3) {
        toolResultContent.push({ type: "text", text: RETRY_NUDGE });
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUseBlock.id,
        content: toolResultContent,
      });
    }

    // Push all tool results as a single user message
    if (toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });
    }

    if (earlyReturn) {
      return earlyReturn;
    }
  }

  // Exhausted max attempts
  const { screenshot, metadata } = await safeEscalationState(page);
  return {
    status: "escalate",
    reason: `Exhausted ${actionsAttempted} actions for sub-task: ${subTask.instruction}`,
    screenshot,
    metadata,
    ...(failedDomains.size > 0 ? { failedDomains: [...failedDomains] } : {}),
  };
}
