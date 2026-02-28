import type Anthropic from "@anthropic-ai/sdk";
import type { Module } from "../types.js";
import { getDefaultAccount, setPreferredStore } from "../../auth/kroger.js";
import { searchProducts, searchLocations, addToCart } from "./api.js";
import { getTasksClient } from "../google-tasks/client.js";
import {
  lookupPreference,
  savePreference,
  listPreferences,
  deletePreference,
} from "./preferences.js";

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
  {
    name: "send_to_kroger_cart",
    description:
      "Read all unchecked items from the Google Tasks grocery list and add them to the user's Kroger cart. Items with saved product preferences are added automatically. Items WITHOUT a saved preference are NOT added — instead, the top 3 Kroger search results are returned so the user can pick the right product. After the user picks, use save_product_preference to remember their choice, then call send_to_kroger_cart again to add the remaining items.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "lookup_product_preference",
    description:
      "Check if a saved product preference exists for a grocery item (e.g. 'eggs'). Returns the preferred Kroger product or null if none saved.",
    input_schema: {
      type: "object" as const,
      properties: {
        item_name: { type: "string", description: "Generic grocery item name (e.g. 'eggs', 'milk')" },
      },
      required: ["item_name"],
    },
  },
  {
    name: "save_product_preference",
    description:
      "Save or update a product preference so future cart sends use this specific Kroger product for the given grocery item name. Use after the user picks a specific product from search results.",
    input_schema: {
      type: "object" as const,
      properties: {
        item_name: { type: "string", description: "Generic grocery item name (e.g. 'eggs', 'milk')" },
        upc: { type: "string", description: "Kroger product UPC" },
        product_id: { type: "string", description: "Kroger product ID" },
        product_name: { type: "string", description: "Full product display name" },
        brand: { type: "string", description: "Product brand (optional)" },
        size: { type: "string", description: "Product size (optional)" },
      },
      required: ["item_name", "upc", "product_id", "product_name"],
    },
  },
  {
    name: "list_product_preferences",
    description: "List all saved product preferences. Shows which Kroger products are mapped to generic grocery item names.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "delete_product_preference",
    description: "Remove a saved product preference for a grocery item. Future cart sends will search Kroger instead of using a saved product.",
    input_schema: {
      type: "object" as const,
      properties: {
        item_name: { type: "string", description: "Generic grocery item name to remove preference for" },
      },
      required: ["item_name"],
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
      upc: p.upc,
      name: p.name,
      brand: p.brand,
      price: p.price ? `$${p.price.toFixed(2)}` : "Price unavailable",
      size: p.size,
    })),
  };
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

async function sendToKrogerCart(): Promise<unknown> {
  const storeId = getStoreId();
  if (!storeId) {
    return {
      success: false,
      error: "No preferred store set. Use set_kroger_store with a zip code first.",
    };
  }

  // Read unchecked items from the Google Tasks "grocery" list
  const client = await getTasksClient();
  const listsResponse = await client.tasklists.list({ maxResults: 100 });
  const groceryList = (listsResponse.data.items || []).find(
    (l) => l.title?.toLowerCase() === "grocery",
  );

  if (!groceryList?.id) {
    return { success: false, error: "No 'grocery' list found in Google Tasks." };
  }

  const tasksResponse = await client.tasks.list({
    tasklist: groceryList.id,
    maxResults: 100,
    showCompleted: false,
    showHidden: false,
  });

  const groceryItems = (tasksResponse.data.items || []).filter((t) => t.title);
  if (groceryItems.length === 0) {
    return { success: false, error: "Grocery list is empty — nothing to send to Kroger." };
  }

  // Items with saved preferences get added to cart automatically.
  // Items without preferences return search candidates for the user to pick from.
  const added: Array<{ item: string; product: string; upc: string }> = [];
  const needsSelection: Array<{
    grocery_item: string;
    candidates: Array<{ product_id: string; upc: string; name: string; brand: string; price: string; size: string }>;
  }> = [];
  const notFound: string[] = [];

  for (const task of groceryItems) {
    const title = task.title!;
    const pref = lookupPreference(title);

    if (pref) {
      added.push({ item: title, product: pref.productName, upc: pref.upc });
    } else {
      const results = await searchProducts({ term: title, locationId: storeId, limit: 3 });
      if (results.length > 0) {
        needsSelection.push({
          grocery_item: title,
          candidates: results.map((p) => ({
            product_id: p.productId,
            upc: p.upc,
            name: p.name,
            brand: p.brand,
            price: p.price ? `$${p.price.toFixed(2)}` : "Price unavailable",
            size: p.size,
          })),
        });
      } else {
        notFound.push(title);
      }
    }
  }

  if (added.length > 0) {
    await addToCart(added.map((a) => ({ upc: a.upc, quantity: 1 })));
  }

  const parts: string[] = [];
  if (added.length > 0) parts.push(`Added ${added.length} item(s) to cart using saved preferences.`);
  if (needsSelection.length > 0) parts.push(`${needsSelection.length} item(s) need selection — ask the user which product they want, then save_product_preference and call send_to_kroger_cart again.`);
  if (notFound.length > 0) parts.push(`${notFound.length} item(s) could not be found on Kroger.`);

  return {
    success: true,
    added_to_cart: added.map((a) => ({ grocery_item: a.item, kroger_product: a.product })),
    needs_selection: needsSelection,
    not_found: notFound,
    summary: parts.join(" "),
  };
}

export const krogerModule: Module = {
  name: "kroger",
  description: "Kroger product search and cart sync",
  tools,
  async executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "search_kroger_products":
        return searchKrogerProducts(input);
      case "set_kroger_store":
        return setKrogerStore(input);
      case "send_to_kroger_cart":
        return sendToKrogerCart();
      case "lookup_product_preference": {
        const itemName = input["item_name"] as string;
        const pref = lookupPreference(itemName);
        if (pref) {
          return {
            success: true,
            preference: {
              item_name: pref.genericName,
              product_name: pref.productName,
              brand: pref.brand,
              size: pref.size,
              upc: pref.upc,
              product_id: pref.productId,
            },
          };
        }
        return { success: true, preference: null, message: `No saved preference for "${itemName}".` };
      }
      case "save_product_preference": {
        const saved = savePreference({
          genericName: input["item_name"] as string,
          upc: input["upc"] as string,
          productId: input["product_id"] as string,
          productName: input["product_name"] as string,
          brand: (input["brand"] as string) ?? null,
          size: (input["size"] as string) ?? null,
        });
        return {
          success: true,
          preference: {
            item_name: saved.genericName,
            product_name: saved.productName,
            brand: saved.brand,
            size: saved.size,
            upc: saved.upc,
            product_id: saved.productId,
          },
        };
      }
      case "list_product_preferences": {
        const prefs = listPreferences();
        return {
          success: true,
          count: prefs.length,
          preferences: prefs.map((p) => ({
            item_name: p.genericName,
            product_name: p.productName,
            brand: p.brand,
            size: p.size,
            upc: p.upc,
            product_id: p.productId,
          })),
        };
      }
      case "delete_product_preference": {
        const deleted = deletePreference(input["item_name"] as string);
        return {
          success: deleted,
          message: deleted
            ? `Preference for "${input["item_name"]}" removed.`
            : `No preference found for "${input["item_name"]}".`,
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  },
};
