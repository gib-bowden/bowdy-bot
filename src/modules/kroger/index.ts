import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { Module } from "../types.js";
import { getDb } from "../../db/client.js";
import { krogerGroceryItems, krogerAccounts } from "../../db/schema.js";
import { getDefaultAccount, setPreferredStore } from "../../auth/kroger.js";
import { searchProducts, searchLocations } from "./api.js";

const tools: Anthropic.Tool[] = [
  {
    name: "search_kroger_products",
    description:
      "Search for products at the user's preferred Kroger store. Returns product details including price, brand, and size. A store must be set first (use set_kroger_store).",
    input_schema: {
      type: "object" as const,
      properties: {
        term: { type: "string", description: "Search term (e.g. 'whole milk', 'chicken breast')" },
        limit: { type: "number", description: "Max results to return (default 5, max 20)" },
      },
      required: ["term"],
    },
  },
  {
    name: "add_to_grocery_list",
    description:
      "Add a product to the grocery list. Can add by Kroger product ID (from search results) or by name (will auto-search and pick the best match). Always search first when the user gives a specific product preference.",
    input_schema: {
      type: "object" as const,
      properties: {
        product_id: { type: "string", description: "Kroger product ID (from search results)" },
        name: { type: "string", description: "Product name to search for (used if product_id not provided)" },
        quantity: { type: "number", description: "Quantity to add (default 1)" },
      },
      required: [],
    },
  },
  {
    name: "list_grocery_items",
    description:
      "View the current grocery list with product details, prices, and checked status. Shows estimated total.",
    input_schema: {
      type: "object" as const,
      properties: {
        include_checked: {
          type: "boolean",
          description: "Include checked-off items (default false)",
        },
      },
      required: [],
    },
  },
  {
    name: "remove_grocery_item",
    description:
      "Remove an item from the grocery list by name (partial match supported).",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Item name or partial match to remove" },
      },
      required: ["name"],
    },
  },
  {
    name: "check_grocery_item",
    description:
      "Toggle an item's checked status on the grocery list (cross off / uncross). Partial name match supported.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Item name or partial match to toggle" },
      },
      required: ["name"],
    },
  },
  {
    name: "clear_grocery_list",
    description:
      "Clear all items from the grocery list. This is destructive — first call without confirm to preview, then call with confirm=true.",
    input_schema: {
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean",
          description: "Set to true to confirm clearing. Omit or false to preview.",
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: "set_kroger_store",
    description:
      "Search for and set the user's preferred Kroger store by zip code. This store is used for product searches and pricing.",
    input_schema: {
      type: "object" as const,
      properties: {
        zip_code: { type: "string", description: "ZIP code to search near" },
        store_index: {
          type: "number",
          description: "Index of the store to select from search results (0-based). Omit to see available stores.",
        },
      },
      required: ["zip_code"],
    },
  },
];

function getStoreId(): string | null {
  const account = getDefaultAccount();
  return account?.storeId ?? null;
}

async function searchKrogerProducts(input: Record<string, unknown>): Promise<unknown> {
  const term = input["term"] as string;
  const limit = Math.min((input["limit"] as number) ?? 5, 20);
  const storeId = getStoreId();

  if (!storeId) {
    return {
      success: false,
      error: "No preferred store set. Use set_kroger_store with a zip code first.",
    };
  }

  const products = await searchProducts({ term, locationId: storeId, limit });
  return {
    success: true,
    store_id: storeId,
    count: products.length,
    products: products.map((p) => ({
      product_id: p.productId,
      name: p.name,
      brand: p.brand,
      price: p.price ? `$${p.price.toFixed(2)}` : "Price unavailable",
      size: p.size,
    })),
  };
}

async function addToGroceryList(input: Record<string, unknown>): Promise<unknown> {
  const productId = input["product_id"] as string | undefined;
  const name = input["name"] as string | undefined;
  const quantity = (input["quantity"] as number) ?? 1;
  const storeId = getStoreId();

  if (!productId && !name) {
    return { success: false, error: "Provide either product_id or name" };
  }

  let product;

  if (productId) {
    // Look up by product ID — search with the ID as term
    const results = await searchProducts({
      term: productId,
      locationId: storeId ?? undefined,
      limit: 1,
    });
    product = results.find((p) => p.productId === productId) ?? results[0];
  }

  if (!product && name) {
    const results = await searchProducts({
      term: name,
      locationId: storeId ?? undefined,
      limit: 1,
    });
    product = results[0];
  }

  if (!product) {
    // Add as a plain item without Kroger product reference
    const db = getDb();
    db.insert(krogerGroceryItems)
      .values({
        id: ulid(),
        name: name ?? "Unknown item",
        quantity,
        storeId,
      })
      .run();

    return {
      success: true,
      name: name ?? "Unknown item",
      quantity,
      note: "Added without Kroger product match — no pricing available",
    };
  }

  const db = getDb();
  db.insert(krogerGroceryItems)
    .values({
      id: ulid(),
      productId: product.productId,
      upc: product.upc,
      name: product.name,
      brand: product.brand,
      price: product.price?.toFixed(2) ?? null,
      size: product.size,
      quantity,
      imageUrl: product.imageUrl,
      storeId,
    })
    .run();

  return {
    success: true,
    name: product.name,
    brand: product.brand,
    price: product.price ? `$${product.price.toFixed(2)}` : "Price unavailable",
    size: product.size,
    quantity,
  };
}

