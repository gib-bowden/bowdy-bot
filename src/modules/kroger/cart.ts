import { getTasksClient } from "../google-tasks/client.js";

const CART_LIST_TITLE = "Kroger Cart";

let cachedListId: string | null = null;

interface CartItemNotes {
  item: string;
  upc: string;
  product_id: string;
}

export function formatTitle(productName: string, quantity: number): string {
  return quantity > 1 ? `${productName} (x${quantity})` : productName;
}

export function formatNotes(data: CartItemNotes): string {
  return JSON.stringify(data);
}

export function parseNotes(notes: string): CartItemNotes | null {
  try {
    const parsed = JSON.parse(notes);
    if (parsed && typeof parsed.item === "string" && typeof parsed.upc === "string" && typeof parsed.product_id === "string") {
      return parsed as CartItemNotes;
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveCartListId(): Promise<string> {
  if (cachedListId) return cachedListId;

  const client = await getTasksClient();
  const listsResponse = await client.tasklists.list({ maxResults: 100 });
  const existing = (listsResponse.data.items || []).find(
    (l) => l.title === CART_LIST_TITLE,
  );

  if (existing?.id) {
    cachedListId = existing.id;
    return cachedListId;
  }

  const created = await client.tasklists.insert({
    requestBody: { title: CART_LIST_TITLE },
  });

  cachedListId = created.data.id!;
  return cachedListId;
}

export async function addCartItem(params: {
  groceryItem: string;
  quantity: number;
  upc: string;
  productId: string;
  productName: string;
}): Promise<void> {
  const listId = await resolveCartListId();
  const client = await getTasksClient();

  await client.tasks.insert({
    tasklist: listId,
    requestBody: {
      title: formatTitle(params.productName, params.quantity),
      notes: formatNotes({
        item: params.groceryItem.toLowerCase().trim(),
        upc: params.upc,
        product_id: params.productId,
      }),
    },
  });
}

export async function isInCart(groceryItem: string): Promise<boolean> {
  const listId = await resolveCartListId();
  const client = await getTasksClient();
  const normalized = groceryItem.toLowerCase().trim();

  const response = await client.tasks.list({
    tasklist: listId,
    maxResults: 100,
    showCompleted: false,
    showHidden: false,
  });

  const tasks = response.data.items || [];
  return tasks.some((t) => {
    if (!t.notes) return false;
    const parsed = parseNotes(t.notes);
    return parsed?.item === normalized;
  });
}

export async function getCartSummary(): Promise<{
  count: number;
  items: Array<{ groceryItem: string; productName: string; quantity: number }>;
}> {
  const listId = await resolveCartListId();
  const client = await getTasksClient();

  const response = await client.tasks.list({
    tasklist: listId,
    maxResults: 100,
    showCompleted: false,
    showHidden: false,
  });

  const tasks = response.data.items || [];
  const items = tasks
    .filter((t) => t.title)
    .map((t) => {
      const parsed = t.notes ? parseNotes(t.notes) : null;
      const qtyMatch = t.title!.match(/\(x(\d+)\)$/);
      const quantity = qtyMatch ? parseInt(qtyMatch[1]!, 10) : 1;
      const productName = qtyMatch ? t.title!.replace(/\s*\(x\d+\)$/, "") : t.title!;

      return {
        groceryItem: parsed?.item ?? productName.toLowerCase(),
        productName,
        quantity,
      };
    });

  return { count: items.length, items };
}

export async function clearCart(): Promise<number> {
  const listId = await resolveCartListId();
  const client = await getTasksClient();

  const response = await client.tasks.list({
    tasklist: listId,
    maxResults: 100,
    showCompleted: false,
    showHidden: false,
  });

  const tasks = response.data.items || [];
  for (const task of tasks) {
    if (task.id) {
      await client.tasks.delete({ tasklist: listId, task: task.id });
    }
  }

  return tasks.length;
}
