import type { DateRange } from "./when.ts";

export type Platform = "Luma" | "District" | "BookMyShow";

export type EventKind = "movie" | "concert" | "comedy" | "theatre" | "workshop" | "other";

export type PriceProvenance = "free" | "advertised" | "unknown";

export type ListingPrice = {
  min: number | null;
  max: number | null;
  currency: "INR";
  provenance: PriceProvenance;
};

export type Listing = {
  id: string;
  sourceId: string;
  platform: Platform;
  title: string;
  kind: EventKind;
  posterUrl: string | null;
  start: string | null;
  end: string | null;
  timezone: string;
  city: string | null;
  venue: string | null;
  lat: number | null;
  lon: number | null;
  price: ListingPrice;
  url: string;
  retrievedAt: string;
  category: string | null;
  driveMinutes: number | null;
};

export function unknownPrice(): ListingPrice {
  return { min: null, max: null, currency: "INR", provenance: "unknown" };
}

export function priceFromAmount(amount: number | null, max: number | null = null): ListingPrice {
  if (amount == null || !Number.isFinite(amount) || amount < 0) return unknownPrice();
  if (amount === 0) return { min: 0, max: null, currency: "INR", provenance: "free" };
  const top = max != null && Number.isFinite(max) && max >= amount ? max : null;
  return { min: amount, max: top, currency: "INR", provenance: "advertised" };
}

export function isListingUrl(value: string, platform: Platform): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
  switch (platform) {
    case "Luma":
      return url.hostname === "luma.com" || url.hostname === "www.luma.com";
    case "District":
      return url.hostname === "www.district.in" && url.pathname.length > 1;
    case "BookMyShow":
      return url.hostname === "in.bookmyshow.com" && url.pathname.length > 1;
    default: {
      const neverPlatform: never = platform;
      return neverPlatform;
    }
  }
}

export function cardAction(listing: Pick<Listing, "platform" | "url">): { href: string; label: string } | null {
  if (!isListingUrl(listing.url, listing.platform)) return null;
  switch (listing.platform) {
    case "BookMyShow":
      return { href: listing.url, label: "View on BookMyShow" };
    case "Luma":
      return { href: listing.url, label: "View on Luma" };
    case "District": {
      const booking = new URL(listing.url).pathname.includes("buy-tickets");
      return { href: listing.url, label: booking ? "Book on District" : "View on District" };
    }
    default: {
      const neverPlatform: never = listing.platform;
      return neverPlatform;
    }
  }
}

export type CardFilter = "all" | "comedy" | "music" | "workshop" | "movie" | "other";

export function matchesCardFilter(kind: EventKind, filter: CardFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "comedy":
      return kind === "comedy";
    case "music":
      return kind === "concert";
    case "workshop":
      return kind === "workshop";
    case "movie":
      return kind === "movie";
    case "other":
      return kind === "theatre" || kind === "other";
    default: {
      const neverFilter: never = filter;
      return neverFilter;
    }
  }
}

export function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function kindFromText(text: string): EventKind {
  const value = text.toLowerCase();
  if (value.includes("comedy")) return "comedy";
  if (value.includes("concert") || value.includes("music")) return "concert";
  if (value.includes("theatre") || value.includes("theater") || value.includes("play")) return "theatre";
  if (value.includes("workshop")) return "workshop";
  if (value.includes("movie") || value.includes("film")) return "movie";
  return "other";
}

export function withinBudget(listing: Listing, budget: number | null): boolean {
  if (budget == null) return true;
  if (listing.price.provenance === "free" || listing.price.provenance === "unknown") return true;
  if (listing.price.min == null) return true;
  return listing.price.min <= budget;
}

export function withinDates(listing: Listing, range: { startMs: number; endMs: number }): boolean {
  if (listing.start == null) return listing.kind === "movie";
  const time = Date.parse(listing.start);
  if (!Number.isFinite(time)) return false;
  return time >= range.startMs && time < range.endMs;
}

export function listingInWindow(listing: Listing, range: DateRange): boolean {
  const singleDay = range.phrase === "today" || range.phrase === "tomorrow";
  if (listing.start == null) {
    if (listing.platform === "BookMyShow") return true;
    if (singleDay) return false;
    return withinDates(listing, range);
  }
  return withinDates(listing, range);
}

export function dedupeListings(listings: Listing[]): Listing[] {
  const seen = new Set<string>();
  const kept: Listing[] = [];
  for (const listing of listings) {
    if (seen.has(listing.url)) continue;
    seen.add(listing.url);
    kept.push(listing);
  }
  return kept;
}

function priceRank(price: ListingPrice): number {
  if (price.provenance === "unknown" || price.min == null) return Number.POSITIVE_INFINITY;
  return price.min;
}

export function sortListings(listings: Listing[]): Listing[] {
  return [...listings].sort((left, right) => {
    const leftDated = left.start != null;
    const rightDated = right.start != null;
    if (leftDated !== rightDated) return leftDated ? -1 : 1;
    if (left.start != null && right.start != null && left.start !== right.start) {
      return left.start < right.start ? -1 : 1;
    }
    const price = priceRank(left.price) - priceRank(right.price);
    if (price !== 0) return price;
    return left.title.localeCompare(right.title);
  });
}