async function listGroceryItems(input: Record<string, unknown>): Promise<unknown> {
  const includeChecked = (input["include_checked"] as boolean) ?? false;
  const db = getDb();

  let items;
  if (includeChecked) {
    items = db.select().from(krogerGroceryItems).all();
  } else {
    items = db.select().from(krogerGroceryItems)
      .where(eq(krogerGroceryItems.checked, false))
      .all();
  }

  let estimatedTotal = 0;
  const formatted = items.map((item) => {
    const price = item.price ? parseFloat(item.price) : null;
    const lineTotal = price ? price * item.quantity : null;
    if (lineTotal) estimatedTotal += lineTotal;

    return {
      name: item.name,
      brand: item.brand,
      price: price ? `$${price.toFixed(2)}` : null,
      size: item.size,
      quantity: item.quantity,
      line_total: lineTotal ? `$${lineTotal.toFixed(2)}` : null,
      checked: item.checked,
    };
  });

  return {
    count: formatted.length,
    estimated_total: `$${estimatedTotal.toFixed(2)}`,
    items: formatted,
  };
}

async function removeGroceryItem(input: Record<string, unknown>): Promise<unknown> {
  const name = (input["name"] as string).toLowerCase();
  const db = getDb();

  const allItems = db.select().from(krogerGroceryItems).all();
  const matches = allItems.filter((item) =>
    item.name.toLowerCase().includes(name),
  );

  if (matches.length === 0) {
    return { success: false, error: `No item matching "${name}" found on the grocery list` };
  }

  if (matches.length > 1) {
    const exact = matches.filter((m) => m.name.toLowerCase() === name);
    if (exact.length === 1) {
      db.delete(krogerGroceryItems).where(eq(krogerGroceryItems.id, exact[0]!.id)).run();
      return { success: true, removed: exact[0]!.name };
    }
    return {
      success: false,
      error: `Multiple items match "${name}": ${matches.map((m) => m.name).join(", ")}. Be more specific.`,
    };
  }

  db.delete(krogerGroceryItems).where(eq(krogerGroceryItems.id, matches[0]!.id)).run();
  return { success: true, removed: matches[0]!.name };
}

async function checkGroceryItem(input: Record<string, unknown>): Promise<unknown> {
  const name = (input["name"] as string).toLowerCase();
  const db = getDb();

  const allItems = db.select().from(krogerGroceryItems).all();
  const matches = allItems.filter((item) =>
    item.name.toLowerCase().includes(name),
  );

  if (matches.length === 0) {
    return { success: false, error: `No item matching "${name}" found on the grocery list` };
  }

  if (matches.length > 1) {
    const exact = matches.filter((m) => m.name.toLowerCase() === name);
    if (exact.length === 1) {
      const newChecked = !exact[0]!.checked;
      db.update(krogerGroceryItems)
        .set({ checked: newChecked })
        .where(eq(krogerGroceryItems.id, exact[0]!.id))
        .run();
      return { success: true, name: exact[0]!.name, checked: newChecked };
    }
    return {
      success: false,
      error: `Multiple items match "${name}": ${matches.map((m) => m.name).join(", ")}. Be more specific.`,
    };
  }

  const item = matches[0]!;
  const newChecked = !item.checked;
  db.update(krogerGroceryItems)
    .set({ checked: newChecked })
    .where(eq(krogerGroceryItems.id, item.id))
    .run();
  return { success: true, name: item.name, checked: newChecked };
}

async function clearGroceryList(input: Record<string, unknown>): Promise<unknown> {
  const confirm = (input["confirm"] as boolean) ?? false;
  const db = getDb();

  const items = db.select().from(krogerGroceryItems).all();

  if (!confirm) {
    return {
      success: false,
      needs_confirmation: true,
      item_count: items.length,
      message: `Grocery list has ${items.length} item(s). Call again with confirm=true to clear all.`,
    };
  }

  db.delete(krogerGroceryItems).run();
  return { success: true, cleared: items.length };
}

async function setKrogerStore(input: Record<string, unknown>): Promise<unknown> {
  const zipCode = input["zip_code"] as string;
  const storeIndex = input["store_index"] as number | undefined;

  const locations = await searchLocations({ zipCode, limit: 5 });

  if (locations.length === 0) {
    return { success: false, error: `No Kroger stores found near ${zipCode}` };
  }

  if (storeIndex === undefined) {
    return {
      success: true,
      action: "select_store",
      stores: locations.map((l, i) => ({
        index: i,
        name: l.name,
        address: `${l.address}, ${l.city}, ${l.state} ${l.zipCode}`,
        phone: l.phone,
      })),
      message: "Call again with store_index to select a store.",
    };
  }

  if (storeIndex < 0 || storeIndex >= locations.length) {
    return { success: false, error: `Invalid store_index. Must be 0-${locations.length - 1}` };
  }

  const store = locations[storeIndex]!;
  const address = `${store.address}, ${store.city}, ${store.state} ${store.zipCode}`;
  setPreferredStore(store.locationId, store.name, address);

  return {
    success: true,
    store_id: store.locationId,
    name: store.name,
    address,
  };
}

export const krogerModule: Module = {
  name: "kroger",
  description: "Kroger grocery list and product search",
  tools,
  async executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "search_kroger_products":
        return searchKrogerProducts(input);
      case "add_to_grocery_list":
        return addToGroceryList(input);
      case "list_grocery_items":
        return listGroceryItems(input);
      case "remove_grocery_item":
        return removeGroceryItem(input);
      case "check_grocery_item":
        return checkGroceryItem(input);
      case "clear_grocery_list":
        return clearGroceryList(input);
      case "set_kroger_store":
        return setKrogerStore(input);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  },
};
