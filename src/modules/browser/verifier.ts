import type Anthropic from "@anthropic-ai/sdk";
import { getClient } from "../../ai/client.js";
import type { PageMetadata, VerifierResult } from "./types.js";
import { recordSessionTurn } from "./eval/capture.js";

const VERIFIER_MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT =
  "You verify whether a browser automation step succeeded. Given a screenshot and success criteria, respond with exactly: PASS or FAIL followed by a one-line description of the current page state.";

export function parseVerifierResponse(text: string): {
  pass: boolean;
  description: string;
} {
  const trimmed = text.trim();
  if (trimmed.startsWith("PASS")) {
    return {
      pass: true,
      description: trimmed.slice(4).replace(/^[\s:—-]+/, "").trim(),
    };
  }
  return {
    pass: false,
    description: trimmed.startsWith("FAIL")
      ? trimmed.slice(4).replace(/^[\s:—-]+/, "").trim()
      : trimmed,
  };
}

export async function verify(
  screenshot: Buffer,
  successCriteria: string,
  pageMetadata: PageMetadata,
  subtaskId?: string,
  routerIteration?: number,
): Promise<VerifierResult> {
  const client = getClient();

  const response = await client.messages.create({
    model: VERIFIER_MODEL,
    max_tokens: 128,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: screenshot.toString("base64"),
            },
          },
          {
            type: "text",
            text: `Page: ${pageMetadata.url} — ${pageMetadata.title}\n\nSuccess criteria: ${successCriteria}`,
          },
        ],
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const { pass, description } = parseVerifierResponse(text);

  recordSessionTurn({
    iteration: routerIteration ?? 0,
    timestamp: new Date().toISOString(),
    assistant_text: text,
    parsed_action: null,
    action_outcome: pass ? "success" : "error_with_screenshot",
    screenshot_file: null,
    page_url: pageMetadata.url,
    page_title: pageMetadata.title,
    consecutive_errors: 0,
    retry_nudge_injected: false,
    layer: "verifier",
    subtask_id: subtaskId,
    verifier_pass: pass,
    verifier_description: description,
  }, screenshot);

  return { pass, description, screenshot };
}
