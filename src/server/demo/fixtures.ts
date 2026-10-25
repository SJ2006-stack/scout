import type { ProductOffer } from "../../shared/offer.ts";
import { DEMO_REQUEST } from "../../shared/demoRequest.ts";

const RETRIEVED_AT = "2026-01-01T00:00:00.000Z";

export const DEMO_OFFERS: ProductOffer[] = [
  {
    id: "demo-mart:amul-taaza-1l",
    name: "Amul Taaza Homogenised Toned Milk",
    brand: "Amul",
    quantity: { amount: 1000, unit: "ml", raw: "1 litre" },
    quantityLabel: "1 L",
    price: 66,
    mrp: 99,
    discountAmount: 33,
    available: true,
    platform: "Demo Mart",
    productUrl: "https://example.com/scout-demo/amul-taaza-1l",
    retrievedAt: RETRIEVED_AT,
    source: "demo-mart",
    provenance: "demo",
  },
  {
    id: "demo-mart:amul-taaza-1l-bazaar",
    name: "Amul Taaza Toned Milk",
    brand: "Amul",
    quantity: { amount: 1000, unit: "ml", raw: "1 litre" },
    quantityLabel: "1 L",
    price: 72,
    mrp: 99,
    discountAmount: 27,
    available: true,
    platform: "Demo Bazaar",
    productUrl: "https://example.com/scout-demo/amul-taaza-1l-bazaar",
    retrievedAt: RETRIEVED_AT,
    source: "demo-mart",
    provenance: "demo",
  },
];

export const DEMO_FAILURE = {
  connectorId: "demo-corner",
  code: "unavailable" as const,
  message: "Demonstration store did not respond. This is sample data, not a live price check.",
};

export { DEMO_REQUEST };
