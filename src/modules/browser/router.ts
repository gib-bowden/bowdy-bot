import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright-core";
import { getClient } from "../../ai/client.js";
import { logger } from "../../logger.js";
import { executeSubTask } from "./actor.js";
import { verify } from "./verifier.js";
import type { ProgressEntry, PageMetadata, SubTask, BrowserTaskResult } from "./types.js";
import { DEFAULT_BROWSER_MODEL } from "./types.js";
import { recordSessionTurn } from "./eval/capture.js";

const MAX_ROUTER_ITERATIONS = 10;
export const ROUTER_MODEL = process.env["ROUTER_MODEL"] || DEFAULT_BROWSER_MODEL;

const ROUTER_TOOLS: Anthropic.Tool[] = [
  {
    name: "dispatch_subtask",
    description:
      "Dispatch a sub-task to the Actor for execution. The Actor can see the page and interact with it. Give action-oriented instructions (click, fill, navigate) — the Actor should make progress toward the goal, not just observe and report back.",
    input_schema: {
      type: "object" as const,
      properties: {
        instruction: {
          type: "string",
          description: "Specific instruction for what the Actor should do",
        },
        success_criteria: {
          type: "string",
          description: "How to verify the sub-task succeeded",
        },
      },
      required: ["instruction", "success_criteria"],
    },
  },
  {
    name: "signal_done",
    description: "Signal that the overall goal has been accomplished.",
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
    name: "signal_needs_input",
    description: "Signal that user input is needed to continue.",
    input_schema: {
      type: "object" as const,
      properties: {
        question: {
          type: "string",
          description: "Question to ask the user",
        },
      },
      required: ["question"],
    },
  },
];

function formatProgressLog(log: ProgressEntry[]): string {
  if (log.length === 0) {
    return "No steps completed yet.";
  }
  return log
    .map(
      (e) =>
        `Step ${e.stepNumber}: ${e.subTask} → ${e.outcome}: ${e.stateDescription}`,
    )
    .join("\n");
}

function buildRouterSystemPrompt(
  goal: string,
  progressLog: ProgressEntry[],
  blockedDomains: Set<string>,
): string {
  const today = new Date();
  const dateStr = today.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  let prompt = `You are a browser automation planner. You can see the page via screenshots.

Today is ${dateStr}.

Your goal: ${goal}

Use your tools to accomplish the goal:
- dispatch_subtask: Break the goal into specific, small steps and dispatch them one at a time
- signal_done: When the goal is fully accomplished
- signal_needs_input: When you need information from the user (credentials, choices, etc.)

Guidelines:
- Use the search engine on the current page to discover URLs before navigating. Only navigate directly to URLs you found in search results or on the current page.
- Write action-oriented sub-task instructions — tell the Actor to DO things (click, fill, submit), not to scout and report back. The Actor should take actions toward the goal, not describe what it sees.
- When a sub-task is escalated or failed, adapt your strategy for the next attempt. Do NOT retry the same approach.
- Always resolve relative dates (e.g. "this Friday", "tomorrow") to concrete dates in sub-task instructions so the Actor knows exactly what to select.`;

  if (blockedDomains.size > 0) {
    prompt += `\n\nBLOCKED DOMAINS (unreachable, do not use): ${[...blockedDomains].join(", ")}`;
  }

  prompt += `\n\nProgress so far:\n${formatProgressLog(progressLog)}\n\nProvide brief reasoning before each tool call.`;
  return prompt;
}

