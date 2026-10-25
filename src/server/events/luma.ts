import { httpsUrl, isListingUrl, kindFromText, priceFromAmount, unknownPrice, type Listing, type ListingPrice } from "../../shared/event.ts";

export function lumaEvents(payload: unknown, retrievedAt: string): Listing[] {
  if (!payload || typeof payload !== "object") return [];
  const entries = (payload as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) return [];
  const listings: Listing[] = [];
  for (const entry of entries) {
    const listing = readEntry(entry, retrievedAt);
    if (listing) listings.push(listing);
  }
  return listings;
}

function readEntry(entry: unknown, retrievedAt: string): Listing | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const event = record.event;
  if (!event || typeof event !== "object") return null;
  const show = event as Record<string, unknown>;
  if (typeof show.name !== "string" || show.name.trim().length === 0) return null;
  const url = lumaUrl(show.url);
  if (url == null) return null;
  const geo = show.geo_address_info && typeof show.geo_address_info === "object"
    ? (show.geo_address_info as Record<string, unknown>)
    : null;
  const coordinate = show.coordinate && typeof show.coordinate === "object"
    ? (show.coordinate as Record<string, unknown>)
    : null;
  const title = show.name.trim();
  const venue = typeof geo?.address === "string" ? geo.address : null;
  return {
    id: `luma:${url}`,
    sourceId: typeof show.api_id === "string" ? show.api_id : url,
    platform: "Luma",
    title,
    kind: kindFromText(`${title} ${venue ?? ""}`),
    posterUrl: httpsUrl(show.cover_url),
    start: typeof show.start_at === "string" ? show.start_at : null,
    end: typeof show.end_at === "string" ? show.end_at : null,
    timezone: typeof show.timezone === "string" ? show.timezone : "Asia/Kolkata",
    city: typeof geo?.city === "string" ? geo.city : null,
    venue,
    lat: readCoord(coordinate?.latitude),
    lon: readCoord(coordinate?.longitude),
    price: readTicket(record.ticket_info),
    url,
    retrievedAt,
    category: null,
    driveMinutes: null,
  };
}

function lumaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  if (value.startsWith("https://")) return isListingUrl(value, "Luma") ? value : null;
  if (!/^[A-Za-z0-9-]+$/.test(value)) return null;
  const url = `https://luma.com/${value}`;
  return isListingUrl(url, "Luma") ? url : null;
}

function readTicket(value: unknown): ListingPrice {
  if (!value || typeof value !== "object") return unknownPrice();
  const ticket = value as Record<string, unknown>;
  const amount = typeof ticket.price === "number" ? ticket.price : null;
  const max = typeof ticket.max_price === "number" ? ticket.max_price : null;
  if (ticket.is_free === true && (amount == null || amount === 0)) return priceFromAmount(0);
  return priceFromAmount(amount, max);
}

function readCoord(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
