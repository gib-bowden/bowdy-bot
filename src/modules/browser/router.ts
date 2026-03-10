import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright-core";
import { getClient } from "../../ai/client.js";
import { logger } from "../../logger.js";
import { executeSubTask } from "./actor.js";
import { verify } from "./verifier.js";
import { takeScreenshot, validateUrl } from "./actions.js";
import type { ProgressEntry, PageMetadata, SubTask, BrowserTaskResult } from "./types.js";
import { DEFAULT_BROWSER_MODEL } from "./types.js";
import { recordSessionTurn } from "./eval/capture.js";

const MAX_ROUTER_ITERATIONS = 25; // Safety net — stall detection should kick in first
const MAX_CONSECUTIVE_STALLS = 3; // Stop after 3 iterations with no forward progress
export const ROUTER_MODEL = process.env["ROUTER_MODEL"] || DEFAULT_BROWSER_MODEL;

const ROUTER_TOOLS: Anthropic.Tool[] = [
  {
    name: "dispatch_subtask",
    description:
      "Dispatch a sub-task to the browser Actor, which can see and interact with the current page.",
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
    description:
      "Ask the user for information the goal requires that hasn't been provided. Use this whenever the next step depends on details like credentials, personal info, preferences, or ambiguous choices. This is the only way to get information from the user — the Actor cannot ask them directly.",
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
  {
    name: "recover_from_failure",
    description:
      "Recover from a failed subtask by trying a different strategy. Use this when a subtask fails or escalates instead of retrying the same approach.",
    input_schema: {
      type: "object" as const,
      properties: {
        strategy: {
          type: "string",
          enum: ["go_back", "try_alternative_url", "restart_from_beginning", "simplify_goal"],
          description: "Recovery strategy to attempt",
        },
        details: {
          type: "string",
          description: "Alternative URL (for try_alternative_url), simplified goal text (for simplify_goal), or explanation",
        },
      },
      required: ["strategy"],
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
  failureHistory: Map<string, string[]>,
  recoveryCount: number,
): string {
  const today = new Date();
  const dateStr = today.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  let prompt = `You plan and execute tasks in a web browser. Today is ${dateStr}.

Your goal: ${goal}`;

  if (blockedDomains.size > 0) {
    prompt += `\n\nBlocked domains: ${[...blockedDomains].join(", ")}`;
  }

  if (failureHistory.size > 0) {
    const failures = [...failureHistory.entries()]
      .map(([instruction, reasons]) => `- "${instruction}": ${reasons.join("; ")}`)
      .join("\n");
    prompt += `\n\nPrevious failures (do not retry the same approach):\n${failures}`;
  }

  if (recoveryCount > 0) {
    const remaining = MAX_RECOVERY_ACTIONS - recoveryCount;
    if (remaining > 0) {
      prompt += `\n\nRecovery actions used: ${recoveryCount}/${MAX_RECOVERY_ACTIONS}. ${remaining} remaining before you must signal done or needs_input.`;
    } else {
      prompt += `\n\nAll recovery actions exhausted. You must signal_done or signal_needs_input now.`;
    }
  }

  prompt += `\n\nProgress so far:\n${formatProgressLog(progressLog)}`;
  return prompt;
}

const MAX_RECOVERY_ACTIONS = 2;

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
): Promise<{ result: BrowserTaskResult; progressLog: ProgressEntry[]; routerIterations: number }> {
  const client = getClient();
  const progressLog: ProgressEntry[] = opts?.existingProgressLog
    ? [...opts.existingProgressLog]
    : [];
  const blockedDomains = new Set<string>();
  const failureHistory = new Map<string, string[]>();
  let recoveryCount = 0;

  let currentGoal = goal;
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

  let lastOutcome: "success" | "failed" | "escalated" | null = null;
  let consecutiveStalls = 0;

  for (let iteration = 0; iteration < MAX_ROUTER_ITERATIONS; iteration++) {
    logger.info({ iteration, goal: currentGoal }, "Router iteration");

    // Send screenshot on first iteration and after failed/escalated subtasks.
    // After successful subtasks, the verifier's text description in the progress log is sufficient.
    const includeScreenshot = iteration === 0 || lastOutcome !== "success";

    // Intentionally single-turn per iteration — no multi-turn tool_use conversation.
    // Continuity is maintained via the progress log in the system prompt.
    const userContent: Anthropic.ContentBlockParam[] = [];
    if (includeScreenshot) {
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: currentScreenshot.toString("base64"),
        },
      });
    }
    userContent.push({
      type: "text",
      text: `Page: ${currentMetadata.url} — ${currentMetadata.title}`,
    });

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: userContent },
    ];

    const response = await client.messages.create({
      model: ROUTER_MODEL,
      max_tokens: 1024,
      system: buildRouterSystemPrompt(currentGoal, progressLog, blockedDomains, failureHistory, recoveryCount),
      tools: ROUTER_TOOLS,
      tool_choice: { type: "any" },
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
        routerIterations: iteration + 1,
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
        routerIterations: iteration + 1,
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
          routerIterations: iteration + 1,
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
          routerIterations: iteration + 1,
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

        // Track failures for recovery context
        if (outcome === "failed" || outcome === "escalated") {
          const existing = failureHistory.get(instruction) ?? [];
          existing.push(stateDescription);
          failureHistory.set(instruction, existing);

          // Include lastActions context if available
          if (actorResult.status === "escalate" && actorResult.lastActions) {
            const actionDetails = actorResult.lastActions
              .map((a) => `${a.action}: ${a.error}`)
              .join(", ");
            existing.push(`Last actions: ${actionDetails}`);
          }
        }

        progressLog.push({
          stepNumber: progressLog.length + 1,
          subTask: instruction,
          outcome,
          stateDescription,
          timestamp: new Date().toISOString(),
        });

        // Update current screenshot/metadata for next iteration
        if (actorResult.screenshot) {
          currentScreenshot = actorResult.screenshot;
        }
        currentMetadata = actorResult.metadata;

        lastOutcome = outcome;

        if (outcome === "success") {
          consecutiveStalls = 0;
        } else {
          consecutiveStalls++;
          if (consecutiveStalls >= MAX_CONSECUTIVE_STALLS) {
            logger.warn(
              { iteration, consecutiveStalls },
              "Router stalled — too many consecutive failures",
            );
            return {
              result: {
                status: "max_iterations",
                summary: `Stopped after ${consecutiveStalls} consecutive failed sub-tasks. Progress: ${formatProgressLog(progressLog)}`,
              },
              progressLog,
              routerIterations: iteration + 1,
            };
          }
        }

        logger.info(
          { iteration, outcome, stateDescription: stateDescription.slice(0, 200) },
          "Sub-task completed",
        );
      }

      continue;
    }

    if (toolName === "recover_from_failure") {
      const strategy = String(toolInput["strategy"] || "go_back");
      const details = String(toolInput["details"] || "");

      if (recoveryCount >= MAX_RECOVERY_ACTIONS) {
        logger.warn({ iteration, recoveryCount }, "Recovery limit reached");
        progressLog.push({
          stepNumber: progressLog.length + 1,
          subTask: `Recovery: ${strategy}`,
          outcome: "failed",
          stateDescription: "Recovery limit reached — must signal done or needs_input",
          timestamp: new Date().toISOString(),
        });
        lastOutcome = "failed";
        continue;
      }

      recoveryCount++;
      logger.info({ iteration, strategy, details }, "Router executing recovery");

      try {
        switch (strategy) {
          case "go_back":
            await page.goBack({ waitUntil: "load", timeout: 10000 }).catch(() => {});
            break;

          case "restart_from_beginning":
            await page.goto(pageMetadata.url, { waitUntil: "load", timeout: 15000 });
            break;

          case "try_alternative_url": {
            const urlError = validateUrl(details);
            if (urlError) {
              progressLog.push({
                stepNumber: progressLog.length + 1,
                subTask: `Recovery: try_alternative_url`,
                outcome: "failed",
                stateDescription: `Invalid URL: ${urlError}`,
                timestamp: new Date().toISOString(),
              });
              lastOutcome = "failed";
              continue;
            }
            await page.goto(details, { waitUntil: "load", timeout: 15000 });
            break;
          }

          case "simplify_goal":
            if (details) {
              currentGoal = details;
            }
            break;
        }

        // Wait for settle and take screenshot
        await new Promise((resolve) => setTimeout(resolve, 1000));
        currentScreenshot = await takeScreenshot(page);
        currentMetadata = {
          url: page.url(),
          title: await page.title(),
        };

        progressLog.push({
          stepNumber: progressLog.length + 1,
          subTask: `Recovery: ${strategy}`,
          outcome: "success",
          stateDescription: `Recovered via ${strategy}${details ? `: ${details}` : ""}. Now at ${currentMetadata.url}`,
          timestamp: new Date().toISOString(),
        });
        lastOutcome = "success";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err: message, strategy }, "Recovery action failed");
        progressLog.push({
          stepNumber: progressLog.length + 1,
          subTask: `Recovery: ${strategy}`,
          outcome: "failed",
          stateDescription: `Recovery failed: ${message}`,
          timestamp: new Date().toISOString(),
        });
        lastOutcome = "failed";
      }

      recordSessionTurn({
        iteration,
        timestamp: new Date().toISOString(),
        assistant_text: textBlocks,
        parsed_action: null,
        action_outcome: lastOutcome === "success" ? "success" : "error_no_screenshot",
        screenshot_file: null,
        consecutive_errors: 0,
        retry_nudge_injected: false,
        layer: "router",
        router_decision: `recover_${strategy}`,
      }, currentScreenshot);

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
    routerIterations: MAX_ROUTER_ITERATIONS,
  };
}