function generateSubTaskId(): string {
  return `st_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface RouterLoopOpts {
  existingProgressLog?: ProgressEntry[];
  userResponse?: string;
}

export async function runRouterLoop(
  page: Page,
  goal: string,
  initialScreenshot: Buffer,
  pageMetadata: PageMetadata,
  opts?: RouterLoopOpts,
): Promise<{ result: BrowserTaskResult; progressLog: ProgressEntry[] }> {
  const client = getClient();
  const progressLog: ProgressEntry[] = opts?.existingProgressLog
    ? [...opts.existingProgressLog]
    : [];
  const blockedDomains = new Set<string>();

  let currentScreenshot = initialScreenshot;
  let currentMetadata = pageMetadata;

  // If resuming with a user response, add it to the progress log
  if (opts?.userResponse) {
    progressLog.push({
      stepNumber: progressLog.length + 1,
      subTask: "User response received",
      outcome: "success",
      stateDescription: `User responded: ${opts.userResponse}`,
      timestamp: new Date().toISOString(),
    });
  }

  for (let iteration = 0; iteration < MAX_ROUTER_ITERATIONS; iteration++) {
    logger.info({ iteration, goal }, "Router iteration");

    // Intentionally single-turn per iteration — no multi-turn tool_use conversation.
    // Continuity is maintained via the progress log in the system prompt.
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: currentScreenshot.toString("base64"),
            },
          },
          {
            type: "text",
            text: `Page: ${currentMetadata.url} — ${currentMetadata.title}`,
          },
        ],
      },
    ];

    const response = await client.messages.create({
      model: ROUTER_MODEL,
      max_tokens: 1024,
      system: buildRouterSystemPrompt(goal, progressLog, blockedDomains),
      tools: ROUTER_TOOLS,
      messages,
    });

    // Find tool_use blocks
    const toolUseBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    const textBlocks = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (textBlocks) {
      logger.info(
        { iteration, reasoning: textBlocks.slice(0, 500) },
        "Router reasoning",
      );
    }

    if (!toolUseBlock) {
      // Model returned text without a tool call — re-prompt
      logger.warn({ iteration }, "Router returned no tool_use, re-prompting");
      recordSessionTurn({
        iteration,
        timestamp: new Date().toISOString(),
        assistant_text: textBlocks,
        parsed_action: null,
        action_outcome: "parse_failure",
        screenshot_file: null,
        consecutive_errors: 0,
        retry_nudge_injected: false,
        layer: "router",
        router_decision: "none",
      }, currentScreenshot);
      // Continue to next iteration — the system prompt already has progress log context
      continue;
    }

    const toolName = toolUseBlock.name;
    const toolInput = toolUseBlock.input as Record<string, unknown>;

    if (toolName === "signal_done") {
      const summary = String(toolInput["summary"] || "Task completed");
      logger.info({ iteration, summary }, "Router signaled done");
      recordSessionTurn({
        iteration,
        timestamp: new Date().toISOString(),
        assistant_text: textBlocks,
        parsed_action: null,
        action_outcome: "signal_done",
        screenshot_file: null,
        consecutive_errors: 0,
        retry_nudge_injected: false,
        layer: "router",
        router_decision: "signal_done",
      }, currentScreenshot);
      return {
        result: { status: "done", summary },
        progressLog,
      };
    }

    if (toolName === "signal_needs_input") {
      const question =
        String(toolInput["question"] || "I need more information");
      logger.info({ iteration, question }, "Router needs input");
      recordSessionTurn({
        iteration,
        timestamp: new Date().toISOString(),
        assistant_text: textBlocks,
        parsed_action: null,
        action_outcome: "signal_need_input",
        screenshot_file: null,
        consecutive_errors: 0,
        retry_nudge_injected: false,
        layer: "router",
        router_decision: "signal_needs_input",
      }, currentScreenshot);
      return {
        result: {
          status: "needs_input",
          question,
          context: formatProgressLog(progressLog),
        },
        progressLog,
      };
    }

    if (toolName === "dispatch_subtask") {
      const instruction = String(toolInput["instruction"] || "");
      const successCriteria = String(toolInput["success_criteria"] || "");

      const subTask: SubTask = {
        id: generateSubTaskId(),
        instruction,
        successCriteria,
      };

      logger.info(
        { iteration, subTaskId: subTask.id, instruction },
        "Router dispatching sub-task",
      );

      recordSessionTurn({
        iteration,
        timestamp: new Date().toISOString(),
        assistant_text: textBlocks,
        parsed_action: null,
        action_outcome: "success",
        screenshot_file: null,
        consecutive_errors: 0,
        retry_nudge_injected: false,
        layer: "router",
        router_decision: "dispatch_subtask",
        router_instruction: instruction,
      }, currentScreenshot);

      const actorResult = await executeSubTask(page, subTask, currentMetadata, blockedDomains);

      if (actorResult.status === "needs_input") {
        // Bubble up to caller
        progressLog.push({
          stepNumber: progressLog.length + 1,
          subTask: instruction,
          outcome: "needs_input",
          stateDescription: actorResult.question,
          timestamp: new Date().toISOString(),
        });

        return {
          result: {
            status: "needs_input",
            question: actorResult.question,
            context: formatProgressLog(progressLog),
          },
          progressLog,
        };
      }

      // Actor found the URL but the site blocked our browser — send link directly to user
      if (actorResult.status === "escalate" && actorResult.blockedUrl) {
        progressLog.push({
          stepNumber: progressLog.length + 1,
          subTask: instruction,
          outcome: "escalated",
          stateDescription: actorResult.reason,
          timestamp: new Date().toISOString(),
        });
        return {
          result: {
            status: "done",
            summary: `I found the link but the site blocked our browser. Here it is: ${actorResult.blockedUrl}`,
          },
          progressLog,
        };
      }

      if (
        actorResult.status === "success" ||
        actorResult.status === "escalate"
      ) {
        let verifiedPass = false;
        let stateDescription = "";

        if (actorResult.status === "success") {
          const verifierResult = await verify(
            actorResult.screenshot,
            successCriteria,
            actorResult.metadata,
            subTask.id,
            iteration,
          );
          verifiedPass = verifierResult.pass;
          stateDescription = verifiedPass
            ? verifierResult.description
            : `${verifierResult.description} (Actor reported: ${actorResult.summary})`;
        } else {
          stateDescription = actorResult.reason;
          if (actorResult.failedDomains) {
            for (const domain of actorResult.failedDomains) {
              blockedDomains.add(domain);
            }
          }
        }

        const outcome: ProgressEntry["outcome"] =
          actorResult.status === "success" && verifiedPass
            ? "success"
            : actorResult.status === "escalate"
              ? "escalated"
              : "failed";

        progressLog.push({
          stepNumber: progressLog.length + 1,
          subTask: instruction,
          outcome,
          stateDescription,
          timestamp: new Date().toISOString(),
        });

        // Update current screenshot/metadata for next iteration
        currentScreenshot = actorResult.screenshot;
        currentMetadata = actorResult.metadata;

        logger.info(
          { iteration, outcome, stateDescription: stateDescription.slice(0, 200) },
          "Sub-task completed",
        );
      }

      continue;
    }

    // Unknown tool — should not happen
    logger.warn({ toolName }, "Router used unknown tool");
    recordSessionTurn({
      iteration,
      timestamp: new Date().toISOString(),
      assistant_text: textBlocks,
      parsed_action: null,
      action_outcome: "parse_failure",
      screenshot_file: null,
      consecutive_errors: 0,
      retry_nudge_injected: false,
      layer: "router",
      router_decision: toolName,
    }, currentScreenshot);
  }

  logger.warn(
    { iterations: MAX_ROUTER_ITERATIONS },
    "Router hit max iterations",
  );
  recordSessionTurn({
    iteration: MAX_ROUTER_ITERATIONS,
    timestamp: new Date().toISOString(),
    assistant_text: "",
    parsed_action: null,
    action_outcome: "error_no_screenshot",
    screenshot_file: null,
    consecutive_errors: 0,
    retry_nudge_injected: false,
    layer: "router",
    router_decision: "max_iterations",
  }, currentScreenshot);
  return {
    result: {
      status: "max_iterations",
      summary: `Router reached maximum of ${MAX_ROUTER_ITERATIONS} iterations. Progress: ${formatProgressLog(progressLog)}`,
    },
    progressLog,
  };
}
