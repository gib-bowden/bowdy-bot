import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { getDb, schema } from "../../db/client.js";

export interface ProductPreference {
  id: string;
  genericName: string;
  upc: string;
  productId: string;
  productName: string;
  brand: string | null;
  size: string | null;
  createdAt: string;
  updatedAt: string;
}

export function normalize(name: string): string {
  return name.toLowerCase().trim();
}

export function lookupPreference(genericName: string): ProductPreference | null {
  const db = getDb();
  const row = db
    .select()
    .from(schema.productPreferences)
    .where(eq(schema.productPreferences.genericName, normalize(genericName)))
    .get();
  return row ?? null;
}

export function savePreference(pref: {
  genericName: string;
  upc: string;
  productId: string;
  productName: string;
  brand?: string | null;
  size?: string | null;
}): ProductPreference {
  const db = getDb();
  const normalized = normalize(pref.genericName);
  const now = new Date().toISOString();

  const existing = db
    .select()
    .from(schema.productPreferences)
    .where(eq(schema.productPreferences.genericName, normalized))
    .get();

  if (existing) {
    db.update(schema.productPreferences)
      .set({
        upc: pref.upc,
        productId: pref.productId,
        productName: pref.productName,
        brand: pref.brand ?? null,
        size: pref.size ?? null,
        updatedAt: now,
      })
      .where(eq(schema.productPreferences.genericName, normalized))
      .run();

    return { ...existing, ...pref, genericName: normalized, updatedAt: now };
  }

  const row = {
    id: ulid(),
    genericName: normalized,
    upc: pref.upc,
    productId: pref.productId,
    productName: pref.productName,
    brand: pref.brand ?? null,
    size: pref.size ?? null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(schema.productPreferences).values(row).run();
  return row;
}

export function listPreferences(): ProductPreference[] {
  const db = getDb();
  return db.select().from(schema.productPreferences).all();
}

export function deletePreference(genericName: string): boolean {
  const db = getDb();
  const result = db
    .delete(schema.productPreferences)
    .where(eq(schema.productPreferences.genericName, normalize(genericName)))
    .run();
  return result.changes > 0;
}
