import { httpsUrl, isListingUrl, kindFromText, priceFromAmount, unknownPrice, type Listing, type ListingPrice } from "../../shared/event.ts";
import { itemLists, readJsonLd } from "./jsonld.ts";

/** BookMyShow explore pages: /explore/movies-<city> and /explore/events-<city>. */
export function bookMyShowExploreUrl(kind: "movies" | "events", citySlug: string): string {
  return `https://in.bookmyshow.com/explore/${kind}-${encodeURIComponent(citySlug)}`;
}

/** Reads the movie and event lists BookMyShow puts in each explore page's JSON-LD. */
export function bookMyShowPageListings(html: string, cityName: string, retrievedAt: string): Listing[] {
  const byUrl = new Map<string, Listing>();
  for (const list of itemLists(readJsonLd(html))) {
    const elements = Array.isArray(list.itemListElement) ? list.itemListElement : [];
    for (const element of elements) {
      const listing = readElement(element, cityName, retrievedAt);
      if (listing && !byUrl.has(listing.url)) byUrl.set(listing.url, listing);
    }
  }
  return [...byUrl.values()];
}

function readElement(element: unknown, cityName: string, retrievedAt: string): Listing | null {
  if (!element || typeof element !== "object") return null;
  const record = element as Record<string, unknown>;
  const item = record.item && typeof record.item === "object" ? (record.item as Record<string, unknown>) : record;
  const name = typeof item.name === "string" ? item.name.trim() : "";
  const url = typeof item.url === "string" ? item.url.trim() : "";
  if (name.length === 0 || !isListingUrl(url, "BookMyShow")) return null;
  const path = new URL(url).pathname;
  const code = /\/(ET\d+|et[a-z0-9]+)\/?$/i.exec(path)?.[1];
  if (!code) return null;
  if (/\/movies\//.test(path)) return movie(name, url, code, cityName, retrievedAt, item);
  if (!/\/events\//.test(path)) return null;
  const place = readPlace(item.location);
  const type = typeof item["@type"] === "string" ? item["@type"] : "";
  return {
    id: `bookmyshow:${code}`,
    sourceId: code,
    platform: "BookMyShow",
    title: name,
    kind: kindFromText(`${type} ${name} ${place.venue ?? ""}`),
    posterUrl: httpsUrl(item.image),
    start: istTime(item.startDate),
    end: istTime(item.endDate),
    timezone: "Asia/Kolkata",
    city: cityName,
    venue: place.venue,
    lat: null,
    lon: null,
    price: readOffers(item.offers),
    url,
    retrievedAt,
    category: type.length > 0 && type !== "Event" ? type.replace(/Event$/, "") : null,
    driveMinutes: null,
  };
}

function movie(name: string, url: string, code: string, cityName: string, retrievedAt: string, item: Record<string, unknown>): Listing {
  return {
    id: `bookmyshow:${code}`,
    sourceId: code,
    platform: "BookMyShow",
    title: name,
    kind: "movie",
    posterUrl: httpsUrl(item.image),
    start: null,
    end: null,
    timezone: "Asia/Kolkata",
    city: cityName,
    venue: null,
    lat: null,
    lon: null,
    price: unknownPrice(),
    url,
    retrievedAt,
    category: "Movie",
    driveMinutes: null,
  };
}

/** BookMyShow writes local Indian time without an offset. */
function istTime(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const text = value.trim();
  const stamped = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}+05:30`;
  return Number.isFinite(Date.parse(stamped)) ? new Date(Date.parse(stamped)).toISOString() : null;
}

function readPlace(value: unknown): { venue: string | null } {
  if (!value || typeof value !== "object") return { venue: null };
  const name = (value as Record<string, unknown>).name;
  return { venue: typeof name === "string" && name.trim().length > 0 ? name.trim() : null };
}

function readOffers(value: unknown): ListingPrice {
  const offers = (Array.isArray(value) ? value : [value]).filter((offer): offer is Record<string, unknown> => offer != null && typeof offer === "object");
  const amounts = offers
    .flatMap((offer) => [offer.price, offer.lowPrice, offer.highPrice])
    .map((amount) => (typeof amount === "number" ? amount : typeof amount === "string" ? Number(amount) : NaN))
    .filter((amount) => Number.isFinite(amount) && amount >= 0);
  if (amounts.length === 0) return unknownPrice();
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  return priceFromAmount(min, max > min ? max : null);
}
