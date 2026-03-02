import type Anthropic from "@anthropic-ai/sdk";
import { assertUnreachable, type Module } from "../types.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { runTriageForAccount } from "./triage.js";
import { listRules, saveRule, deleteRule } from "./rules.js";
import { getDb, schema } from "../../db/client.js";
import { eq, desc } from "drizzle-orm";

interface ScanInboxInput {
  account_email?: string;
}

interface ListEmailRulesInput {
  account_email?: string;
}

interface AddEmailRuleInput {
  match_type: "sender" | "domain" | "subject_contains";
  match_value: string;
  action: "archive" | "skip" | "important" | "label";
  account_email?: string;
  label?: string;
}

interface DeleteEmailRuleInput {
  rule_id: string;
}

interface EmailTriageStatusInput {
  account_email?: string;
  limit?: number;
}

type GmailInputs = {
  scan_inbox: ScanInboxInput;
  list_email_rules: ListEmailRulesInput;
  add_email_rule: AddEmailRuleInput;
  delete_email_rule: DeleteEmailRuleInput;
  email_triage_status: EmailTriageStatusInput;
};

const tools: Anthropic.Tool[] = [
  {
    name: "scan_inbox",
    description:
      "Manually trigger an email triage scan for a specific Gmail account. " +
      "Scans unread emails, classifies them, and sends a triage summary email from the family account. " +
      "Use this to run triage outside the normal schedule.",
    input_schema: {
      type: "object" as const,
      properties: {
        account_email: {
          type: "string",
          description:
            "Gmail address to triage. If omitted, triages all configured accounts.",
        },
      },
      required: [],
    },
  },
  {
    name: "list_email_rules",
    description:
      "Show all email triage rules for an account. Rules auto-classify or auto-archive emails from known senders/domains.",
    input_schema: {
      type: "object" as const,
      properties: {
        account_email: {
          type: "string",
          description: "Filter rules by account email. Omit to show all rules.",
        },
      },
      required: [],
    },
  },
  {
    name: "add_email_rule",
    description:
      "Create a new email triage rule. Rules auto-classify emails matching the criteria, skipping LLM classification.",
    input_schema: {
      type: "object" as const,
      properties: {
        match_type: {
          type: "string",
          enum: ["sender", "domain", "subject_contains"],
          description: "What to match against",
        },
        match_value: {
          type: "string",
          description:
            "Value to match (e.g. sender email, domain name, or subject keyword)",
        },
        action: {
          type: "string",
          enum: ["archive", "skip", "important", "label"],
          description: "Action to take on matching emails",
        },
        account_email: {
          type: "string",
          description:
            "Apply rule only to this account. Omit for a global rule (all accounts).",
        },
        label: {
          type: "string",
          description: "Label name (required when action is 'label')",
        },
      },
      required: ["match_type", "match_value", "action"],
    },
  },
  {
    name: "delete_email_rule",
    description: "Remove an email triage rule by its ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        rule_id: {
          type: "string",
          description: "The rule ID to delete",
        },
      },
      required: ["rule_id"],
    },
  },
  {
    name: "email_triage_status",
    description:
      "Show recent email triage sessions, pending actions, and stats. " +
      "Useful for checking if triage is running and what's been processed.",
    input_schema: {
      type: "object" as const,
      properties: {
        account_email: {
          type: "string",
          description: "Filter by account email. Omit to show all accounts.",
        },
        limit: {
          type: "number",
          description: "Number of recent sessions to show (default 5)",
        },
      },
      required: [],
    },
  },
];

