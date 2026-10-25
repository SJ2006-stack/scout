import { kindFromText, priceFromAmount, unknownPrice, httpsUrl, isListingUrl, type Listing, type ListingPrice } from "../../shared/event.ts";
import { cityMatches, type City } from "../../shared/cities.ts";
import { itemLists, readJsonLd } from "./jsonld.ts";

export function districtEvents(html: string, city: City, retrievedAt: string): Listing[] {
  const listings: Listing[] = [];
  for (const list of itemLists(readJsonLd(html))) {
    const elements = Array.isArray(list.itemListElement) ? list.itemListElement : [];
    for (const element of elements) {
      const listing = readEvent(element, city, retrievedAt);
      if (listing) listings.push(listing);
    }
  }
  return listings;
}

export function districtMovies(html: string, retrievedAt: string): Listing[] {
  const byCode = new Map<string, Listing>();
  for (const list of itemLists(readJsonLd(html))) {
    const elements = Array.isArray(list.itemListElement) ? list.itemListElement : [];
    for (const element of elements) {
      const listing = readMovie(element, retrievedAt);
      if (!listing) continue;
      const code = movieCode(listing.url);
      if (code == null) continue;
      const current = byCode.get(code);
      if (!current || preferMovieUrl(listing.url, current.url)) byCode.set(code, listing);
    }
  }
  return [...byCode.values()];
}

function readEvent(element: unknown, city: City, retrievedAt: string): Listing | null {
  if (!element || typeof element !== "object") return null;
  const item = (element as Record<string, unknown>).item;
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  if (record["@type"] !== "Event") return null;
  if (typeof record.name !== "string" || record.name.trim().length === 0) return null;
  if (typeof record.url !== "string" || !isListingUrl(record.url, "District")) return null;
  const path = new URL(record.url).pathname;
  if (!path.startsWith("/events/") || path.includes("venue-guide")) return null;
  const place = readPlace(record.location);
  if (!cityMatches(place.city, city) && !cityMatches(place.venue, city)) return null;
  const title = record.name.trim();
  return {
    id: `district:${record.url}`,
    sourceId: record.url,
    platform: "District",
    title,
    kind: kindFromText(`${title} ${place.venue ?? ""}`),
    posterUrl: firstHttps(record.image),
    start: typeof record.startDate === "string" ? record.startDate : null,
    end: typeof record.endDate === "string" ? record.endDate : null,
    timezone: "Asia/Kolkata",
    city: place.city,
    venue: place.venue,
    lat: place.lat,
    lon: place.lon,
    price: readOffers(record.offers),
    url: record.url,
    retrievedAt,
    category: null,
    driveMinutes: null,
  };
}

function readMovie(element: unknown, retrievedAt: string): Listing | null {
  if (!element || typeof element !== "object") return null;
  const record = element as Record<string, unknown>;
  if (record["@type"] !== "ListItem") return null;
  if (typeof record.name !== "string" || record.name.trim().length === 0) return null;
  if (typeof record.url !== "string" || !isListingUrl(record.url, "District")) return null;
  const path = new URL(record.url).pathname;
  if (!path.startsWith("/movies/") || path === "/movies/") return null;
  if (movieCode(record.url) == null) return null;
  const title = record.name.trim();
  return {
    id: `district-movie:${record.url}`,
    sourceId: record.url,
    platform: "District",
    title,
    kind: "movie",
    posterUrl: firstHttps(record.image),
    start: null,
    end: null,
    timezone: "Asia/Kolkata",
    city: null,
    venue: null,
    lat: null,
    lon: null,
    price: unknownPrice(),
    url: record.url,
    retrievedAt,
    category: "Movie",
    driveMinutes: null,
  };
}

function movieCode(url: string): string | null {
  const match = url.match(/-(MV\d+)$/);
  return match?.[1] ?? null;
}

function preferMovieUrl(next: string, current: string): boolean {
  const nextCity = next.includes("-in-");
  const currentCity = current.includes("-in-");
  if (nextCity !== currentCity) return !nextCity;
  return next.length < current.length;
}

function readPlace(value: unknown): { city: string | null; venue: string | null; lat: number | null; lon: number | null } {
  if (!value || typeof value !== "object") return { city: null, venue: null, lat: null, lon: null };
  const place = value as Record<string, unknown>;
  const address = place.address && typeof place.address === "object" ? (place.address as Record<string, unknown>) : null;
  const geo = place.geo && typeof place.geo === "object" ? (place.geo as Record<string, unknown>) : null;
  return {
    city: typeof address?.addressLocality === "string" ? address.addressLocality : null,
    venue: typeof place.name === "string" ? place.name : null,
    lat: readCoord(geo?.latitude),
    lon: readCoord(geo?.longitude),
  };
}

function readCoord(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function readOffers(value: unknown): ListingPrice {
  const offer = Array.isArray(value) ? value[0] : value;
  if (!offer || typeof offer !== "object") return unknownPrice();
  const record = offer as Record<string, unknown>;
  const amount = typeof record.price === "number" ? record.price : typeof record.price === "string" ? Number(record.price) : NaN;
  return priceFromAmount(Number.isFinite(amount) ? amount : null);
}

function firstHttps(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = httpsUrl(entry);
      if (url) return url;
    }
    return null;
  }
  return httpsUrl(value);
}
