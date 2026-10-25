import type { ProductOffer } from "../../shared/offer.ts";
import { verifiedDiscount } from "../../shared/offer.ts";
import { parseQuantity } from "../../shared/quantity.ts";
import type { ConnectorResult } from "./types.ts";

export function readOfferPayload(text: string, source: string, retrievedAt: string): ConnectorResult {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return malformed();
  }
  if (!Array.isArray(value)) return malformed();
  const offers: ProductOffer[] = [];
  for (const row of value) {
    const offer = readRow(row, source, retrievedAt);
    if (!offer) return malformed();
    offers.push(offer);
  }
  return { ok: true, offers };
}

function readRow(row: unknown, source: string, retrievedAt: string): ProductOffer | null {
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.trim().length === 0) return null;
  if (typeof record.platform !== "string" || record.platform.trim().length === 0) return null;
  if (typeof record.price !== "number" || !Number.isFinite(record.price)) return null;
  if (typeof record.productUrl !== "string") return null;
  const quantityText = typeof record.quantity === "string" ? record.quantity : "";
  const quantity = quantityText.length > 0 ? parseQuantity(quantityText) : null;
  const mrp = typeof record.mrp === "number" && Number.isFinite(record.mrp) ? record.mrp : null;
  const brand = typeof record.brand === "string" ? record.brand : null;
  return {
    id: `${source}:${record.name}:${quantityText || "unknown"}`,
    name: record.name,
    brand,
    quantity,
    quantityLabel: quantity?.raw || quantityText || "unspecified",
    price: record.price,
    mrp,
    discountAmount: verifiedDiscount(record.price, mrp),
    available: record.available !== false,
    platform: record.platform,
    productUrl: record.productUrl,
    retrievedAt,
    source,
    provenance: "live",
  };
}

function malformed(): ConnectorResult {
  return { ok: false, failure: { code: "malformed", message: "Connector returned malformed JSON." } };
}
