import type Anthropic from "@anthropic-ai/sdk";
import type { Module } from "../types.js";
import { getDefaultAccount, setPreferredStore } from "../../auth/kroger.js";
import { searchProducts, searchLocations, addToCart } from "./api.js";
import { getTasksClient } from "../google-tasks/client.js";

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
      "Read all unchecked items from the Google Tasks grocery list, search Kroger for each item to find UPCs, and add them to the user's Kroger cart (appears in the Kroger app). Use when the user is ready to shop.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
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

  // Search Kroger for each item and collect UPCs
  const added: Array<{ item: string; product: string; upc: string }> = [];
  const notFound: string[] = [];

  for (const task of groceryItems) {
    const title = task.title!;
    const results = await searchProducts({ term: title, locationId: storeId, limit: 1 });
    if (results.length > 0) {
      const product = results[0]!;
      added.push({ item: title, product: product.name, upc: product.upc });
    } else {
      notFound.push(title);
    }
  }

  if (added.length > 0) {
    await addToCart(added.map((a) => ({ upc: a.upc, quantity: 1 })));
  }

  return {
    success: true,
    added_to_cart: added.map((a) => ({ grocery_item: a.item, kroger_product: a.product })),
    not_found: notFound,
    summary: `Added ${added.length} item(s) to Kroger cart.${notFound.length > 0 ? ` ${notFound.length} item(s) could not be matched.` : ""}`,
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
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  },
};
