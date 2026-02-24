import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSearchProducts = vi.fn();
const mockSearchLocations = vi.fn();
const mockAddToCart = vi.fn();

vi.mock("./api.js", () => ({
  searchProducts: (...args: unknown[]) => mockSearchProducts(...args),
  searchLocations: (...args: unknown[]) => mockSearchLocations(...args),
  addToCart: (...args: unknown[]) => mockAddToCart(...args),
}));

const mockGetDefaultAccount = vi.fn();
const mockSetPreferredStore = vi.fn();

vi.mock("../../auth/kroger.js", () => ({
  getDefaultAccount: () => mockGetDefaultAccount(),
  setPreferredStore: (...args: unknown[]) => mockSetPreferredStore(...args),
}));

const mockTasksListTasklists = vi.fn();
const mockTasksListTasks = vi.fn();

vi.mock("../google-tasks/client.js", () => ({
  getTasksClient: vi.fn(async () => ({
    tasklists: { list: mockTasksListTasklists },
    tasks: { list: mockTasksListTasks },
  })),
}));

import { krogerModule } from "./index.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("search_kroger_products", () => {
  it("errors when no store is set", async () => {
    mockGetDefaultAccount.mockReturnValue(null);

    const result = await krogerModule.executeTool("search_kroger_products", { term: "milk" });

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("No preferred store"),
    });
    expect(mockSearchProducts).not.toHaveBeenCalled();
  });

  it("returns formatted products when store exists", async () => {
    mockGetDefaultAccount.mockReturnValue({ storeId: "store-1" });
    mockSearchProducts.mockResolvedValue([
      {
        productId: "p1",
        upc: "u1",
        name: "Whole Milk",
        brand: "Kroger",
        price: 3.49,
        size: "1 gal",
        imageUrl: null,
      },
    ]);

    const result = await krogerModule.executeTool("search_kroger_products", { term: "milk" });

    expect(result).toEqual({
      success: true,
      store_id: "store-1",
      count: 1,
      products: [
        {
          product_id: "p1",
          upc: "u1",
          name: "Whole Milk",
          brand: "Kroger",
          price: "$3.49",
          size: "1 gal",
        },
      ],
    });
  });

  it("caps limit at 20", async () => {
    mockGetDefaultAccount.mockReturnValue({ storeId: "store-1" });
    mockSearchProducts.mockResolvedValue([]);

    await krogerModule.executeTool("search_kroger_products", { term: "x", limit: 50 });

    expect(mockSearchProducts).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 }),
    );
  });
});

describe("set_kroger_store", () => {
  it("lists stores when no store_index provided", async () => {
    mockSearchLocations.mockResolvedValue([
      {
        locationId: "loc-1",
        name: "Kroger #100",
        address: "100 Main St",
        city: "Nashville",
        state: "TN",
        zipCode: "37201",
        phone: "615-555-0001",
      },
    ]);

    const result = await krogerModule.executeTool("set_kroger_store", { zip_code: "37201" });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        action: "select_store",
        stores: expect.arrayContaining([
          expect.objectContaining({ index: 0, name: "Kroger #100" }),
        ]),
      }),
    );
  });

  it("selects store with valid index", async () => {
    mockSearchLocations.mockResolvedValue([
      {
        locationId: "loc-1",
        name: "Kroger #100",
        address: "100 Main St",
        city: "Nashville",
        state: "TN",
        zipCode: "37201",
        phone: "615-555-0001",
      },
    ]);

    const result = await krogerModule.executeTool("set_kroger_store", {
      zip_code: "37201",
      store_index: 0,
    });

    expect(result).toEqual(
      expect.objectContaining({ success: true, store_id: "loc-1", name: "Kroger #100" }),
    );
    expect(mockSetPreferredStore).toHaveBeenCalledWith(
      "loc-1",
      "Kroger #100",
      "100 Main St, Nashville, TN 37201",
    );
  });

  it("errors on invalid store_index", async () => {
    mockSearchLocations.mockResolvedValue([
      {
        locationId: "loc-1",
        name: "Kroger #100",
        address: "100 Main St",
        city: "Nashville",
        state: "TN",
        zipCode: "37201",
        phone: "615-555-0001",
      },
    ]);

    const result = await krogerModule.executeTool("set_kroger_store", {
      zip_code: "37201",
      store_index: 5,
    });

    expect(result).toEqual(expect.objectContaining({ success: false, error: expect.stringContaining("Invalid store_index") }));
  });

  it("errors when no stores found", async () => {
    mockSearchLocations.mockResolvedValue([]);

    const result = await krogerModule.executeTool("set_kroger_store", { zip_code: "00000" });

    expect(result).toEqual(
      expect.objectContaining({ success: false, error: expect.stringContaining("No Kroger stores") }),
    );
  });
});

