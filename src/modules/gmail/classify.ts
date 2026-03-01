import { getClient } from "../../ai/client.js";
import { logger } from "../../logger.js";
import type { EmailMessage } from "./api.js";
import { applyRules, incrementAppliedCount, type RuleMatch } from "./rules.js";

export interface ClassifiedEmail {
  message: EmailMessage;
  category: "action_needed" | "fyi" | "recommend_archive" | "unknown";
  summary: string;
  suggestedAction: string;
  ruleApplied: boolean;
}

interface HaikuClassification {
  index: number;
  category: "action_needed" | "fyi" | "recommend_archive" | "unknown";
  summary: string;
  suggestedAction: string;
}

const BATCH_SIZE = 20;

/**
 * Classify emails using rules first, then Claude Haiku for the rest.
 */
export async function classifyEmails(
  emails: EmailMessage[],
  accountEmail: string,
): Promise<ClassifiedEmail[]> {
  if (emails.length === 0) return [];

  // Step 1: Apply rules to pre-classify known senders
  const ruleMatches = applyRules(
    emails.map((e) => ({ sender: e.sender, subject: e.subject })),
    accountEmail,
  );

  const ruleMatchedIndices = new Set(ruleMatches.map((m) => m.emailIndex));
  const results: ClassifiedEmail[] = new Array(emails.length);

  // Process rule-matched emails
  for (const match of ruleMatches) {
    const email = emails[match.emailIndex]!;
    const category = ruleActionToCategory(match.rule.action);
    results[match.emailIndex] = {
      message: email,
      category,
      summary: `Auto-classified by rule: ${match.rule.matchType}=${match.rule.matchValue}`,
      suggestedAction: match.rule.action,
      ruleApplied: true,
    };
    incrementAppliedCount(match.rule.id);
  }

  // Step 2: Classify remaining emails via Claude Haiku in batches
  const unclassifiedIndices = emails
    .map((_, i) => i)
    .filter((i) => !ruleMatchedIndices.has(i));

  if (unclassifiedIndices.length > 0) {
    const batches: number[][] = [];
    for (let i = 0; i < unclassifiedIndices.length; i += BATCH_SIZE) {
      batches.push(unclassifiedIndices.slice(i, i + BATCH_SIZE));
    }

    for (const batch of batches) {
      const classifications = await classifyBatchWithHaiku(
        batch.map((i) => ({ index: i, email: emails[i]! })),
      );

      for (const c of classifications) {
        results[c.index] = {
          message: emails[c.index]!,
          category: c.category,
          summary: c.summary,
          suggestedAction: c.suggestedAction,
          ruleApplied: false,
        };
      }
    }
  }

  // Fill any gaps (shouldn't happen, but safety net)
  for (let i = 0; i < emails.length; i++) {
    if (!results[i]) {
      results[i] = {
        message: emails[i]!,
        category: "unknown",
        summary: "Classification failed",
        suggestedAction: "keep",
        ruleApplied: false,
      };
    }
  }

  return results;
}

async function classifyBatchWithHaiku(
  items: Array<{ index: number; email: EmailMessage }>,
): Promise<HaikuClassification[]> {
  const client = getClient();

  const emailList = items
    .map(
      (item, batchIdx) =>
        `[${batchIdx}] From: ${item.email.sender}\n    Subject: ${item.email.subject}\n    Preview: ${item.email.snippet.slice(0, 200)}`,
    )
    .join("\n\n");

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: `Classify these emails for a personal inbox triage. For each email, provide a JSON classification.

Categories:
- "action_needed": Requires a response or action (bills, appointments, requests, important personal mail)
- "fyi": Informational but worth seeing (order confirmations, shipping updates, account notifications)
- "recommend_archive": Low priority, no action needed (newsletters, marketing, social media notifications, promotional)
- "unknown": Can't determine from the metadata alone

Emails:
${emailList}

Respond with ONLY a JSON array, one object per email in order:
[{"index": 0, "category": "...", "summary": "one-line summary", "suggestedAction": "keep|archive|calendar|task"}]

Keep summaries under 80 characters. suggestedAction should be the most useful single action.`,
        },
      ],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      logger.warn("Haiku classification returned no JSON array");
      return items.map((item) => ({
        index: item.index,
        category: "unknown",
        summary: "Classification parse error",
        suggestedAction: "keep",
      }));
    }

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      index: number;
      category: string;
      summary: string;
      suggestedAction: string;
    }>;

    return parsed.map((p, i) => ({
      index: items[i]!.index,
      category: validateCategory(p.category),
      summary: p.summary || "No summary",
      suggestedAction: p.suggestedAction || "keep",
    }));
  } catch (err) {
    logger.error({ err }, "Haiku classification failed");
    return items.map((item) => ({
      index: item.index,
      category: "unknown" as const,
      summary: "Classification error",
      suggestedAction: "keep",
    }));
  }
}

function validateCategory(
  cat: string,
): "action_needed" | "fyi" | "recommend_archive" | "unknown" {
  const valid = ["action_needed", "fyi", "recommend_archive", "unknown"];
  return valid.includes(cat) ? (cat as ReturnType<typeof validateCategory>) : "unknown";
}

function ruleActionToCategory(
  action: string,
): "action_needed" | "fyi" | "recommend_archive" | "unknown" {
  switch (action) {
    case "archive":
      return "recommend_archive";
    case "important":
      return "action_needed";
    case "skip":
      return "recommend_archive";
    case "label":
      return "fyi";
    default:
      return "unknown";
  }
}
