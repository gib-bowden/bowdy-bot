import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserAction } from "../actions.js";

const RECORDING = process.env["BROWSER_EVAL_RECORD"] === "1";
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");

let turnCounter = 0;
let sessionId = "";

interface TurnData {
  goal: string;
  screenshot: Buffer;
  pageUrl: string;
  pageTitle: string;
  action: BrowserAction;
  reasoning: string;
}

export function recordTurn(data: TurnData): void {
  if (!RECORDING) {
    return;
  }

  // Start a new session ID on the first turn
  if (turnCounter === 0) {
    sessionId = new Date().toISOString().replace(/[:.]/g, "-");
  }

  if (!existsSync(FIXTURES_DIR)) {
    mkdirSync(FIXTURES_DIR, { recursive: true });
  }

  const id = `${sessionId}_turn${turnCounter}`;
  const screenshotFile = `${id}.jpg`;

  writeFileSync(join(FIXTURES_DIR, screenshotFile), data.screenshot);

  const fixture = {
    id,
    goal: data.goal,
    screenshot_file: screenshotFile,
    page_url: data.pageUrl,
    page_title: data.pageTitle,
    actual_action: data.action,
    reasoning: data.reasoning,
    acceptable_actions: [data.action],
    action_intent: "",
  };

  writeFileSync(
    join(FIXTURES_DIR, `${id}.json`),
    JSON.stringify(fixture, null, 2) + "\n",
  );

  turnCounter++;
}

export function resetCapture(): void {
  turnCounter = 0;
  sessionId = "";
}
