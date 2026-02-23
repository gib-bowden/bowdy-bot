import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { googleAccounts } from "../db/schema.js";
import { logger } from "../logger.js";
import { encrypt, decrypt } from "./crypto.js";

const SCOPES = [
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const AUTH_CLIENT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const authClientCache = new Map<string, { client: OAuth2Client; expiresAt: number }>();

export function createOAuth2Client(): OAuth2Client {
  return new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    config.googleOAuthRedirectUri,
  );
}

export async function getAuthClient(email?: string): Promise<OAuth2Client> {
  const cacheKey = email ?? "__default__";
  const cached = authClientCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.client;

  const db = getDb();

  const account = email
    ? db.select().from(googleAccounts).where(eq(googleAccounts.email, email)).get()
    : db.select().from(googleAccounts).where(eq(googleAccounts.isDefault, true)).get();

  if (!account) {
    throw new Error(
      email
        ? `No Google account found for ${email}. Connect one at http://localhost:${config.googleOAuthPort}`
        : `No default Google account connected. Visit http://localhost:${config.googleOAuthPort} to connect one.`,
    );
  }

  const client = createOAuth2Client();
  client.setCredentials({
    refresh_token: decrypt(account.refreshToken),
    access_token: account.accessToken ? decrypt(account.accessToken) : undefined,
    expiry_date: account.tokenExpiry ? new Date(account.tokenExpiry).getTime() : undefined,
  });

  client.on("tokens", (tokens) => {
    const updates: Record<string, string> = { updatedAt: new Date().toISOString() };
    if (tokens.access_token) updates.accessToken = encrypt(tokens.access_token);
    if (tokens.expiry_date) updates.tokenExpiry = new Date(tokens.expiry_date).toISOString();

    db.update(googleAccounts)
      .set(updates)
      .where(eq(googleAccounts.email, account.email))
      .run();

    logger.debug({ email: account.email }, "Refreshed Google OAuth tokens");
  });

  authClientCache.set(cacheKey, { client, expiresAt: Date.now() + AUTH_CLIENT_TTL_MS });
  return client;
}

export function getConsentUrl(scopes?: string[]): string {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    scope: scopes ?? SCOPES,
    prompt: "consent",
  });
}

export async function handleAuthCallback(code: string): Promise<{ email: string; name: string }> {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const { data: profile } = await oauth2.userinfo.get();

  const email = profile.email!;
  const name = profile.name || email;

  const db = getDb();

  const existing = db.select().from(googleAccounts).where(eq(googleAccounts.email, email)).get();

  if (existing) {
    db.update(googleAccounts)
      .set({
        name,
        refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : existing.refreshToken,
        accessToken: tokens.access_token ? encrypt(tokens.access_token) : null,
        tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
        scopes: tokens.scope ?? existing.scopes,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(googleAccounts.email, email))
      .run();
  } else {
    if (!tokens.refresh_token) {
      throw new Error("No refresh token received from Google. Please try connecting again.");
    }

    const isFirstAccount = !db.select().from(googleAccounts).get();
    db.insert(googleAccounts)
      .values({
        id: ulid(),
        email,
        name,
        refreshToken: encrypt(tokens.refresh_token),
        accessToken: tokens.access_token ? encrypt(tokens.access_token) : null,
        tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
        scopes: tokens.scope ?? SCOPES.join(" "),
        isDefault: isFirstAccount,
      })
      .run();
  }

  logger.info({ email, name }, "Google account connected");
  return { email, name };
}

export function listAccounts() {
  const db = getDb();
  return db.select().from(googleAccounts).all();
}

export function removeAccount(email: string) {
  const db = getDb();
  const account = db.select().from(googleAccounts).where(eq(googleAccounts.email, email)).get();
  if (!account) return false;

  db.delete(googleAccounts).where(eq(googleAccounts.email, email)).run();

  if (account.isDefault) {
    const next = db.select().from(googleAccounts).get();
    if (next) {
      db.update(googleAccounts)
        .set({ isDefault: true })
        .where(eq(googleAccounts.email, next.email))
        .run();
    }
  }

  logger.info({ email }, "Google account removed");
  return true;
}

export function setDefaultAccount(email: string) {
  const db = getDb();
  const account = db.select().from(googleAccounts).where(eq(googleAccounts.email, email)).get();
  if (!account) return false;

  db.update(googleAccounts).set({ isDefault: false }).run();
  db.update(googleAccounts)
    .set({ isDefault: true })
    .where(eq(googleAccounts.email, email))
    .run();

  logger.info({ email }, "Set default Google account");
  return true;
}
