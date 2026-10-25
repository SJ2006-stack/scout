import type { Listing } from "../shared/event.ts";

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
