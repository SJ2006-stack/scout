import type { ProductOffer, Quantity } from "../shared/offer.ts";
import { quantityKey } from "../shared/quantity.ts";

export type CacheRecord = {
  offers: ProductOffer[];
  storedAt: number;
};

export function roundCoordinate(value: number): number {
  return Math.round(value * 100) / 100;
}

export function cacheKey(input: {
  source: string;
  keywords: string;
  quantity: Quantity | null;
  pincode: string;
  lat: number | null;
  lon: number | null;
}): string {
  const lat = input.lat == null ? "none" : roundCoordinate(input.lat).toFixed(2);
  const lon = input.lon == null ? "none" : roundCoordinate(input.lon).toFixed(2);
  return [input.source, input.keywords, quantityKey(input.quantity), input.pincode, lat, lon].join("|");
}

export class PriceCache {
  private readonly records = new Map<string, CacheRecord>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs: number, now: () => number) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get(key: string): ProductOffer[] | undefined {
    const record = this.records.get(key);
    if (!record) return undefined;
    if (this.now() - record.storedAt >= this.ttlMs) {
      this.records.delete(key);
      return undefined;
    }
    return record.offers.map((offer) => ({ ...offer, provenance: "cached" }));
  }

  set(key: string, offers: ProductOffer[]): void {
    this.records.set(key, {
      storedAt: this.now(),
      offers: offers.map((offer) => ({ ...offer })),
    });
  }
}
