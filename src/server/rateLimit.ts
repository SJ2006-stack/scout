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
    if (previous != null && current - previous < this.minIntervalMs) return false;
    this.seen.set(key, current);
    return true;
  }
}
