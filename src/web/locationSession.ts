export const LOCATION_SESSION_KEY = "scout-location-session";
const REUSE_MS = 5 * 60 * 1000;

export type LocationSession = {
  lat: number | null;
  lon: number | null;
  pincode: string;
  confirmed: boolean;
  accuracyMeters: number | null;
  detectedAt: number | null;
};

export type LocationFix = {
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  detectedAt: number;
};

export type LocationFailure = "denied" | "unavailable" | "timeout" | "unsupported" | "insecure";

export type LocationResult = { ok: true; fix: LocationFix; reused: boolean } | { ok: false; failure: LocationFailure };

export type PositionReader = {
  getCurrentPosition: (
    success: (position: { coords: { latitude: number; longitude: number; accuracy: number } }) => void,
    error: (error: { code: number }) => void,
    options?: { enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number },
  ) => void;
};

export function parseLocationSession(raw: string | null): LocationSession | null {
  if (raw == null || raw.trim().length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const lat = readCoordinate(record.lat, -90, 90);
  const lon = readCoordinate(record.lon, -180, 180);
  if (lat === "bad" || lon === "bad") return null;
  if (record.pincode != null && record.pincode !== "" && (typeof record.pincode !== "string" || !/^\d{6}$/.test(record.pincode))) {
    return null;
  }
  const pincode = typeof record.pincode === "string" && /^\d{6}$/.test(record.pincode) ? record.pincode : "";
  if (lat == null && lon == null && pincode.length === 0) return null;
  const point = lat != null && lon != null;
  const accuracyMeters = typeof record.accuracyMeters === "number" && Number.isFinite(record.accuracyMeters) ? record.accuracyMeters : null;
  const detectedAt = typeof record.detectedAt === "number" && Number.isFinite(record.detectedAt) ? record.detectedAt : null;
  return {
    lat,
    lon,
    pincode,
    confirmed: record.confirmed === true && (pincode.length > 0 || point),
    accuracyMeters,
    detectedAt,
  };
}

export function serializeLocationSession(session: LocationSession): string {
  return JSON.stringify({
    lat: session.lat,
    lon: session.lon,
    pincode: /^\d{6}$/.test(session.pincode) ? session.pincode : "",
    confirmed: session.confirmed,
    accuracyMeters: session.accuracyMeters,
    detectedAt: session.detectedAt,
  });
}

export function requestBrowserLocation(options?: {
  fresh?: boolean;
  recent?: LocationFix | null;
  now?: number;
}): Promise<LocationResult> {
  const now = options?.now ?? Date.now();
  const recent = options?.recent ?? null;
  if (!options?.fresh && recent && now - recent.detectedAt >= 0 && now - recent.detectedAt <= REUSE_MS) {
    return Promise.resolve({ ok: true, fix: recent, reused: true });
  }
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return Promise.resolve({ ok: false, failure: "insecure" });
  }
  const source = typeof navigator === "undefined" ? null : navigator.geolocation;
  if (pendingLocation && !options?.fresh) return pendingLocation;
  pendingLocation = readCurrentPosition(source, now, { fresh: options?.fresh === true }).finally(() => {
    pendingLocation = null;
  });
  return pendingLocation;
}

let pendingLocation: Promise<LocationResult> | null = null;

export function readCurrentPosition(
  source: PositionReader | null,
  now: number,
  options?: { fresh?: boolean },
): Promise<LocationResult> {
  if (!source) return Promise.resolve({ ok: false, failure: "unsupported" });
  const fresh = options?.fresh === true;
  return new Promise((resolve) => {
    source.getCurrentPosition(
      (position) => {
        const accuracy = position.coords.accuracy;
        resolve({
          ok: true,
          reused: false,
          fix: {
            lat: position.coords.latitude,
            lon: position.coords.longitude,
            accuracyMeters: Number.isFinite(accuracy) ? accuracy : null,
            detectedAt: now,
          },
        });
      },
      (error) => resolve({ ok: false, failure: failureCode(error.code) }),
      { enableHighAccuracy: fresh, timeout: fresh ? 20_000 : 12_000, maximumAge: fresh ? 0 : 60_000 },
    );
  });
}

function failureCode(code: number): LocationFailure {
  if (code === 1) return "denied";
  if (code === 2) return "unavailable";
  if (code === 3) return "timeout";
  return "unavailable";
}

function readCoordinate(value: unknown, min: number, max: number): number | null | "bad" {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return "bad";
  return value;
}
