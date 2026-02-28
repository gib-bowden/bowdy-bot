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

const mockLookupPreference = vi.fn();
const mockSavePreference = vi.fn();
const mockListPreferences = vi.fn();
const mockDeletePreference = vi.fn();

vi.mock("./preferences.js", () => ({
  lookupPreference: (...args: unknown[]) => mockLookupPreference(...args),
  savePreference: (...args: unknown[]) => mockSavePreference(...args),
  listPreferences: () => mockListPreferences(),
  deletePreference: (...args: unknown[]) => mockDeletePreference(...args),
}));

import { krogerModule } from "./index.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockLookupPreference.mockReturnValue(null);
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

  it("returns items without preferences as needs_selection with candidates", async () => {
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
      .mockResolvedValueOnce([
        { productId: "p1", upc: "upc-milk", name: "Kroger Whole Milk", brand: "Kroger", price: 3.49, size: "1 gal", imageUrl: null },
        { productId: "p2", upc: "upc-milk-2", name: "Organic Whole Milk", brand: "Simple Truth", price: 5.99, size: "1 gal", imageUrl: null },
      ])
      .mockResolvedValueOnce([]); // Dragon Fruit Jam not found

    const result = (await krogerModule.executeTool("send_to_kroger_cart", {})) as Record<string, unknown>;

    expect(result["success"]).toBe(true);
    expect(result["added_to_cart"]).toEqual([]);
    expect(result["needs_selection"]).toEqual([
      {
        grocery_item: "Whole Milk",
        candidates: [
          { product_id: "p1", upc: "upc-milk", name: "Kroger Whole Milk", brand: "Kroger", price: "$3.49", size: "1 gal" },
          { product_id: "p2", upc: "upc-milk-2", name: "Organic Whole Milk", brand: "Simple Truth", price: "$5.99", size: "1 gal" },
        ],
      },
    ]);
    expect(result["not_found"]).toEqual(["Dragon Fruit Jam"]);

    // No items should be added to cart — all need user selection
    expect(mockAddToCart).not.toHaveBeenCalled();

    // Verify search was called with limit 3
    expect(mockSearchProducts).toHaveBeenCalledWith(
      expect.objectContaining({ term: "Whole Milk", locationId: "store-1", limit: 3 }),
    );
  });

  it("adds preference items to cart and returns others as needs_selection", async () => {
    mockGetDefaultAccount.mockReturnValue({ storeId: "store-1" });
    mockTasksListTasklists.mockResolvedValue({
      data: { items: [{ id: "list-grocery", title: "grocery" }] },
    });
    mockTasksListTasks.mockResolvedValue({
      data: {
        items: [
          { title: "Eggs" },
          { title: "Bread" },
        ],
      },
    });

    mockLookupPreference
      .mockReturnValueOnce({
        id: "pref-1",
        genericName: "eggs",
        upc: "upc-eggs-pref",
        productId: "p-eggs",
        productName: "Kroger Grade A Large Eggs, 12 ct",
        brand: "Kroger",
        size: "12 ct",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      })
      .mockReturnValueOnce(null); // No preference for Bread

    mockSearchProducts.mockResolvedValueOnce([
      { productId: "p-bread", upc: "upc-bread", name: "Wonder Bread", brand: "Wonder", price: 2.99, size: "20 oz", imageUrl: null },
    ]);
    mockAddToCart.mockResolvedValue(undefined);

    const result = (await krogerModule.executeTool("send_to_kroger_cart", {})) as Record<string, unknown>;

    expect(result["success"]).toBe(true);
    // Only the preference item gets added to cart
    expect(result["added_to_cart"]).toEqual([
      { grocery_item: "Eggs", kroger_product: "Kroger Grade A Large Eggs, 12 ct" },
    ]);
    // Bread needs user selection
    expect(result["needs_selection"]).toEqual([
      {
        grocery_item: "Bread",
        candidates: [
          { product_id: "p-bread", upc: "upc-bread", name: "Wonder Bread", brand: "Wonder", price: "$2.99", size: "20 oz" },
        ],
      },
    ]);
    // Only preference item added to cart
    expect(mockAddToCart).toHaveBeenCalledWith([{ upc: "upc-eggs-pref", quantity: 1 }]);
    // Kroger search should only be called for Bread (not Eggs)
    expect(mockSearchProducts).toHaveBeenCalledTimes(1);
    expect(mockSearchProducts).toHaveBeenCalledWith(
      expect.objectContaining({ term: "Bread" }),
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
