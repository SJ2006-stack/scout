import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { SearchEvent } from "../src/shared/events.ts";
import type { DeliveryArea, ProductOffer } from "../src/shared/offer.ts";
import { createApiServer, type ApiDeps } from "../src/server/api.ts";
import { PriceCache } from "../src/server/cache.ts";

export function sampleOffer(overrides: Partial<ProductOffer> = {}): ProductOffer {
  return {
    id: "store:amul-taaza-1l",
    name: "Amul Taaza Homogenised Toned Milk",
    brand: "Amul",
    quantity: { amount: 1000, unit: "ml", raw: "1 litre" },
    quantityLabel: "1 L",
    price: 66,
    mrp: 99,
    discountAmount: null,
    available: true,
    platform: "Store",
    productUrl: "https://example.com/store/amul-taaza-1l",
    retrievedAt: "2026-01-01T00:00:00.000Z",
    source: "store",
    provenance: "live",
    ...overrides,
  };
}

export function confirmedArea(overrides: Partial<DeliveryArea> = {}): DeliveryArea {
  return {
    pincode: "110001",
    lat: null,
    lon: null,
    label: "Searching near pincode 110001",
    confirmed: true,
    approximate: true,
    ...overrides,
  };
}

export function parseSse<T = SearchEvent>(text: string): T[] {
  const events: T[] = [];
  for (const frame of text.split("\n\n")) {
    const line = frame.split("\n").find((entry) => entry.startsWith("data:"));
    if (!line) continue;
    events.push(JSON.parse(line.slice(5).trim()) as T);
  }
  return events;
}

export async function withApi(
  overrides: Partial<ApiDeps>,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const deps: ApiDeps = {
    liveConnectors: [],
    cache: new PriceCache(60_000, Date.now),
    timeoutMs: 8_000,
    now: Date.now,
    demoStepMs: 0,
    ...overrides,
  };
  const server: Server = createApiServer(deps);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}
