import { cityById } from "../../shared/cities.ts";
import { dedupeListings, listingInWindow, sortListings, withinBudget, type Listing } from "../../shared/event.ts";
import { dateRange, windowLabel } from "../../shared/when.ts";
import type { ListingCache } from "../listingCache.ts";
import type { Notifier } from "../notify/notifier.ts";
import type { EventTool } from "../tools/types.ts";
import type { EventWatch, WatchStore } from "./watchStore.ts";

export type WatchRunnerOptions = {
  store: WatchStore;
  notifier: Notifier;
  tools: readonly EventTool[];
  cache: ListingCache;
  fetchImpl: typeof fetch;
  pomeradoApiKey: string;
  timeoutMs: number;
  now: () => number;
  timezone?: string;
};

export type WatchCheck = { watchId: string; ok: boolean; matched: number; fresh: Listing[]; error: string | null };

const DUE_BATCH = 5;
const NOTIFY_LIMIT = 3;

export class WatchRunner {
  private running = false;
  private readonly options: WatchRunnerOptions;

  constructor(options: WatchRunnerOptions) {
    this.options = options;
  }

  start(intervalMs: number): () => void {
    const timer = setInterval(() => void this.tick(), intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    void this.tick();
    return () => clearInterval(timer);
  }

  async tick(): Promise<WatchCheck[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const due = this.options.store.claimDue(this.options.now(), DUE_BATCH);
      const checks: WatchCheck[] = [];
      for (const watch of due) checks.push(await this.check(watch));
      return checks;
    } finally {
      this.running = false;
    }
  }

  async check(watch: EventWatch): Promise<WatchCheck> {
    const { store, now } = this.options;
    const city = cityById(watch.cityId);
    if (!city) {
      store.finish(watch.id, now(), { ok: false, error: "That city is not covered." });
      return { watchId: watch.id, ok: false, matched: 0, fresh: [], error: "That city is not covered." };
    }
    const timezone = this.options.timezone ?? "Asia/Kolkata";
    const range = dateRange(watch.when, now(), timezone);
    const results = await Promise.all(this.options.tools.map((tool) => tool.load({
      city,
      range,
      kind: watch.kind,
      timezone,
      retrievedAt: new Date(now()).toISOString(),
      timeoutMs: this.options.timeoutMs,
      signal: AbortSignal.timeout(this.options.timeoutMs * 2),
      fetchImpl: this.options.fetchImpl,
      cache: this.options.cache,
      pomeradoApiKey: this.options.pomeradoApiKey,
    }).catch(() => ({ name: tool.name, ok: false, message: "failed", listings: [] as Listing[], warnings: [] }))));
    const answered = results.filter((result) => result.ok);
    if (answered.length === 0) {
      const error = "No event source answered.";
      store.finish(watch.id, now(), { ok: false, error });
      return { watchId: watch.id, ok: false, matched: 0, fresh: [], error };
    }
    const matched = dedupeListings(sortListings(answered.flatMap((result) => result.listings).filter((listing) =>
      (watch.kind == null || listing.kind === watch.kind) && listingInWindow(listing, range) && withinBudget(listing, watch.budget),
    )));
    const freshUrls = new Set(store.unseen(watch.id, matched.map((listing) => listing.url), now()));
    const fresh = matched.filter((listing) => freshUrls.has(listing.url));
    store.finish(watch.id, now(), { ok: true, newHits: fresh.length });
    if (fresh.length > 0) await this.announce(watch, city.name, fresh);
    return { watchId: watch.id, ok: true, matched: matched.length, fresh, error: null };
  }

  private async announce(watch: EventWatch, cityName: string, fresh: Listing[]): Promise<void> {
    const top = fresh.slice(0, NOTIFY_LIMIT);
    const more = fresh.length - top.length;
    const names = top.map((listing) => `${listing.title}${priceText(listing)}`).join(", ");
    const kind = watch.kind ?? "event";
    const budget = watch.budget == null ? "" : ` under ₹${watch.budget}`;
    await this.options.notifier.notify(watch.userId, {
      agent: "event",
      kind: "watch-hit",
      title: `New ${kind} in ${cityName} for ${windowLabel(watch.when)}${budget}`,
      body: more > 0 ? `${names}, and ${more} more.` : names,
      url: top[0]?.url ?? null,
    });
  }
}

function priceText(listing: Listing): string {
  if (listing.price.provenance === "free") return " (free)";
  if (listing.price.min == null || listing.price.provenance === "unknown") return "";
  return ` (₹${listing.price.min})`;
}
