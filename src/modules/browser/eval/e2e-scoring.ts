import type Anthropic from "@anthropic-ai/sdk";
import { getClient } from "../../../ai/client.js";
import type { ProgressEntry } from "../types.js";

const MATCHER_MODEL = "claude-haiku-4-5-20251001";
const GRADER_MODEL = "claude-sonnet-4-6";

// ── Scenario types ──────────────────────────────────────────────

export interface E2EScenario {
  id: string;
  goal: string;
  startUrl: string;
  specificity: "vague" | "partial" | "specific";
  /** Keys are topic names, values are responses. null = terminal (eval stops). */
  inputs: Record<string, string | null>;
  maxTurns?: number;
}

export interface E2ETurn {
  question: string;
  matchedKeys: string[];
  response: string | null;
  isTerminal: boolean;
  timestamp: string;
}

export interface E2EScorecard {
  terminalReached: { pass: boolean; weight: number; details: string };
  questionQuality: { score: number; maxScore: number; weight: number; details: string };
  efficiency: { subtaskCount: number; turnCount: number; durationMs: number; weight: number };
  overall: number;
}

export interface E2EResult {
  scenarioId: string;
  model: string;
  status: "terminal_reached" | "done" | "max_turns" | "max_iterations" | "error" | "site_error";
  turns: E2ETurn[];
  progressLog: ProgressEntry[];
  scorecard: E2EScorecard;
  durationMs: number;
  error?: string;
}

// ── Input matching ──────────────────────────────────────────────

export async function matchInputs(
  question: string,
  inputs: Record<string, string | null>,
  usedKeys: Set<string>,
): Promise<{ matchedKeys: string[]; response: string | null; isTerminal: boolean }> {
  const available = Object.entries(inputs).filter(([key]) => !usedKeys.has(key));
  if (available.length === 0) {
    return { matchedKeys: [], response: null, isTerminal: true };
  }

  const client = getClient();
  const listing = available
    .map(([key, value]) => `- ${key}: ${value === null ? "(no response available — terminal)" : `"${value}"`}`)
    .join("\n");

  const resp = await client.messages.create({
    model: MATCHER_MODEL,
    max_tokens: 256,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: `A browser automation assistant asked the user this question:
"${question}"

Available user information:
${listing}

Which pieces of information are relevant to this question?

If ANY relevant item is marked "(terminal)", respond with exactly: TERMINAL
If none are relevant, respond with exactly: NONE
Otherwise respond in this format (combine values into a natural sentence):
KEYS: key1, key2
RESPONSE: A natural-language answer using the matched values`,
      },
    ],
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  if (text.startsWith("TERMINAL")) {
    const terminalKeys = available.filter(([, v]) => v === null).map(([k]) => k);
    return { matchedKeys: terminalKeys, response: null, isTerminal: true };
  }

  if (text.startsWith("NONE")) {
    return { matchedKeys: [], response: null, isTerminal: false };
  }

  const keysLine = text.match(/KEYS:\s*(.+)/);
  const responseLine = text.match(/RESPONSE:\s*([\s\S]+)/);

  const matchedKeys = keysLine
    ? keysLine[1]!.split(",").map((k) => k.trim()).filter((k) => k in inputs)
    : [];
  const response = responseLine ? responseLine[1]!.trim() : null;

  const hasTerminal = matchedKeys.some((k) => inputs[k] === null);
  if (hasTerminal) {
    return { matchedKeys, response: null, isTerminal: true };
  }

  return { matchedKeys, response, isTerminal: false };
}

// ── Question quality scoring ────────────────────────────────────

export async function scoreQuestionQuality(
  scenario: E2EScenario,
  turns: E2ETurn[],
  progressLog: ProgressEntry[],
): Promise<{ score: number; maxScore: number; details: string }> {
  const maxScore = 5;

  if (turns.length === 0 && scenario.specificity === "specific") {
    return { score: maxScore, maxScore, details: "No questions needed — all info was in the goal." };
  }

  const client = getClient();
  const resp = await client.messages.create({
    model: GRADER_MODEL,
    max_tokens: 512,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: `Grade the question-asking behavior of a browser automation assistant.

Goal given to the assistant: "${scenario.goal}"
Goal specificity: ${scenario.specificity} (${
          scenario.specificity === "vague"
            ? "very little detail — assistant SHOULD ask for most details"
            : scenario.specificity === "partial"
              ? "some detail provided — assistant should only ask for missing info"
              : "fully specified — assistant should NOT ask for info already in the goal"
        })

Information available (what the user knows):
${Object.entries(scenario.inputs)
  .map(([k, v]) => `- ${k}: ${v === null ? "(credentials/payment — terminal)" : v}`)
  .join("\n")}

Questions the assistant asked (in order):
${
  turns.length > 0
    ? turns.map((t, i) => `${i + 1}. "${t.question}" → matched: [${t.matchedKeys.join(", ")}]${t.isTerminal ? " (terminal)" : ""}`).join("\n")
    : "(no questions asked)"
}

Progress log:
${progressLog.map((e) => `Step ${e.stepNumber}: ${e.subTask} → ${e.outcome}: ${e.stateDescription}`).join("\n")}

Score 1–5:
- 5: Asked all necessary questions, none redundant, at the right times
- 4: Minor issues (slightly early/late, one unnecessary question)
- 3: Functional but missed a question or asked something unnecessary
- 2: Significant gaps — guessed at info it should have asked about
- 1: Did not ask for needed info, or asked only irrelevant questions

Respond in exactly this format:
SCORE: N
DETAILS: one paragraph`,
      },
    ],
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const scoreMatch = text.match(/SCORE:\s*(\d)/);
  const detailsMatch = text.match(/DETAILS:\s*([\s\S]+)/);

  const score = scoreMatch ? Math.min(parseInt(scoreMatch[1]!, 10), maxScore) : 0;
  const details = detailsMatch ? detailsMatch[1]!.trim() : text;

  return { score, maxScore, details };
}

// ── Scorecard computation ───────────────────────────────────────

const WEIGHT_TERMINAL = 50;
const WEIGHT_QUESTIONS = 35;
const WEIGHT_EFFICIENCY = 15;

export function computeScorecard(
  terminalReached: boolean,
  questionScore: number,
  questionMaxScore: number,
  questionDetails: string,
  subtaskCount: number,
  turnCount: number,
  durationMs: number,
): E2EScorecard {
  const terminalPoints = terminalReached ? WEIGHT_TERMINAL : 0;
  const questionPoints = (questionScore / questionMaxScore) * WEIGHT_QUESTIONS;

  // Efficiency: blend subtask count (70%) and duration (30%)
  const subtaskRatio = Math.max(0, 1 - subtaskCount / 20);
  const durationRatio = Math.max(0, 1 - durationMs / 300_000);
  const efficiencyRatio = subtaskRatio * 0.7 + durationRatio * 0.3;
  const efficiencyPoints = efficiencyRatio * WEIGHT_EFFICIENCY;

  return {
    terminalReached: {
      pass: terminalReached,
      weight: WEIGHT_TERMINAL,
      details: terminalReached
        ? "Reached terminal state (credentials/payment)"
        : "Did NOT reach terminal state",
    },
    questionQuality: {
      score: questionScore,
      maxScore: questionMaxScore,
      weight: WEIGHT_QUESTIONS,
      details: questionDetails,
    },
    efficiency: {
      subtaskCount,
      turnCount,
      durationMs,
      weight: WEIGHT_EFFICIENCY,
    },
    overall: Math.round(terminalPoints + questionPoints + efficiencyPoints),
  };
}
