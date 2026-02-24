import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { krogerAccounts } from "../db/schema.js";
import { logger } from "../logger.js";
import { encrypt, decrypt } from "./crypto.js";

const KROGER_API_BASE = "https://api.kroger.com/v1";
const KROGER_AUTH_BASE = "https://api.kroger.com/v1/connect/oauth2";
const SCOPES = "product.compact cart.basic:write profile.compact";

// Client credentials token cache (for product search)
let clientToken: { token: string; expiresAt: number } | null = null;

export async function getClientCredentialsToken(): Promise<string> {
  if (clientToken && Date.now() < clientToken.expiresAt) {
    return clientToken.token;
  }

  const credentials = Buffer.from(
    `${config.krogerClientId}:${config.krogerClientSecret}`,
  ).toString("base64");

  const res = await fetch(`${KROGER_AUTH_BASE}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: "grant_type=client_credentials&scope=product.compact",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kroger client credentials failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  clientToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000, // refresh 60s early
  };

  logger.debug("Kroger client credentials token acquired");
  return clientToken.token;
}

export function getKrogerConsentUrl(): string {
  const params = new URLSearchParams({
    scope: SCOPES,
    response_type: "code",
    client_id: config.krogerClientId,
    redirect_uri: config.krogerOAuthRedirectUri,
  });
  return `${KROGER_AUTH_BASE}/authorize?${params.toString()}`;
}

export async function handleKrogerCallback(code: string): Promise<{ userId: string }> {
  const credentials = Buffer.from(
    `${config.krogerClientId}:${config.krogerClientSecret}`,
  ).toString("base64");

  // Exchange code for tokens
  const tokenRes = await fetch(`${KROGER_AUTH_BASE}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.krogerOAuthRedirectUri,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Kroger token exchange failed: ${tokenRes.status} ${text}`);
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };

  // Fetch user profile
  const profileRes = await fetch(`${KROGER_API_BASE}/identity/profile`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!profileRes.ok) {
    const text = await profileRes.text();
    throw new Error(`Kroger profile fetch failed: ${profileRes.status} ${text}`);
  }

  const profile = (await profileRes.json()) as { data: { id: string } };
  const userId = profile.data.id;

  const db = getDb();
  const existing = db.select().from(krogerAccounts).where(eq(krogerAccounts.krogerUserId, userId)).get();

  const tokenExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  if (existing) {
    db.update(krogerAccounts)
      .set({
        accessToken: encrypt(tokens.access_token),
        refreshToken: encrypt(tokens.refresh_token),
        tokenExpiry,
        scopes: tokens.scope ?? SCOPES,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(krogerAccounts.krogerUserId, userId))
      .run();
  } else {
    const isFirstAccount = !db.select().from(krogerAccounts).get();
    db.insert(krogerAccounts)
      .values({
        id: ulid(),
        krogerUserId: userId,
        accessToken: encrypt(tokens.access_token),
        refreshToken: encrypt(tokens.refresh_token),
        tokenExpiry,
        scopes: tokens.scope ?? SCOPES,
        isDefault: isFirstAccount,
      })
      .run();
  }

  logger.info({ userId }, "Kroger account connected");
  return { userId };
}

export async function getKrogerUserToken(): Promise<string> {
  const db = getDb();
  const account = db.select().from(krogerAccounts).where(eq(krogerAccounts.isDefault, true)).get()
    ?? db.select().from(krogerAccounts).get();

  if (!account) {
    throw new Error(
      `No Kroger account connected. Visit http://localhost:${config.googleOAuthPort}/kroger/start to connect one.`,
    );
  }

  // Check if token is still valid (with 60s buffer)
  if (account.tokenExpiry && new Date(account.tokenExpiry).getTime() > Date.now() + 60_000) {
    return decrypt(account.accessToken);
  }

  // Refresh token — Kroger refresh tokens are single-use!
  const credentials = Buffer.from(
    `${config.krogerClientId}:${config.krogerClientSecret}`,
  ).toString("base64");

  const res = await fetch(`${KROGER_AUTH_BASE}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: decrypt(account.refreshToken),
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Kroger token refresh failed: ${res.status} ${text}. You may need to re-authenticate at http://localhost:${config.googleOAuthPort}/kroger/start`,
    );
  }

  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  db.update(krogerAccounts)
    .set({
      accessToken: encrypt(tokens.access_token),
      refreshToken: encrypt(tokens.refresh_token),
      tokenExpiry: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(krogerAccounts.id, account.id))
    .run();

  logger.debug({ userId: account.krogerUserId }, "Refreshed Kroger user token");
  return tokens.access_token;
}

export async function krogerApiFetch(
  path: string,
  opts: { method?: string; body?: unknown; auth?: "client" | "user" } = {},
): Promise<unknown> {
  const { method = "GET", body, auth = "client" } = opts;

  const token = auth === "user"
    ? await getKrogerUserToken()
    : await getClientCredentialsToken();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${KROGER_API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kroger API ${method} ${path} failed: ${res.status} ${text}`);
  }

  return res.json();
}

export function getDefaultAccount() {
  const db = getDb();
  return db.select().from(krogerAccounts).where(eq(krogerAccounts.isDefault, true)).get()
    ?? db.select().from(krogerAccounts).get();
}

export function setPreferredStore(storeId: string, storeName: string, storeAddress: string) {
  const db = getDb();
  const account = getDefaultAccount();
  if (!account) {
    throw new Error("No Kroger account connected");
  }

  db.update(krogerAccounts)
    .set({ storeId, storeName, storeAddress, updatedAt: new Date().toISOString() })
    .where(eq(krogerAccounts.id, account.id))
    .run();

  logger.info({ storeId, storeName }, "Set preferred Kroger store");
}

export function listKrogerAccounts() {
  const db = getDb();
  return db.select().from(krogerAccounts).all();
}
