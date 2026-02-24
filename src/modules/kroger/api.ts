import { krogerApiFetch } from "../../auth/kroger.js";

export interface KrogerProduct {
  productId: string;
  upc: string;
  name: string;
  brand: string;
  price: number | null;
  size: string;
  imageUrl: string | null;
}

export interface KrogerLocation {
  locationId: string;
  name: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  phone: string;
}

interface KrogerProductResponse {
  data: Array<{
    productId: string;
    upc: string;
    description: string;
    brand: string;
    items: Array<{
      price?: { regular?: number; promo?: number };
      size?: string;
    }>;
    images: Array<{
      perspective: string;
      sizes: Array<{ size: string; url: string }>;
    }>;
  }>;
}

interface KrogerLocationResponse {
  data: Array<{
    locationId: string;
    name: string;
    address: {
      addressLine1: string;
      city: string;
      state: string;
      zipCode: string;
    };
    phone: string;
  }>;
}

export async function searchProducts(opts: {
  term: string;
  locationId?: string;
  limit?: number;
}): Promise<KrogerProduct[]> {
  const params = new URLSearchParams({
    "filter.term": opts.term,
    "filter.limit": String(opts.limit ?? 5),
  });
  if (opts.locationId) {
    params.set("filter.locationId", opts.locationId);
  }

  const res = (await krogerApiFetch(`/products?${params.toString()}`)) as KrogerProductResponse;

  return res.data.map((p) => {
    const item = p.items[0];
    const price = item?.price?.promo ?? item?.price?.regular ?? null;
    const frontImage = p.images.find((i) => i.perspective === "front");
    const imageUrl = frontImage?.sizes.find((s) => s.size === "medium")?.url
      ?? frontImage?.sizes[0]?.url
      ?? null;

    return {
      productId: p.productId,
      upc: p.upc,
      name: p.description,
      brand: p.brand,
      price,
      size: item?.size ?? "",
      imageUrl,
    };
  });
}

export async function addToCart(
  items: Array<{ upc: string; quantity: number }>,
): Promise<void> {
  await krogerApiFetch("/cart/add", {
    method: "PUT",
    auth: "user",
    body: { items: items.map((i) => ({ upc: i.upc, quantity: i.quantity })) },
  });
}

export async function searchLocations(opts: {
  zipCode: string;
  radiusMiles?: number;
  limit?: number;
}): Promise<KrogerLocation[]> {
  const params = new URLSearchParams({
    "filter.zipCode.near": opts.zipCode,
    "filter.radiusInMiles": String(opts.radiusMiles ?? 10),
    "filter.limit": String(opts.limit ?? 5),
  });

  const res = (await krogerApiFetch(`/locations?${params.toString()}`)) as KrogerLocationResponse;

  return res.data.map((l) => ({
    locationId: l.locationId,
    name: l.name,
    address: l.address.addressLine1,
    city: l.address.city,
    state: l.address.state,
    zipCode: l.address.zipCode,
    phone: l.phone,
  }));
}
