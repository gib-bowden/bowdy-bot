import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserAction } from "../actions.js";
import type { BrowserTaskResult } from "../types.js";

const RECORDING = process.env["BROWSER_EVAL_RECORD"] === "1";
const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = join(__dirname, "sessions");

export interface SessionTurn {
  iteration: number;
  timestamp: string;
  assistant_text: string;
  parsed_action: BrowserAction | null;
  action_outcome:
    | "success"
    | "error_with_screenshot"
    | "error_no_screenshot"
    | "parse_failure"
    | "signal_done"
    | "signal_failed"
    | "signal_need_input";
  action_error?: string;
  screenshot_file: string | null;
  page_url?: string;
  page_title?: string;
  consecutive_errors: number;
  retry_nudge_injected: boolean;

  // Layer-level fields (optional for backward compatibility)
  layer?: "router" | "actor" | "verifier";
  subtask_id?: string;
  router_decision?: string;
  router_instruction?: string;
  verifier_pass?: boolean;
  verifier_description?: string;
}

interface SessionRecording {
  session_id: string;
  goal: string;
  start_url: string;
  start_time: string;
  end_time?: string;
  duration_ms?: number;
  outcome?: BrowserTaskResult;
  total_turns: number;
  total_errors: number;
  model: string;
  initial_screenshot_file: string;
  turns: SessionTurn[];
}

// Module-level session state
let session: SessionRecording | null = null;
let sessionDir = "";
let startTimestamp = 0;

function flushSession(): void {
  if (!session) {
    return;
  }
  writeFileSync(
    join(sessionDir, "session.json"),
    JSON.stringify(session, null, 2) + "\n",
  );
}

export function startSession(opts: {
  goal: string;
  startUrl: string;
  model: string;
  initialScreenshot: Buffer;
  pageUrl: string;
  pageTitle: string;
}): void {
  if (!RECORDING) {
    return;
  }

  const now = new Date();
  startTimestamp = now.getTime();
  const id = now.toISOString().replace(/[:.]/g, "-");

  sessionDir = join(SESSIONS_DIR, id);
  mkdirSync(sessionDir, { recursive: true });

  writeFileSync(join(sessionDir, "initial.jpg"), opts.initialScreenshot);

  session = {
    session_id: id,
    goal: opts.goal,
    start_url: opts.startUrl,
    start_time: now.toISOString(),
    total_turns: 0,
    total_errors: 0,
    model: opts.model,
    initial_screenshot_file: "initial.jpg",
    turns: [],
  };

  flushSession();
}

export function recordSessionTurn(turn: SessionTurn, screenshot?: Buffer): void {
  if (!RECORDING || !session) {
    return;
  }

  if (screenshot) {
    const filename = `turn_${String(session.turns.length).padStart(2, "0")}.jpg`;
    writeFileSync(join(sessionDir, filename), screenshot);
    turn.screenshot_file = filename;
  }

  session.turns.push(turn);
  session.total_turns = session.turns.length;

  flushSession();
}

export function endSession(outcome: BrowserTaskResult): void {
  if (!RECORDING || !session) {
    return;
  }

  session.end_time = new Date().toISOString();
  session.duration_ms = Date.now() - startTimestamp;
  session.outcome = outcome;
  session.total_errors = session.turns.filter(
    (t) =>
      t.action_outcome === "error_with_screenshot" ||
      t.action_outcome === "error_no_screenshot" ||
      t.action_outcome === "parse_failure",
  ).length;

  flushSession();

  // Reset for next session
  session = null;
  sessionDir = "";
  startTimestamp = 0;
}
