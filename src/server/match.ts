import type { ProductOffer } from "../shared/offer.ts";
import { verifiedDiscount } from "../shared/offer.ts";
import { quantitiesMatch, quantityKey } from "../shared/quantity.ts";

export function applyDiscount(offer: ProductOffer): ProductOffer {
  return { ...offer, discountAmount: verifiedDiscount(offer.price, offer.mrp) };
}

export function samePack(left: ProductOffer, right: ProductOffer): boolean {
  return (
    left.platform.trim().toLowerCase() === right.platform.trim().toLowerCase() &&
    left.name.trim().toLowerCase() === right.name.trim().toLowerCase() &&
    quantitiesMatch(left.quantity, right.quantity)
  );
}

export function dedupeOffers(offers: ProductOffer[]): ProductOffer[] {
  const kept = new Map<string, ProductOffer>();
  for (const offer of offers) {
    const key = [
      offer.platform.trim().toLowerCase(),
      offer.name.trim().toLowerCase(),
      quantityKey(offer.quantity),
    ].join("|");
    const existing = kept.get(key);
    if (!existing || offer.price < existing.price) kept.set(key, offer);
  }
  return [...kept.values()];
}

export function sortOffers(offers: ProductOffer[]): ProductOffer[] {
  return [...offers].sort(
    (left, right) =>
      left.price - right.price ||
      left.name.localeCompare(right.name) ||
      left.platform.localeCompare(right.platform),
  );
}

export function prepareOffers(offers: ProductOffer[]): ProductOffer[] {
  return sortOffers(dedupeOffers(offers.map(applyDiscount)));
}
