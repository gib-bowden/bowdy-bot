import { describe, it, expect, vi, beforeEach } from "vitest";

const mockKrogerApiFetch = vi.fn();

vi.mock("../../auth/kroger.js", () => ({
  krogerApiFetch: (...args: unknown[]) => mockKrogerApiFetch(...args),
}));

import { searchProducts, searchLocations, addToCart } from "./api.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("searchProducts", () => {
  it("normalizes Kroger response — description→name, promo preferred over regular, front medium image", async () => {
    mockKrogerApiFetch.mockResolvedValue({
      data: [
        {
          productId: "0001111041700",
          upc: "0001111041700",
          description: "Kroger 2% Reduced Fat Milk",
          brand: "Kroger",
          items: [
            { price: { regular: 4.29, promo: 3.49 }, size: "1 gal" },
          ],
          images: [
            {
              perspective: "front",
              sizes: [
                { size: "small", url: "https://img.kroger.com/small.jpg" },
                { size: "medium", url: "https://img.kroger.com/medium.jpg" },
                { size: "large", url: "https://img.kroger.com/large.jpg" },
              ],
            },
          ],
        },
      ],
    });

    const products = await searchProducts({ term: "milk", locationId: "store-1", limit: 5 });

    expect(products).toHaveLength(1);
    expect(products[0]).toEqual({
      productId: "0001111041700",
      upc: "0001111041700",
      name: "Kroger 2% Reduced Fat Milk",
      brand: "Kroger",
      price: 3.49,
      size: "1 gal",
      imageUrl: "https://img.kroger.com/medium.jpg",
    });
  });

  it("falls back to regular price when no promo", async () => {
    mockKrogerApiFetch.mockResolvedValue({
      data: [
        {
          productId: "p1",
          upc: "u1",
          description: "Bread",
          brand: "Wonder",
          items: [{ price: { regular: 2.99 }, size: "20 oz" }],
          images: [],
        },
      ],
    });

    const products = await searchProducts({ term: "bread" });
    expect(products[0]!.price).toBe(2.99);
    expect(products[0]!.imageUrl).toBeNull();
  });

  it("handles missing price and size", async () => {
    mockKrogerApiFetch.mockResolvedValue({
      data: [
        {
          productId: "p2",
          upc: "u2",
          description: "Mystery Item",
          brand: "Unknown",
          items: [],
          images: [],
        },
      ],
    });

    const products = await searchProducts({ term: "mystery" });
    expect(products[0]!.price).toBeNull();
    expect(products[0]!.size).toBe("");
  });

  it("passes filter params to API", async () => {
    mockKrogerApiFetch.mockResolvedValue({ data: [] });

    await searchProducts({ term: "eggs", locationId: "loc-42", limit: 3 });

    expect(mockKrogerApiFetch).toHaveBeenCalledWith(
      expect.stringContaining("filter.term=eggs"),
    );
    expect(mockKrogerApiFetch).toHaveBeenCalledWith(
      expect.stringContaining("filter.locationId=loc-42"),
    );
    expect(mockKrogerApiFetch).toHaveBeenCalledWith(
      expect.stringContaining("filter.limit=3"),
    );
  });
});

describe("searchLocations", () => {
  it("normalizes address fields from nested response", async () => {
    mockKrogerApiFetch.mockResolvedValue({
      data: [
        {
          locationId: "loc-1",
          name: "Kroger #123",
          address: {
            addressLine1: "100 Main St",
            city: "Nashville",
            state: "TN",
            zipCode: "37201",
          },
          phone: "615-555-1234",
        },
      ],
    });

    const locations = await searchLocations({ zipCode: "37201" });

    expect(locations).toHaveLength(1);
    expect(locations[0]).toEqual({
      locationId: "loc-1",
      name: "Kroger #123",
      address: "100 Main St",
      city: "Nashville",
      state: "TN",
      zipCode: "37201",
      phone: "615-555-1234",
    });
  });

  it("passes zip and radius params to API", async () => {
    mockKrogerApiFetch.mockResolvedValue({ data: [] });

    await searchLocations({ zipCode: "90210", radiusMiles: 5, limit: 3 });

    expect(mockKrogerApiFetch).toHaveBeenCalledWith(
      expect.stringContaining("filter.zipCode.near=90210"),
    );
    expect(mockKrogerApiFetch).toHaveBeenCalledWith(
      expect.stringContaining("filter.radiusInMiles=5"),
    );
    expect(mockKrogerApiFetch).toHaveBeenCalledWith(
      expect.stringContaining("filter.limit=3"),
    );
  });
});

describe("addToCart", () => {
  it("sends correct payload with user auth", async () => {
    mockKrogerApiFetch.mockResolvedValue(undefined);

    await addToCart([
      { upc: "upc-001", quantity: 2 },
      { upc: "upc-002", quantity: 1 },
    ]);

    expect(mockKrogerApiFetch).toHaveBeenCalledWith("/cart/add", {
      method: "PUT",
      auth: "user",
      body: {
        items: [
          { upc: "upc-001", quantity: 2 },
          { upc: "upc-002", quantity: 1 },
        ],
      },
    });
  });
});
