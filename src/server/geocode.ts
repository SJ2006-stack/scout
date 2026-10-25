import type { NormalizedAddress } from "../shared/address.ts";

export class GeocodeError extends Error {
  readonly code: "timeout" | "provider";

  constructor(code: "timeout" | "provider", message: string) {
    super(message);
    this.name = "GeocodeError";
    this.code = code;
  }
}

export type Geocoder = {
  reverse(latitude: number, longitude: number, signal: AbortSignal): Promise<NormalizedAddress | null>;
};

type CacheEntry = {
  value: NormalizedAddress | null;
  storedAt: number;
};

export function createNominatimGeocoder(options: {
  userAgent: string;
  timeoutMs: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}): Geocoder {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = new Map<string, CacheEntry>();
  return {
    async reverse(latitude, longitude, signal) {
      const key = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
      const cached = cache.get(key);
      if (cached && now() - cached.storedAt < (cached.value ? 86_400_000 : 60_000)) return cached.value;
      const url = new URL("https://nominatim.openstreetmap.org/reverse");
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("lat", String(latitude));
      url.searchParams.set("lon", String(longitude));
      url.searchParams.set("addressdetails", "1");
      url.searchParams.set("zoom", "18");
      url.searchParams.set("layer", "address");
      const timeout = AbortSignal.timeout(options.timeoutMs);
      const linked = AbortSignal.any([signal, timeout]);
      try {
        const response = await fetchImpl(url, {
          headers: { accept: "application/json", "user-agent": options.userAgent },
          signal: linked,
        });
        if (response.status === 429) throw new GeocodeError("provider", "The address service is rate limiting requests.");
        if (!response.ok) throw new GeocodeError("provider", "The address service did not return an address.");
        const payload = (await response.json()) as unknown;
        const address = parseNominatimPayload(payload, { latitude, longitude, accuracyMeters: null });
        cache.set(key, { value: address, storedAt: now() });
        return address;
      } catch (error) {
        if (error instanceof GeocodeError) throw error;
        if (timeout.aborted || signal.aborted) throw new GeocodeError("timeout", "The address service timed out.");
        throw new GeocodeError("provider", "The address service could not be reached.");
      }
    },
  };
}

export function createArcGisGeocoder(options: { timeoutMs: number; now?: () => number; fetchImpl?: typeof fetch }): Geocoder {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = new Map<string, CacheEntry>();
  return {
    async reverse(latitude, longitude, signal) {
      const key = `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
      const cached = cache.get(key);
      if (cached && cached.value && now() - cached.storedAt < 60_000) return cached.value;
      const url = new URL("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode");
      url.searchParams.set("f", "json");
      url.searchParams.set("location", `${longitude},${latitude}`);
      url.searchParams.set("featureTypes", "PointAddress,StreetAddress,POI");
      url.searchParams.set("outFields", "*");
      const timeout = AbortSignal.timeout(options.timeoutMs);
      const linked = AbortSignal.any([signal, timeout]);
      try {
        const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: linked });
        if (response.status === 429) throw new GeocodeError("provider", "The address service is rate limiting requests.");
        if (!response.ok) throw new GeocodeError("provider", "The address service did not return an address.");
        const payload = (await response.json()) as unknown;
        const address = parseArcGisReverse(payload, { latitude, longitude, accuracyMeters: null });
        if (address) cache.set(key, { value: address, storedAt: now() });
        return address;
      } catch (error) {
        if (error instanceof GeocodeError) throw error;
        if (timeout.aborted || signal.aborted) throw new GeocodeError("timeout", "The address service timed out.");
        throw new GeocodeError("provider", "The address service could not be reached.");
      }
    },
  };
}

export function parseArcGisReverse(
  value: unknown,
  fallback: { latitude: number; longitude: number; accuracyMeters: number | null },
): NormalizedAddress | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.error) return null;
  if (!record.address || typeof record.address !== "object") return null;
  const row = record.address as Record<string, unknown>;
  const text = (key: string): string => (typeof row[key] === "string" ? row[key].trim() : "");
  const place = text("PlaceName");
  const street = text("Address");
  const neighbourhood = text("Neighborhood") || text("District");
  const city = text("MetroArea") || text("City");
  const region = text("Region");
  const postalCode = text("Postal").slice(0, 12);
  const country = text("CntryName") || (text("CountryCode") === "IND" ? "India" : text("CountryCode"));
  const parts = [place, street, neighbourhood, city, region, postalCode, country];
  const formatted = parts.filter((part, index) => part.length > 0 && parts.indexOf(part) === index).join(", ");
  if (formatted.length === 0) return null;
  const point = record.location && typeof record.location === "object" ? (record.location as Record<string, unknown>) : {};
  const latitude = typeof point.y === "number" && Number.isFinite(point.y) ? point.y : fallback.latitude;
  const longitude = typeof point.x === "number" && Number.isFinite(point.x) ? point.x : fallback.longitude;
  return {
    formattedAddress: formatted,
    latitude,
    longitude,
    accuracyMeters: fallback.accuracyMeters,
    placeId: null,
    house: "",
    street,
    locality: neighbourhood || city,
    landmark: place,
    postalCode,
    provider: "arcgis",
  };
}

export function createGoogleGeocoder(options: {
  apiKey: string;
  timeoutMs: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}): Geocoder {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = new Map<string, CacheEntry>();
  return {
    async reverse(latitude, longitude, signal) {
      const key = `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
      const cached = cache.get(key);
      if (cached && cached.value && now() - cached.storedAt < 60_000) return cached.value;
      const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
      url.searchParams.set("latlng", `${latitude},${longitude}`);
      url.searchParams.set("key", options.apiKey);
      const timeout = AbortSignal.timeout(options.timeoutMs);
      const linked = AbortSignal.any([signal, timeout]);
      try {
        const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: linked });
        if (response.status === 429) throw new GeocodeError("provider", "The address service is rate limiting requests.");
        if (!response.ok) throw new GeocodeError("provider", "The address service did not return an address.");
        const address = parseGoogleGeocode((await response.json()) as unknown, {
          latitude,
          longitude,
          accuracyMeters: null,
        });
        if (address) cache.set(key, { value: address, storedAt: now() });
        return address;
      } catch (error) {
        if (error instanceof GeocodeError) throw error;
        if (timeout.aborted || signal.aborted) throw new GeocodeError("timeout", "The address service timed out.");
        throw new GeocodeError("provider", "The address service could not be reached.");
      }
    },
  };
}

