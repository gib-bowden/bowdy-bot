export interface SubTask {
  id: string;
  instruction: string;
  successCriteria: string;
  maxAttempts: number;
}

export type ActorResult =
  | { status: "success"; summary: string; screenshot: Buffer; metadata: PageMetadata }
  | { status: "needs_input"; question: string; context: string }
  | { status: "escalate"; reason: string; screenshot: Buffer; metadata: PageMetadata };

export interface VerifierResult {
  pass: boolean;
  description: string;
  screenshot: Buffer;
}

export interface ProgressEntry {
  stepNumber: number;
  subTask: string;
  outcome: "success" | "failed" | "escalated" | "needs_input";
  stateDescription: string;
  timestamp: string;
}

export interface PageMetadata {
  url: string;
  title: string;
}

export interface A11yElement {
  label: number;
  role: string;
  name: string;
  locator: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

export const DEFAULT_BROWSER_MODEL = "claude-sonnet-4-6";

export type BrowserTaskResult =
  | { status: "done"; summary: string }
  | { status: "needs_input"; question: string; context: string }
  | { status: "error"; error: string }
  | { status: "max_iterations"; summary: string };
