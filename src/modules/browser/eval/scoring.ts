import type Anthropic from "@anthropic-ai/sdk";
import { getClient } from "../../../ai/client.js";
import type { BrowserAction } from "../actions.js";

const COORDINATE_TOLERANCE = 50;
const GRADER_MODEL = "claude-sonnet-4-6";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  screenshot_file?: string;
}

export interface ForbiddenAction {
  action: string;
  pattern?: string;
}

export interface EvalFixture {
  id: string;
  goal: string;
  screenshot_file: string;
  page_url: string;
  page_title: string;
  acceptable_actions: BrowserAction[];
  action_intent: string;
  category?: "iframe" | "stuck" | "url_guessing" | "need_input";
  conversation_history?: ConversationTurn[];
  expected_signal?: "NEED_INPUT" | "DONE";
  forbidden_actions?: ForbiddenAction[];
}

export type ScoreTier = "exact" | "intent" | "type_only" | "fail";

export interface ScoreResult {
  pass: boolean;
  tier: ScoreTier;
  details: string;
}

export interface EvalResult {
  fixtureId: string;
  model: string;
  action: BrowserAction | null;
  reasoning: string;
  score: ScoreResult;
  durationMs: number;
}

export function scoreActionType(
  actual: BrowserAction,
  acceptable: BrowserAction[],
): boolean {
  return acceptable.some((a) => a.action === actual.action);
}

export function scoreExactMatch(
  actual: BrowserAction,
  acceptable: BrowserAction[],
): boolean {
  return acceptable.some((expected) => {
    if (actual.action !== expected.action) {
      return false;
    }

    // Coordinate click: use tolerance
    if (
      actual.action === "click" &&
      expected.action === "click" &&
      actual.x !== undefined &&
      actual.y !== undefined &&
      expected.x !== undefined &&
      expected.y !== undefined
    ) {
      const dx = actual.x - expected.x;
      const dy = actual.y - expected.y;
      return Math.sqrt(dx * dx + dy * dy) <= COORDINATE_TOLERANCE;
    }

    // Deep equality for other actions
    return JSON.stringify(actual) === JSON.stringify(expected);
  });
}

export async function scoreIntent(
  screenshotBase64: string,
  goal: string,
  intent: string,
  actual: BrowserAction,
): Promise<{ pass: boolean; reasoning: string }> {
  if (!intent) {
    return { pass: false, reasoning: "No action_intent defined for this fixture" };
  }

  const client = getClient();

  const response = await client.messages.create({
    model: GRADER_MODEL,
    max_tokens: 256,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: screenshotBase64,
            },
          } satisfies Anthropic.ImageBlockParam,
          {
            type: "text",
            text: `You are grading a browser automation agent's action selection.

Goal: ${goal}
Expected intent: ${intent}
Agent's action: ${JSON.stringify(actual)}

Looking at the screenshot, does the agent's action achieve the expected intent? Consider whether the selector/coordinates target the right element, even if the exact selector differs from what you might expect.

Respond with exactly one line: "PASS: <brief reason>" or "FAIL: <brief reason>"`,
          },
        ],
      },
    ],
  });

  const text =
    response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
  const pass = text.toUpperCase().startsWith("PASS");
  return { pass, reasoning: text };
}

export function scoreAction(
  actual: BrowserAction | null,
  acceptable: BrowserAction[],
): ScoreResult {
  if (!actual) {
    return { pass: false, tier: "fail", details: "No action parsed from response" };
  }

  if (scoreExactMatch(actual, acceptable)) {
    return { pass: true, tier: "exact", details: "Exact match" };
  }

  if (scoreActionType(actual, acceptable)) {
    return {
      pass: false,
      tier: "type_only",
      details: `Action type matched (${actual.action}) but details differ`,
    };
  }

  return {
    pass: false,
    tier: "fail",
    details: `Expected ${acceptable.map((a) => a.action).join("/")}, got ${actual.action}`,
  };
}

export function scoreSignal(
  responseText: string,
  expectedSignal: "NEED_INPUT" | "DONE",
): ScoreResult {
  const tag = `[${expectedSignal}]`;
  if (responseText.includes(tag)) {
    return { pass: true, tier: "exact", details: `Signal ${tag} found in response` };
  }
  return { pass: false, tier: "fail", details: `Expected signal ${tag} not found in response` };
}

export function checkForbiddenActions(
  action: BrowserAction | null,
  forbidden: ForbiddenAction[],
): ScoreResult | null {
  if (!action) {
    return null;
  }
  for (const f of forbidden) {
    if (action.action !== f.action) {
      continue;
    }
    if (!f.pattern) {
      return { pass: false, tier: "fail", details: `Forbidden action type: ${action.action}` };
    }
    let valueToCheck: string | undefined;
    if (action.action === "navigate") {
      valueToCheck = action.url;
    } else if (action.action === "type") {
      valueToCheck = action.text;
    } else if (action.action === "click") {
      valueToCheck = action.selector;
    }
    if (valueToCheck && new RegExp(f.pattern, "i").test(valueToCheck)) {
      return { pass: false, tier: "fail", details: `Forbidden: ${action.action} matching /${f.pattern}/i` };
    }
  }
  return null;
}
