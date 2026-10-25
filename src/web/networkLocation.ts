export type NetworkPlace = {
  place: string;
  lat: number;
  lon: number;
};

export function readNetworkPlace(value: unknown): NetworkPlace | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.success === false) return null;
  const place = uniqueParts([text(record.city), text(record.region), text(record.country)]);
  const lat = coordinate(record.latitude, -90, 90);
  const lon = coordinate(record.longitude, -180, 180);
  if (place.length === 0 || lat == null || lon == null) return null;
  return { place, lat, lon };
}

export async function detectNetworkLocation(fetchImpl: typeof fetch = fetch): Promise<NetworkPlace | null> {
  const response = await fetchImpl("https://ipwho.is/", { cache: "no-store" });
  if (!response.ok) return null;
  return readNetworkPlace(await response.json());
}

function uniqueParts(parts: string[]): string {
  return parts.filter((part, index) => part.length > 0 && parts.indexOf(part) === index).join(", ");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function coordinate(value: unknown, min: number, max: number): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number) || number < min || number > max) return null;
  return number;
}