export function parseGoogleGeocode(
  value: unknown,
  fallback: { latitude: number; longitude: number; accuracyMeters: number | null },
): NormalizedAddress | null {
  if (!value || typeof value !== "object") return null;
  const body = value as { status?: unknown; results?: unknown };
  if (body.status === "ZERO_RESULTS") return null;
  if (body.status === "OVER_QUERY_LIMIT" || body.status === "OVER_DAILY_LIMIT") {
    throw new GeocodeError("provider", "The daily geocoding limit has been reached.");
  }
  if (body.status !== "OK" || !Array.isArray(body.results) || body.results.length === 0) {
    throw new GeocodeError("provider", "The address service did not return an address.");
  }
  const result = body.results[0] as { formatted_address?: unknown; place_id?: unknown; address_components?: unknown };
  const formatted = typeof result.formatted_address === "string" ? result.formatted_address.trim() : "";
  if (formatted.length === 0) return null;
  const components = Array.isArray(result.address_components) ? result.address_components : [];
  const part = (...types: string[]): string => {
    for (const type of types) {
      const found = components.find((component) => {
        if (!component || typeof component !== "object") return false;
        const row = component as { types?: unknown; long_name?: unknown };
        return Array.isArray(row.types) && row.types.includes(type) && typeof row.long_name === "string" && row.long_name.trim().length > 0;
      }) as { long_name: string } | undefined;
      if (found) return found.long_name.trim();
    }
    return "";
  };
  return {
    formattedAddress: formatted,
    latitude: fallback.latitude,
    longitude: fallback.longitude,
    accuracyMeters: fallback.accuracyMeters,
    placeId: typeof result.place_id === "string" ? result.place_id.slice(0, 64) : null,
    house: part("street_number"),
    street: part("route"),
    locality: part("sublocality_level_1", "sublocality", "neighborhood", "locality"),
    landmark: part("premise", "establishment", "point_of_interest"),
    postalCode: part("postal_code").slice(0, 12),
    provider: "google",
  };
}

export function parseNominatimPayload(
  value: unknown,
  fallback: { latitude: number; longitude: number; accuracyMeters: number | null },
): NormalizedAddress | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.error === "string") return null;
  const details = record.address && typeof record.address === "object" ? (record.address as Record<string, unknown>) : {};
  const text = (key: string): string => (typeof details[key] === "string" ? details[key].trim() : "");
  const house = text("house_number");
  const street = text("road") || text("pedestrian") || text("residential");
  const city = text("city") || text("town") || text("village");
  const locality = text("suburb") || text("neighbourhood") || text("quarter") || text("city_district") || city;
  const postalCode = text("postcode").slice(0, 12);
  const country = text("country");
  const parts = [house, street, locality, city, postalCode, country];
  const composed = parts.filter((part, index) => part.length > 0 && parts.indexOf(part) === index).join(", ");
  const displayName = typeof record.display_name === "string" ? record.display_name.trim() : "";
  const formatted = composed.length > 0 ? composed : displayName;
  if (formatted.length === 0) return null;
  const latitude = typeof record.lat === "string" ? Number(record.lat) : fallback.latitude;
  const longitude = typeof record.lon === "string" ? Number(record.lon) : fallback.longitude;
  return {
    formattedAddress: formatted,
    latitude: Number.isFinite(latitude) ? latitude : fallback.latitude,
    longitude: Number.isFinite(longitude) ? longitude : fallback.longitude,
    accuracyMeters: fallback.accuracyMeters,
    placeId: record.place_id == null ? null : String(record.place_id).slice(0, 64),
    house,
    street,
    locality,
    landmark: "",
    postalCode,
    provider: "nominatim",
  };
}
