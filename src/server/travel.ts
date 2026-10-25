export async function driveMinutes(
  origin: { lat: number; lon: number },
  destination: { lat: number; lon: number },
  apiKey: string,
  timeoutMs: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<number | null> {
  if (apiKey.trim().length === 0) return null;
  const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  url.searchParams.set("origins", `${origin.lat},${origin.lon}`);
  url.searchParams.set("destinations", `${destination.lat},${destination.lon}`);
  url.searchParams.set("mode", "driving");
  url.searchParams.set("key", apiKey);
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.any([signal, timeout]) });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    return readMinutes(payload);
  } catch {
    return null;
  }
}

function readMinutes(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const rows = (payload as Record<string, unknown>).rows;
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || typeof row !== "object") return null;
  const elements = (row as Record<string, unknown>).elements;
  const element = Array.isArray(elements) ? elements[0] : null;
  if (!element || typeof element !== "object") return null;
  const record = element as Record<string, unknown>;
  if (record.status !== "OK") return null;
  const duration = record.duration;
  if (!duration || typeof duration !== "object") return null;
  const seconds = (duration as Record<string, unknown>).value;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  return Math.max(1, Math.round(seconds / 60));
}
