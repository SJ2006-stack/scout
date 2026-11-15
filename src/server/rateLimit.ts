export class RateLimit {
  private readonly seen = new Map<string, number>();
  private readonly minIntervalMs: number;
  private readonly now: () => number;

  constructor(minIntervalMs: number, now: () => number) {
    this.minIntervalMs = minIntervalMs;
    this.now = now;
  }

  allow(key: string): boolean {
    const previous = this.seen.get(key);
    const current = this.now();
    if (this.seen.size >= MAX_KEYS) this.prune(current);
    if (previous != null && current - previous < this.minIntervalMs) return false;
    this.seen.set(key, current);
    return true;
  }

  /** Drops keys whose window has passed so the map cannot grow without bound. */
  private prune(current: number): void {
    for (const [key, at] of this.seen) {
      if (current - at >= this.minIntervalMs) this.seen.delete(key);
    }
  }
}

const MAX_KEYS = 5_000;
