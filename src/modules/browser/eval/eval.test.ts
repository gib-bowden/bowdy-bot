import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { getClient } from "../../../ai/client.js";
import { parseAction, buildSystemPrompt, DEFAULT_BROWSER_MODEL } from "../agent.js";
import {
  scoreAction,
  scoreIntent,
  scoreSignal,
  checkForbiddenActions,
  type EvalFixture,
  type EvalResult,
  type ScoreResult,
} from "./scoring.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");
const RESULTS_DIR = join(__dirname, "results");

const MODEL = process.env["EVAL_MODEL"] || DEFAULT_BROWSER_MODEL;
const EVAL_RUNS = parseInt(process.env["EVAL_RUNS"] || "1", 10);

function loadFixtures(): EvalFixture[] {
  if (!existsSync(FIXTURES_DIR)) {
    return [];
  }

  const glob = process.env["EVAL_FIXTURES"];

  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => !glob || f.match(new RegExp(glob.replace(/\*/g, ".*"))))
    .map((f) => JSON.parse(readFileSync(join(FIXTURES_DIR, f), "utf-8")) as EvalFixture)
    .filter((f) => f.acceptable_actions.length > 0 || !!f.expected_signal);
}

async function evalSingleTurn(
  fixture: EvalFixture,
): Promise<EvalResult> {
  const client = getClient();

  const screenshotPath = join(FIXTURES_DIR, fixture.screenshot_file);
  if (!existsSync(screenshotPath)) {
    return {
      fixtureId: fixture.id,
      model: MODEL,
      action: null,
      reasoning: "",
      score: { pass: false, tier: "fail", details: `Screenshot not found: ${fixture.screenshot_file}` },
      durationMs: 0,
    };
  }

  const screenshotBase64 = readFileSync(screenshotPath).toString("base64");

  const messages: Anthropic.MessageParam[] = [];

  // Prepend conversation history if present (for multi-turn fixtures like stuck detection)
  if (fixture.conversation_history) {
    for (const turn of fixture.conversation_history) {
      if (turn.role === "user" && turn.screenshot_file) {
        const turnScreenshotPath = join(FIXTURES_DIR, turn.screenshot_file);
        if (existsSync(turnScreenshotPath)) {
          const turnScreenshot = readFileSync(turnScreenshotPath).toString("base64");
          messages.push({
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: turnScreenshot,
                },
              },
              { type: "text", text: turn.content },
            ],
          });
        } else {
          messages.push({ role: turn.role, content: turn.content });
        }
      } else {
        messages.push({ role: turn.role, content: turn.content });
      }
    }
  }

  // Final turn: current screenshot + goal
  messages.push({
    role: "user",
    content: [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: screenshotBase64,
        },
      },
      {
        type: "text",
        text: `Page: ${fixture.page_url} — ${fixture.page_title}\n\nGoal: ${fixture.goal}\n\nWhat's your next action?`,
      },
    ],
  });

  const start = Date.now();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    temperature: 0,
    system: buildSystemPrompt(fixture.goal),
    messages,
  });
  const durationMs = Date.now() - start;

  const assistantText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const action = parseAction(assistantText);

  // Score based on fixture type
  let score: ScoreResult;

  if (fixture.expected_signal) {
    // Signal-based scoring (e.g., NEED_INPUT, DONE)
    score = scoreSignal(assistantText, fixture.expected_signal);
  } else {
    // Action-based scoring: try exact/type match first, then LLM intent grader
    score = scoreAction(action, fixture.acceptable_actions);

    if (score.tier === "type_only" && fixture.action_intent && action) {
      const intentResult = await scoreIntent(
        screenshotBase64,
        fixture.goal,
        fixture.action_intent,
        action,
      );
      if (intentResult.pass) {
        score = { pass: true, tier: "intent", details: intentResult.reasoning };
      }
    }
  }

  // Check forbidden actions (override score to fail if violated)
  if (fixture.forbidden_actions && action) {
    const forbiddenResult = checkForbiddenActions(action, fixture.forbidden_actions);
    if (forbiddenResult) {
      score = forbiddenResult;
    }
  }

  return {
    fixtureId: fixture.id,
    model: MODEL,
    action,
    reasoning: assistantText,
    score,
    durationMs,
  };
}

async function runWithMajorityVote(fixture: EvalFixture): Promise<EvalResult> {
  if (EVAL_RUNS <= 1) {
    return evalSingleTurn(fixture);
  }

  const results: EvalResult[] = [];
  for (let i = 0; i < EVAL_RUNS; i++) {
    results.push(await evalSingleTurn(fixture));
  }

  const passCount = results.filter((r) => r.score.pass).length;
  const majority = passCount > EVAL_RUNS / 2;

  // Return the most representative result
  const representative = results.find((r) => r.score.pass === majority) || results[0]!;
  return {
    ...representative,
    score: {
      ...representative.score,
      pass: majority,
      details: `${representative.score.details} (${passCount}/${EVAL_RUNS} passed)`,
    },
  };
}

// Collect results for summary
const allResults: EvalResult[] = [];

describe("Browser agent evals", () => {
  const fixtures = loadFixtures();

  if (fixtures.length === 0) {
    it.skip("No fixtures found — run with BROWSER_EVAL_RECORD=1 to capture some", () => {});
    return;
  }

  for (const fixture of fixtures) {
    it(`${fixture.id}: selects correct action`, async () => {
      const result = await runWithMajorityVote(fixture);
      allResults.push(result);
      expect(result.score.pass, result.score.details).toBe(true);
    }, 30000);
  }

  afterAll(() => {
    if (allResults.length === 0) {
      return;
    }

    // Print summary
    const passed = allResults.filter((r) => r.score.pass).length;
    const exact = allResults.filter((r) => r.score.tier === "exact").length;
    const intent = allResults.filter((r) => r.score.tier === "intent").length;
    const failed = allResults.filter((r) => !r.score.pass);

    console.log("\n" + "=".repeat(60));
    console.log(`Model: ${MODEL}  |  Fixtures: ${allResults.length}`);
    console.log(`Pass: ${passed}/${allResults.length} (${Math.round((passed / allResults.length) * 100)}%)  |  Exact: ${exact}  |  Intent: ${intent}  |  Fail: ${failed.length}`);

    if (failed.length > 0) {
      console.log("\nFailures:");
      for (const f of failed) {
        console.log(`  - ${f.fixtureId}: ${f.score.details}`);
      }
    }
    console.log("=".repeat(60) + "\n");

    // Save results JSON for regression tracking
    if (!existsSync(RESULTS_DIR)) {
      mkdirSync(RESULTS_DIR, { recursive: true });
    }

    const resultsFile = join(
      RESULTS_DIR,
      `${MODEL.replace(/[/:]/g, "_")}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );

    writeFileSync(
      resultsFile,
      JSON.stringify(
        {
          model: MODEL,
          timestamp: new Date().toISOString(),
          total: allResults.length,
          passed,
          exact,
          intent,
          failed: failed.length,
          results: allResults.map((r) => ({
            fixtureId: r.fixtureId,
            pass: r.score.pass,
            tier: r.score.tier,
            details: r.score.details,
            action: r.action,
            durationMs: r.durationMs,
          })),
        },
        null,
        2,
      ) + "\n",
    );
  });
});
