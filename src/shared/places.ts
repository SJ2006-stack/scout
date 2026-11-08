export type SavedPlace = { app: string; label: string; url: string };

const PLACE_HOSTS = new Set(["blinkit.com", "www.zepto.com", "www.swiggy.com", "wa.me"]);

/** A saved app link: https, on Blinkit, Zepto, Instamart, or WhatsApp, nothing else. */
export function readPlaces(value: unknown): SavedPlace[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 6) return null;
  const places: SavedPlace[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const row = item as { app?: unknown; label?: unknown; url?: unknown };
    if (typeof row.app !== "string" || row.app.length === 0 || row.app.length > 40) return null;
    if (typeof row.label !== "string" || row.label.length === 0 || row.label.length > 80) return null;
    if (!placeUrl(row.url)) return null;
    places.push({ app: row.app, label: row.label, url: row.url });
  }
  return places;
}

function placeUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 300 || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && PLACE_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
