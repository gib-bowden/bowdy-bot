import type Anthropic from "@anthropic-ai/sdk";
import { assertUnreachable, type Module } from "../types.js";
import { getDefaultAccount, setPreferredStore } from "../../auth/kroger.js";
import { searchProducts, searchLocations, addToCart } from "./api.js";
import { getTasksClient } from "../google-tasks/client.js";
import {
  lookupPreference,
  savePreference,
  listPreferences,
  deletePreference,
} from "./preferences.js";
import { addCartItem, isInCart, clearCart, getCartSummary } from "./cart.js";

interface ParsedItem {
  grocery_item: string;
  search_term: string;
  quantity: number;
}

interface SearchProductsInput {
  term: string;
  limit?: number;
}

interface SetStoreInput {
  zip_code: string;
  store_index?: number;
}

interface SendToCartInput {
  items?: ParsedItem[];
}

interface ViewCartInput {}

interface ClearCartInput {}

interface LookupPreferenceInput {
  item_name: string;
}

interface SavePreferenceInput {
  item_name: string;
  upc: string;
  product_id: string;
  product_name: string;
  brand?: string;
  size?: string;
}

interface ListPreferencesInput {}

interface DeletePreferenceInput {
  item_name: string;
}

type KrogerInputs = {
  search_kroger_products: SearchProductsInput;
  set_kroger_store: SetStoreInput;
  send_to_kroger_cart: SendToCartInput;
  view_kroger_cart: ViewCartInput;
  clear_kroger_cart: ClearCartInput;
  lookup_product_preference: LookupPreferenceInput;
  save_product_preference: SavePreferenceInput;
  list_product_preferences: ListPreferencesInput;
  delete_product_preference: DeletePreferenceInput;
};

const tools: Anthropic.Tool[] = [
  {
    name: "search_kroger_products",
    description:
      "Search for products at the user's preferred Kroger store. Returns product details including price, brand, and size. A store must be set first (use set_kroger_store).",
    input_schema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description: "Search term (e.g. 'whole milk', 'chicken breast')",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 5, max 20)",
        },
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
          description:
            "Index of the store to select from search results (0-based). Omit to see available stores.",
        },
      },
      required: ["zip_code"],
    },
  },
  {
    name: "send_to_kroger_cart",
    description:
      "Add grocery items to the user's Kroger cart. Can be called two ways:\n" +
      "1. With `items` array: Claude pre-parses quantities from grocery text (e.g. '2 lbs chicken breast' → { grocery_item, search_term: 'chicken breast', quantity: 2 }). Items already in the local cart are skipped as duplicates.\n" +
      "2. Without `items`: reads unchecked items from the Google Tasks grocery list (backward compatible, quantity=1).\n" +
      "Items with saved product preferences are added automatically. Items WITHOUT a saved preference return top 3 search results for user selection.",
    input_schema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array",
          description:
            "Pre-parsed grocery items with quantities. If omitted, reads from Google Tasks grocery list.",
          items: {
            type: "object",
            properties: {
              grocery_item: {
                type: "string",
                description: "Original text (e.g. '2 lbs chicken breast')",
              },
              search_term: {
                type: "string",
                description:
                  "Cleaned term without quantity for search/preference lookup (e.g. 'chicken breast')",
              },
              quantity: {
                type: "number",
                description: "Quantity to add (default 1)",
              },
            },
            required: ["grocery_item", "search_term"],
          },
        },
      },
      required: [],
    },
  },
  {
    name: "view_kroger_cart",
    description:
      "View all items currently tracked in the local Kroger cart. Shows items that have been sent to Kroger in the current shopping trip.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "clear_kroger_cart",
    description:
      "Clear the local Kroger cart (mark all items as cleared). Use when the user is done shopping or starting a new trip.",
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
        item_name: {
          type: "string",
          description: "Generic grocery item name (e.g. 'eggs', 'milk')",
        },
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
        item_name: {
          type: "string",
          description: "Generic grocery item name (e.g. 'eggs', 'milk')",
        },
        upc: { type: "string", description: "Kroger product UPC" },
        product_id: { type: "string", description: "Kroger product ID" },
        product_name: {
          type: "string",
          description: "Full product display name",
        },
        brand: { type: "string", description: "Product brand (optional)" },
        size: { type: "string", description: "Product size (optional)" },
      },
      required: ["item_name", "upc", "product_id", "product_name"],
    },
  },
  {
    name: "list_product_preferences",
    description:
      "List all saved product preferences. Shows which Kroger products are mapped to generic grocery item names.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "delete_product_preference",
    description:
      "Remove a saved product preference for a grocery item. Future cart sends will search Kroger instead of using a saved product.",
    input_schema: {
      type: "object" as const,
      properties: {
        item_name: {
          type: "string",
          description: "Generic grocery item name to remove preference for",
        },
      },
      required: ["item_name"],
    },
  },
];

