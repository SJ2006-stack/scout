import type { Listing } from "../shared/event.ts";

export function listingCacheTtlMs(value: string | undefined): number {
  const parsed = Number(value ?? 600_000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
}

type Record = { listings: Listing[]; storedAt: number };

export class ListingCache {
  private readonly records = new Map<string, Record>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs: number, now: () => number) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get(key: string): Listing[] | undefined {
    const record = this.records.get(key);
    if (!record) return undefined;
    if (this.now() - record.storedAt >= this.ttlMs) {
      this.records.delete(key);
      return undefined;
    }
    return record.listings;
  }

  set(key: string, listings: Listing[]): void {
    this.records.set(key, { listings, storedAt: this.now() });
  }
}
