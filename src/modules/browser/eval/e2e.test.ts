import { describe, it, expect, afterAll, beforeAll } from "vitest";
import {
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Camoufox } from "camoufox-js";
import type { Browser, Page } from "playwright-core";
import { runRouterLoop, ROUTER_MODEL } from "../router.js";
import type { RouterLoopOpts } from "../router.js";
import type { ProgressEntry, PageMetadata } from "../types.js";
import { takeScreenshot } from "../actions.js";
import {
  matchInputs,
  scoreQuestionQuality,
  computeScorecard,
  type E2EScenario,
  type E2ETurn,
  type E2EResult,
} from "./e2e-scoring.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = join(__dirname, "scenarios");
const RESULTS_DIR = join(__dirname, "results");
const SCREENSHOTS_DIR = join(__dirname, "e2e-screenshots");

const DEFAULT_MAX_TURNS = 8;
const DEFAULT_TIMEOUT_MS = 180_000; // 3 minutes per scenario
const SETTLE_MS = 1500;

function loadScenarios(): E2EScenario[] {
  if (!existsSync(SCENARIOS_DIR)) {
    return [];
  }

  const filter = process.env["EVAL_SCENARIOS"];

  return readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => !filter || f.match(new RegExp(filter.replace(/\*/g, ".*"))))
    .map((f) => {
      const raw = JSON.parse(
        readFileSync(join(SCENARIOS_DIR, f), "utf-8"),
      ) as E2EScenario;
      for (const field of [
        "id",
        "goal",
        "startUrl",
        "specificity",
        "inputs",
      ] as const) {
        if (!(field in raw) || raw[field] == null) {
          throw new Error(`Scenario ${f} is missing required field: ${field}`);
        }
      }
      return raw;
    });
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function saveScreenshot(
  scenarioId: string,
  label: string,
  screenshot: Buffer,
): void {
  const dir = join(SCREENSHOTS_DIR, scenarioId);
  ensureDir(dir);
  writeFileSync(join(dir, `${label}.jpg`), screenshot);
}