export const gmailModule: Module<GmailInputs> = {
  name: "gmail",
  description: "Gmail email triage — scan, classify, and manage inbox emails",
  tools,
  async executeTool(name, input): Promise<unknown> {
    switch (name) {
      case "scan_inbox": {
        const { account_email } = input as ScanInboxInput;
        const familyEmail = config.emailTriageFamilyAccount;
        if (!familyEmail) {
          return {
            success: false,
            error: "EMAIL_TRIAGE_FAMILY_ACCOUNT not configured.",
          };
        }

        const accounts = account_email
          ? [account_email]
          : config.emailTriageAccounts
              .split(",")
              .map((e) => e.trim())
              .filter(Boolean);

        if (accounts.length === 0) {
          return {
            success: false,
            error: "No accounts to triage. Set EMAIL_TRIAGE_ACCOUNTS.",
          };
        }

        logger.info({ accounts, familyEmail }, "Starting email triage scan");

        const results: Array<{
          account: string;
          sessionId: string | null;
          emailCount: number;
          error?: string;
        }> = [];

        for (const email of accounts) {
          try {
            logger.info({ account: email }, "Triaging account");
            const result = await runTriageForAccount(email, familyEmail);
            logger.info({ account: email, result }, "Triage result");
            results.push({
              account: email,
              sessionId: result?.sessionId ?? null,
              emailCount: result?.emailCount ?? 0,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error({ err, account: email }, "Email triage failed for account");
            results.push({
              account: email,
              sessionId: null,
              emailCount: 0,
              error: message,
            });
          }
        }

        const hasErrors = results.some((r) => r.error);
        return {
          success: !hasErrors,
          results,
          summary: results
            .map((r) => {
              if (r.error) return `${r.account}: ERROR — ${r.error}`;
              return `${r.account}: ${r.emailCount > 0 ? `${r.emailCount} emails triaged` : "no new emails"}`;
            })
            .join("; "),
        };
      }

      case "list_email_rules": {
        const { account_email: ruleAccountEmail } = input as ListEmailRulesInput;
        const rules = listRules(ruleAccountEmail);
        return {
          success: true,
          count: rules.length,
          rules: rules.map((r) => ({
            id: r.id,
            account_email: r.accountEmail ?? "all accounts",
            match_type: r.matchType,
            match_value: r.matchValue,
            action: r.action,
            label: r.label,
            applied_count: r.appliedCount,
          })),
        };
      }

      case "add_email_rule": {
        const { match_type, match_value, action, account_email: ruleAccount, label } = input as AddEmailRuleInput;
        const rule = saveRule({
          accountEmail: ruleAccount ?? null,
          matchType: match_type,
          matchValue: match_value,
          action,
          label: label ?? null,
        });
        return {
          success: true,
          rule: {
            id: rule.id,
            account_email: rule.accountEmail ?? "all accounts",
            match_type: rule.matchType,
            match_value: rule.matchValue,
            action: rule.action,
            label: rule.label,
          },
        };
      }

      case "delete_email_rule": {
        const { rule_id } = input as DeleteEmailRuleInput;
        const deleted = deleteRule(rule_id);
        return {
          success: deleted,
          message: deleted ? "Rule deleted." : "Rule not found.",
        };
      }

      case "email_triage_status": {
        const { account_email: statusAccount, limit: rawLimit } = input as EmailTriageStatusInput;
        const db = getDb();
        const limit = Math.min(rawLimit ?? 5, 20);

        const sessions = statusAccount
          ? db
              .select()
              .from(schema.emailTriageSessions)
              .where(eq(schema.emailTriageSessions.accountEmail, statusAccount))
              .orderBy(desc(schema.emailTriageSessions.createdAt))
              .limit(limit)
              .all()
          : db
              .select()
              .from(schema.emailTriageSessions)
              .orderBy(desc(schema.emailTriageSessions.createdAt))
              .limit(limit)
              .all();

        // Count pending items across all sessions
        const pendingItems = db
          .select()
          .from(schema.emailTriageItems)
          .where(eq(schema.emailTriageItems.status, "pending"))
          .all();

        const rules = listRules(statusAccount);

        return {
          success: true,
          recent_sessions: sessions.map((s) => ({
            id: s.id,
            account: s.accountEmail,
            status: s.status,
            email_count: s.emailCount,
            created_at: s.createdAt,
            processed_at: s.processedAt,
          })),
          pending_action_count: pendingItems.length,
          rule_count: rules.length,
        };
      }

      default:
        return assertUnreachable(name);
    }
  },
};