describe("send_to_kroger_cart", () => {
  it("errors when no store is set", async () => {
    mockGetDefaultAccount.mockReturnValue(null);

    const result = await krogerModule.executeTool("send_to_kroger_cart", {});

    expect(result).toEqual(
      expect.objectContaining({ success: false, error: expect.stringContaining("No preferred store") }),
    );
  });

  it("errors when no grocery list exists", async () => {
    mockGetDefaultAccount.mockReturnValue({ storeId: "store-1" });
    mockTasksListTasklists.mockResolvedValue({
      data: { items: [{ id: "list-1", title: "General" }] },
    });

    const result = await krogerModule.executeTool("send_to_kroger_cart", {});

    expect(result).toEqual(
      expect.objectContaining({ success: false, error: expect.stringContaining("No 'grocery' list") }),
    );
  });

  it("errors when grocery list is empty", async () => {
    mockGetDefaultAccount.mockReturnValue({ storeId: "store-1" });
    mockTasksListTasklists.mockResolvedValue({
      data: { items: [{ id: "list-grocery", title: "grocery" }] },
    });
    mockTasksListTasks.mockResolvedValue({ data: { items: [] } });

    const result = await krogerModule.executeTool("send_to_kroger_cart", {});

    expect(result).toEqual(
      expect.objectContaining({ success: false, error: expect.stringContaining("empty") }),
    );
  });

  it("searches each item, adds to cart, and reports results", async () => {
    mockGetDefaultAccount.mockReturnValue({ storeId: "store-1" });
    mockTasksListTasklists.mockResolvedValue({
      data: { items: [{ id: "list-grocery", title: "grocery" }] },
    });
    mockTasksListTasks.mockResolvedValue({
      data: {
        items: [
          { title: "Whole Milk" },
          { title: "Dragon Fruit Jam" },
        ],
      },
    });

    mockSearchProducts
      .mockResolvedValueOnce([{ productId: "p1", upc: "upc-milk", name: "Kroger Whole Milk", brand: "Kroger", price: 3.49, size: "1 gal", imageUrl: null }])
      .mockResolvedValueOnce([]); // Dragon Fruit Jam not found

    mockAddToCart.mockResolvedValue(undefined);

    const result = (await krogerModule.executeTool("send_to_kroger_cart", {})) as Record<string, unknown>;

    expect(result["success"]).toBe(true);
    expect(result["added_to_cart"]).toEqual([
      { grocery_item: "Whole Milk", kroger_product: "Kroger Whole Milk" },
    ]);
    expect(result["not_found"]).toEqual(["Dragon Fruit Jam"]);

    expect(mockAddToCart).toHaveBeenCalledWith([{ upc: "upc-milk", quantity: 1 }]);

    // Verify search was called with store ID
    expect(mockSearchProducts).toHaveBeenCalledWith(
      expect.objectContaining({ term: "Whole Milk", locationId: "store-1", limit: 1 }),
    );
  });

  it("skips addToCart when no items matched", async () => {
    mockGetDefaultAccount.mockReturnValue({ storeId: "store-1" });
    mockTasksListTasklists.mockResolvedValue({
      data: { items: [{ id: "list-grocery", title: "grocery" }] },
    });
    mockTasksListTasks.mockResolvedValue({
      data: { items: [{ title: "Unicorn Steak" }] },
    });
    mockSearchProducts.mockResolvedValue([]);

    const result = (await krogerModule.executeTool("send_to_kroger_cart", {})) as Record<string, unknown>;

    expect(result["success"]).toBe(true);
    expect(result["added_to_cart"]).toEqual([]);
    expect(result["not_found"]).toEqual(["Unicorn Steak"]);
    expect(mockAddToCart).not.toHaveBeenCalled();
  });
});