async function runE2EScenario(
  page: Page,
  scenario: E2EScenario,
): Promise<E2EResult> {
  const startTime = Date.now();
  const turns: E2ETurn[] = [];
  const usedKeys = new Set<string>();
  const maxTurns = scenario.maxTurns ?? DEFAULT_MAX_TURNS;
  let progressLog: ProgressEntry[] = [];

  // Navigate to start URL
  try {
    await page.goto(scenario.startUrl, { waitUntil: "load", timeout: 15000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return await buildResult(
      scenario,
      "site_error",
      turns,
      progressLog,
      startTime,
      msg,
    );
  }
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  let screenshot = await takeScreenshot(page);
  let metadata: PageMetadata = { url: page.url(), title: await page.title() };
  let opts: RouterLoopOpts | undefined;

  saveScreenshot(scenario.id, "00_initial", screenshot);

  for (let turn = 0; turn < maxTurns; turn++) {
    const loopResult = await runRouterLoop(
      page,
      scenario.goal,
      screenshot,
      metadata,
      opts,
    );
    progressLog = loopResult.progressLog;

    const result = loopResult.result;

    if (result.status === "done") {
      const finalScreenshot = await takeScreenshot(page);
      saveScreenshot(
        scenario.id,
        `${String(turn + 1).padStart(2, "0")}_done`,
        finalScreenshot,
      );

      return await buildResult(scenario, "done", turns, progressLog, startTime);
    }

    if (result.status === "max_iterations") {
      return await buildResult(
        scenario,
        "max_iterations",
        turns,
        progressLog,
        startTime,
      );
    }

    if (result.status === "error") {
      return await buildResult(
        scenario,
        "error",
        turns,
        progressLog,
        startTime,
        result.error,
      );
    }

    // needs_input
    const questionScreenshot = await takeScreenshot(page);
    saveScreenshot(
      scenario.id,
      `${String(turn + 1).padStart(2, "0")}_needs_input`,
      questionScreenshot,
    );

    const match = await matchInputs(result.question, scenario.inputs, usedKeys);

    const e2eTurn: E2ETurn = {
      question: result.question,
      matchedKeys: match.matchedKeys,
      response: match.response,
      isTerminal: match.isTerminal,
      timestamp: new Date().toISOString(),
    };
    turns.push(e2eTurn);

    for (const key of match.matchedKeys) {
      usedKeys.add(key);
    }

    if (match.isTerminal) {
      return await buildResult(
        scenario,
        "terminal_reached",
        turns,
        progressLog,
        startTime,
      );
    }

    // Provide the response and continue
    const userResponse =
      match.response ?? "I'm not sure, use your best judgment.";

    screenshot = await takeScreenshot(page);
    metadata = { url: page.url(), title: await page.title() };
    opts = { existingProgressLog: progressLog, userResponse };
  }

  return await buildResult(
    scenario,
    "max_turns",
    turns,
    progressLog,
    startTime,
  );
}

async function buildResult(
  scenario: E2EScenario,
  status: E2EResult["status"],
  turns: E2ETurn[],
  progressLog: ProgressEntry[],
  startTime: number,
  error?: string,
): Promise<E2EResult> {
  const durationMs = Date.now() - startTime;
  const terminalReached = status === "terminal_reached";

  const { score, maxScore, details } = await scoreQuestionQuality(
    scenario,
    turns,
    progressLog,
  );

  const subtaskCount = progressLog.filter(
    (e) => e.outcome !== "needs_input",
  ).length;

  const scorecard = computeScorecard(
    terminalReached,
    score,
    maxScore,
    details,
    subtaskCount,
    turns.length,
    durationMs,
  );

  return {
    scenarioId: scenario.id,
    model: ROUTER_MODEL,
    status,
    turns,
    progressLog,
    scorecard,
    durationMs,
    error,
  };
}

// ── Test suite ──────────────────────────────────────────────────

const allResults: E2EResult[] = [];
let browser: Browser;

describe("E2E browser evals", () => {
  const scenarios = loadScenarios();

  if (scenarios.length === 0) {
    it.skip("No scenarios found in eval/scenarios/", () => {});
    return;
  }

  beforeAll(async () => {
    browser = await Camoufox({
      headless: false,
      window: [1280, 720],
    });
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }

    if (allResults.length === 0) {
      return;
    }

    // Print summary
    console.log("\n" + "=".repeat(70));
    console.log("E2E EVAL RESULTS");
    console.log("=".repeat(70));

    for (const r of allResults) {
      const emoji =
        r.status === "terminal_reached"
          ? "PASS"
          : r.status === "done"
            ? "DONE"
            : r.status === "site_error"
              ? "SKIP"
              : "FAIL";
      console.log(
        `\n[${emoji}] ${r.scenarioId} (${r.status}) — overall: ${r.scorecard.overall}/100`,
      );
      console.log(
        `  Terminal: ${r.scorecard.terminalReached.pass ? "yes" : "NO"}`,
      );
      console.log(
        `  Questions: ${r.scorecard.questionQuality.score}/${r.scorecard.questionQuality.maxScore}`,
      );
      console.log(
        `  Efficiency: ${r.scorecard.efficiency.subtaskCount} subtasks, ${r.scorecard.efficiency.turnCount} turns, ${(r.scorecard.efficiency.durationMs / 1000).toFixed(1)}s`,
      );
      if (r.turns.length > 0) {
        console.log("  Conversation:");
        for (const t of r.turns) {
          console.log(`    Q: "${t.question}"`);
          console.log(
            `    A: ${t.isTerminal ? "(terminal)" : `"${t.response}"`} [${t.matchedKeys.join(", ") || "unmatched"}]`,
          );
        }
      }
      console.log(`  Question quality: ${r.scorecard.questionQuality.details}`);
    }
    console.log("\n" + "=".repeat(70));

    // Save results
    ensureDir(RESULTS_DIR);
    const resultsFile = join(
      RESULTS_DIR,
      `e2e_${ROUTER_MODEL.replace(/[/:]/g, "_")}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
    writeFileSync(
      resultsFile,
      JSON.stringify(
        {
          model: ROUTER_MODEL,
          timestamp: new Date().toISOString(),
          results: allResults.map((r) => ({
            scenarioId: r.scenarioId,
            status: r.status,
            overall: r.scorecard.overall,
            terminalReached: r.scorecard.terminalReached.pass,
            questionScore: r.scorecard.questionQuality.score,
            turns: r.turns,
            progressLog: r.progressLog,
            durationMs: r.durationMs,
            error: r.error,
          })),
        },
        null,
        2,
      ) + "\n",
    );
  });

  for (const scenario of scenarios) {
    it(
      `${scenario.id}: navigates to terminal state`,
      { timeout: DEFAULT_TIMEOUT_MS, retry: 1 },
      async () => {
        const page = await browser.newPage({
          viewport: { width: 1280, height: 720 },
        });
        try {
          const result = await runE2EScenario(page, scenario);
          allResults.push(result);

          console.log(
            `  [${result.scenarioId}] status=${result.status} overall=${result.scorecard.overall}/100 duration=${(result.durationMs / 1000).toFixed(1)}s`,
          );

          // Primary assertion: reached terminal state
          expect(
            result.scorecard.terminalReached.pass,
            `Did not reach terminal state. Status: ${result.status}. ` +
              `Progress: ${result.progressLog.map((e) => `${e.subTask}→${e.outcome}`).join(", ")}`,
          ).toBe(true);

          // Secondary: question quality should be reasonable
          expect(
            result.scorecard.questionQuality.score,
            `Question quality too low: ${result.scorecard.questionQuality.details}`,
          ).toBeGreaterThanOrEqual(2);
        } finally {
          await page.close();
        }
      },
    );
  }
});