function getStoreId(): string | null {
  const account = getDefaultAccount();
  return account?.storeId ?? null;
}

async function searchKrogerProducts(
  input: SearchProductsInput,
): Promise<unknown> {
  const { term } = input;
  const limit = Math.min(input.limit ?? 5, 20);
  const storeId = getStoreId();

  if (!storeId) {
    return {
      success: false,
      error:
        "No preferred store set. Use set_kroger_store with a zip code first.",
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

async function setKrogerStore(
  input: SetStoreInput,
): Promise<unknown> {
  const { zip_code: zipCode, store_index: storeIndex } = input;

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
    return {
      success: false,
      error: `Invalid store_index. Must be 0-${locations.length - 1}`,
    };
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

async function sendToKrogerCart(
  input: SendToCartInput,
): Promise<unknown> {
  const storeId = getStoreId();
  if (!storeId) {
    return {
      success: false,
      error:
        "No preferred store set. Use set_kroger_store with a zip code first.",
    };
  }

  let parsedItems: ParsedItem[];

  const rawItems = input.items;
  if (rawItems && rawItems.length > 0) {
    parsedItems = rawItems.map((i) => ({
      grocery_item: i.grocery_item,
      search_term: i.search_term,
      quantity: i.quantity ?? 1,
    }));
  } else {
    // Backward compatible: read from Google Tasks grocery list
    const client = await getTasksClient();
    const listsResponse = await client.tasklists.list({ maxResults: 100 });
    const groceryList = (listsResponse.data.items || []).find(
      (l) => l.title?.toLowerCase() === "grocery",
    );

    if (!groceryList?.id) {
      return {
        success: false,
        error: "No 'grocery' list found in Google Tasks.",
      };
    }

    const tasksResponse = await client.tasks.list({
      tasklist: groceryList.id,
      maxResults: 100,
      showCompleted: false,
      showHidden: false,
    });

    const groceryItems = (tasksResponse.data.items || []).filter(
      (t) => t.title,
    );
    if (groceryItems.length === 0) {
      return {
        success: false,
        error: "Grocery list is empty — nothing to send to Kroger.",
      };
    }

    parsedItems = groceryItems.map((t) => ({
      grocery_item: t.title!,
      search_term: t.title!,
      quantity: 1,
    }));
  }

  const added: Array<{
    item: string;
    product: string;
    upc: string;
    quantity: number;
  }> = [];
  const skippedDuplicates: string[] = [];
  const needsSelection: Array<{
    grocery_item: string;
    candidates: Array<{
      product_id: string;
      upc: string;
      name: string;
      brand: string;
      price: string;
      size: string;
    }>;
  }> = [];
  const notFound: string[] = [];

  for (const item of parsedItems) {
    if (await isInCart(item.grocery_item)) {
      skippedDuplicates.push(item.grocery_item);
      continue;
    }

    const pref = lookupPreference(item.search_term);

    if (pref) {
      added.push({
        item: item.grocery_item,
        product: pref.productName,
        upc: pref.upc,
        quantity: item.quantity,
      });
    } else {
      const results = await searchProducts({
        term: item.search_term,
        locationId: storeId,
        limit: 3,
      });
      if (results.length > 0) {
        needsSelection.push({
          grocery_item: item.grocery_item,
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
        notFound.push(item.grocery_item);
      }
    }
  }

  if (added.length > 0) {
    await addToCart(added.map((a) => ({ upc: a.upc, quantity: a.quantity })));

    // Track in Google Tasks "Kroger Cart" list
    for (const a of added) {
      const pref = lookupPreference(a.item) ?? lookupPreference(a.product);
      await addCartItem({
        groceryItem: a.item,
        quantity: a.quantity,
        upc: a.upc,
        productId: pref?.productId ?? "",
        productName: a.product,
      });
    }
  }

  const parts: string[] = [];
  if (added.length > 0)
    parts.push(
      `Added ${added.length} item(s) to cart using saved preferences.`,
    );
  if (skippedDuplicates.length > 0)
    parts.push(
      `Skipped ${skippedDuplicates.length} duplicate(s) already in cart.`,
    );
  if (needsSelection.length > 0)
    parts.push(
      `${needsSelection.length} item(s) need selection — ask the user which product they want, then save_product_preference and call send_to_kroger_cart again.`,
    );
  if (notFound.length > 0)
    parts.push(`${notFound.length} item(s) could not be found on Kroger.`);

  return {
    success: true,
    added_to_cart: added.map((a) => ({
      grocery_item: a.item,
      kroger_product: a.product,
      quantity: a.quantity,
    })),
    skipped_duplicates: skippedDuplicates,
    needs_selection: needsSelection,
    not_found: notFound,
    summary: parts.join(" "),
  };
}

export const krogerModule: Module<KrogerInputs> = {
  name: "kroger",
  description: "Kroger product search and cart sync",
  tools,
  async executeTool(name, input): Promise<unknown> {
    switch (name) {
      case "search_kroger_products":
        return searchKrogerProducts(input as SearchProductsInput);
      case "set_kroger_store":
        return setKrogerStore(input as SetStoreInput);
      case "send_to_kroger_cart":
        return sendToKrogerCart(input as SendToCartInput);
      case "view_kroger_cart": {
        const summary = await getCartSummary();
        if (summary.count === 0) {
          return {
            success: true,
            message: "Cart is empty.",
            count: 0,
            items: [],
          };
        }
        return {
          success: true,
          count: summary.count,
          items: summary.items.map((i) => ({
            grocery_item: i.groceryItem,
            product_name: i.productName,
            quantity: i.quantity,
          })),
        };
      }
      case "clear_kroger_cart": {
        const cleared = await clearCart();
        return {
          success: true,
          cleared_count: cleared,
          message:
            cleared > 0
              ? `Cleared ${cleared} item(s) from cart.`
              : "Cart was already empty.",
        };
      }
      case "lookup_product_preference": {
        const { item_name: itemName } = input as LookupPreferenceInput;
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
        return {
          success: true,
          preference: null,
          message: `No saved preference for "${itemName}".`,
        };
      }
      case "save_product_preference": {
        const { item_name, upc, product_id, product_name, brand, size } = input as SavePreferenceInput;
        const saved = savePreference({
          genericName: item_name,
          upc,
          productId: product_id,
          productName: product_name,
          brand: brand ?? null,
          size: size ?? null,
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
        const { item_name } = input as DeletePreferenceInput;
        const deleted = deletePreference(item_name);
        return {
          success: deleted,
          message: deleted
            ? `Preference for "${item_name}" removed.`
            : `No preference found for "${item_name}".`,
        };
      }
      default:
        return assertUnreachable(name);
    }
  },
};
