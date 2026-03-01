import { eq, and, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import { getDb, schema } from "../../db/client.js";

export interface EmailRule {
  id: string;
  accountEmail: string | null;
  matchType: string; // sender | domain | subject_contains
  matchValue: string;
  action: string; // archive | skip | important | label
  label: string | null;
  appliedCount: number;
  createdAt: string;
  updatedAt: string;
}

function normalize(value: string): string {
  return value.toLowerCase().trim();
}

/**
 * Look up rules matching a sender email or domain for a specific account.
 * Returns matching rules (account-specific + global rules where accountEmail is null).
 */
export function lookupRules(
  accountEmail: string,
  sender: string,
): EmailRule[] {
  const db = getDb();
  const normalizedSender = normalize(sender);

  // Extract domain from sender (handles "Name <email@domain.com>" format)
  const emailMatch = normalizedSender.match(/<([^>]+)>/) ?? [null, normalizedSender];
  const emailAddr = emailMatch[1] ?? normalizedSender;
  const domain = emailAddr.split("@")[1] ?? "";

  const allRules = db.select().from(schema.emailRules).all();

  return allRules.filter((rule) => {
    // Check account scope (null = all accounts)
    if (rule.accountEmail && rule.accountEmail !== accountEmail) return false;

    const matchVal = normalize(rule.matchValue);
    switch (rule.matchType) {
      case "sender":
        return normalizedSender.includes(matchVal) || emailAddr === matchVal;
      case "domain":
        return domain === matchVal || domain.endsWith(`.${matchVal}`);
      case "subject_contains":
        return false; // Subject matching handled separately in applyRules
      default:
        return false;
    }
  });
}

export interface ClassifiableEmail {
  sender: string;
  subject: string;
}

export interface RuleMatch {
  rule: EmailRule;
  emailIndex: number;
}

/**
 * Apply rules to a batch of emails. Returns indices of emails that matched a rule
 * and their corresponding actions.
 */
export function applyRules(
  emails: ClassifiableEmail[],
  accountEmail: string,
): RuleMatch[] {
  const db = getDb();
  const allRules = db.select().from(schema.emailRules).all();

  const accountRules = allRules.filter(
    (r) => !r.accountEmail || r.accountEmail === accountEmail,
  );

  const matches: RuleMatch[] = [];

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i]!;
    const normalizedSender = normalize(email.sender);
    const emailMatch = normalizedSender.match(/<([^>]+)>/) ?? [null, normalizedSender];
    const emailAddr = emailMatch[1] ?? normalizedSender;
    const domain = emailAddr.split("@")[1] ?? "";
    const normalizedSubject = normalize(email.subject);

    for (const rule of accountRules) {
      const matchVal = normalize(rule.matchValue);
      let matched = false;

      switch (rule.matchType) {
        case "sender":
          matched = normalizedSender.includes(matchVal) || emailAddr === matchVal;
          break;
        case "domain":
          matched = domain === matchVal || domain.endsWith(`.${matchVal}`);
          break;
        case "subject_contains":
          matched = normalizedSubject.includes(matchVal);
          break;
      }

      if (matched) {
        matches.push({ rule, emailIndex: i });
        break; // First matching rule wins
      }
    }
  }

  return matches;
}

/**
 * Save or update a rule (upsert by unique constraint).
 */
export function saveRule(rule: {
  accountEmail?: string | null;
  matchType: string;
  matchValue: string;
  action: string;
  label?: string | null;
}): EmailRule {
  const db = getDb();
  const now = new Date().toISOString();
  const normalizedValue = normalize(rule.matchValue);

  // Check for existing rule with same match
  const conditions = [
    eq(schema.emailRules.matchType, rule.matchType),
    eq(schema.emailRules.matchValue, normalizedValue),
  ];

  if (rule.accountEmail) {
    conditions.push(eq(schema.emailRules.accountEmail, rule.accountEmail));
  } else {
    conditions.push(isNull(schema.emailRules.accountEmail));
  }

  const existing = db
    .select()
    .from(schema.emailRules)
    .where(and(...conditions))
    .get();

  if (existing) {
    db.update(schema.emailRules)
      .set({
        action: rule.action,
        label: rule.label ?? null,
        updatedAt: now,
      })
      .where(eq(schema.emailRules.id, existing.id))
      .run();

    return { ...existing, action: rule.action, label: rule.label ?? null, updatedAt: now };
  }

  const row: EmailRule = {
    id: ulid(),
    accountEmail: rule.accountEmail ?? null,
    matchType: rule.matchType,
    matchValue: normalizedValue,
    action: rule.action,
    label: rule.label ?? null,
    appliedCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(schema.emailRules).values(row).run();
  return row;
}

/**
 * List all rules, optionally filtered by account.
 */
export function listRules(accountEmail?: string): EmailRule[] {
  const db = getDb();
  if (accountEmail) {
    return db
      .select()
      .from(schema.emailRules)
      .where(eq(schema.emailRules.accountEmail, accountEmail))
      .all();
  }
  return db.select().from(schema.emailRules).all();
}

/**
 * Delete a rule by ID.
 */
export function deleteRule(ruleId: string): boolean {
  const db = getDb();
  const result = db
    .delete(schema.emailRules)
    .where(eq(schema.emailRules.id, ruleId))
    .run();
  return result.changes > 0;
}

/**
 * Increment the applied count for a rule.
 */
export function incrementAppliedCount(ruleId: string): void {
  const db = getDb();
  const rule = db
    .select()
    .from(schema.emailRules)
    .where(eq(schema.emailRules.id, ruleId))
    .get();

  if (rule) {
    db.update(schema.emailRules)
      .set({
        appliedCount: rule.appliedCount + 1,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.emailRules.id, ruleId))
      .run();
  }
}
