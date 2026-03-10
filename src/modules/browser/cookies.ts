import type { Page, BrowserContext, Cookie } from "playwright-core";
import { encrypt, decrypt } from "../../auth/crypto.js";
import { getDb, schema } from "../../db/client.js";
import { eq } from "drizzle-orm";
import { logger } from "../../logger.js";

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function saveCookies(page: Page): Promise<void> {
  try {
    const cookies = await page.context().cookies();
    if (cookies.length === 0) {
      return;
    }

    // Group by domain
    const byDomain = new Map<string, Cookie[]>();
    for (const cookie of cookies) {
      const domain = cookie.domain.replace(/^\./, "");
      const existing = byDomain.get(domain) ?? [];
      existing.push(cookie);
      byDomain.set(domain, existing);
    }

    const db = getDb();
    const now = new Date().toISOString();

    for (const [domain, domainCookies] of byDomain) {
      const encrypted = encrypt(JSON.stringify(domainCookies));
      db.insert(schema.browserCookies)
        .values({
          domain,
          cookiesJson: encrypted,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.browserCookies.domain,
          set: {
            cookiesJson: encrypted,
            updatedAt: now,
          },
        })
        .run();
    }

    logger.info({ domains: byDomain.size }, "Saved browser cookies");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, "Failed to save cookies");
  }
}

export async function loadCookies(context: BrowserContext): Promise<void> {
  try {
    const db = getDb();
    const rows = db.select().from(schema.browserCookies).all();

    const now = Date.now();
    const allCookies: Cookie[] = [];

    for (const row of rows) {
      // Check TTL
      const updatedAt = new Date(row.updatedAt).getTime();
      if (now - updatedAt > TTL_MS) {
        // Expired — clean up
        db.delete(schema.browserCookies).where(eq(schema.browserCookies.domain, row.domain)).run();
        continue;
      }

      try {
        const decrypted = decrypt(row.cookiesJson);
        const cookies = JSON.parse(decrypted) as Cookie[];
        allCookies.push(...cookies);
      } catch {
        logger.warn({ domain: row.domain }, "Failed to decrypt cookies, removing");
        db.delete(schema.browserCookies).where(eq(schema.browserCookies.domain, row.domain)).run();
      }
    }

    if (allCookies.length > 0) {
      await context.addCookies(allCookies);
      logger.info({ count: allCookies.length }, "Loaded browser cookies");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, "Failed to load cookies");
  }
}

export async function clearCookies(domain?: string): Promise<void> {
  try {
    const db = getDb();
    if (domain) {
      db.delete(schema.browserCookies).where(eq(schema.browserCookies.domain, domain)).run();
    } else {
      db.delete(schema.browserCookies).run();
    }
    logger.info({ domain: domain ?? "all" }, "Cleared browser cookies");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, "Failed to clear cookies");
  }
}
