export type Provenance = "live" | "cached" | "demo";

export type QuantityUnit = "ml" | "g";

export type Quantity = {
  amount: number;
  unit: QuantityUnit;
  raw: string;
};

export type ProductOffer = {
  id: string;
  name: string;
  brand: string | null;
  quantity: Quantity | null;
  quantityLabel: string;
  price: number;
  mrp: number | null;
  discountAmount: number | null;
  available: boolean;
  platform: string;
  productUrl: string;
  retrievedAt: string;
  source: string;
  provenance: Provenance;
};

export type FailureCode = "timeout" | "unavailable" | "malformed" | "cancelled";

export type ConnectorFailure = {
  code: FailureCode;
  message: string;
};

export type DeliveryArea = {
  pincode: string;
  lat: number | null;
  lon: number | null;
  label: string;
  confirmed: boolean;
  approximate: boolean;
};

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function verifiedDiscount(price: number, mrp: number | null): number | null {
  if (mrp == null || !Number.isFinite(mrp) || !Number.isFinite(price)) return null;
  if (mrp <= price) return null;
  return roundMoney(mrp - price);
}

export function isSafeProductUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.hostname.length > 0;
}

export function isUsefulOffer(offer: ProductOffer): boolean {
  return (
    offer.name.trim().length > 0 &&
    offer.platform.trim().length > 0 &&
    Number.isFinite(offer.price) &&
    offer.price >= 0 &&
    isSafeProductUrl(offer.productUrl)
  );
}
