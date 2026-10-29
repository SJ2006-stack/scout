import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { AddressBook } from "./addressBook.ts";
import type { ApiDeps } from "./api.ts";
import { PlaywrightBrowserDriver } from "./browser/playwrightDriver.ts";
import { browserConfigFromEnv } from "./browser/policy.ts";
import { BrowserStore } from "./browser/store.ts";
import { BrowserWorker } from "./browser/worker.ts";
import { PriceCache } from "./cache.ts";
import { ChatMemoryStore } from "./chatMemory.ts";
import { createCommerceHub } from "./commerce/hub.ts";
import { ListingCache } from "./listingCache.ts";
import { createArcGisGeocoder, createGoogleGeocoder } from "./geocode.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

export function appRoot(): string {
  return root;
}

export function loadLocalEnv(): void {
  const envPath = join(root, ".env");
  if (existsSync(envPath)) loadEnvFile(envPath);
}

export function createDeps(): ApiDeps {
  const timeoutMs = Number(process.env.GEOCODER_TIMEOUT_MS ?? 8_000);
  return {
    liveConnectors: [],
    cache: new PriceCache(Number(process.env.CACHE_TTL_MS ?? 60_000), Date.now),
    timeoutMs: Number(process.env.CONNECTOR_TIMEOUT_MS ?? 8_000),
    now: Date.now,
    demoStepMs: Number(process.env.DEMO_STEP_MS ?? 400),
    geocoder: googleGeocoder(timeoutMs),
    addressBook: new AddressBook(Date.now),
    chatMemory: new ChatMemoryStore(),
    listingCache: new ListingCache(Number(process.env.CACHE_TTL_MS ?? 60_000), Date.now),
    mapsApiKey: process.env.GOOGLE_MAPS_API_KEY?.trim() ?? "",
    pomeradoApiKey: process.env.POMERADO_API_KEY?.trim() ?? "",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() ?? "",
    commerce: createCommerceHub(Date.now),
    browser: createBrowserWorker(),
  };
}

function createBrowserWorker(): BrowserWorker | undefined {
  const config = browserConfigFromEnv(process.env, root);
  if (!config.enabled) return undefined;
  return new BrowserWorker({
    driver: new PlaywrightBrowserDriver(config.operationTimeoutMs),
    store: new BrowserStore(join(config.stateDir, "sessions.json")),
    allowHosts: config.allowHosts,
    operationTimeoutMs: config.operationTimeoutMs,
    sessionTtlMs: config.sessionTtlMs,
    maxSessions: config.maxSessions,
    now: Date.now,
  });
}

function googleGeocoder(timeoutMs: number) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim() ?? "";
  if (apiKey.length > 0) return createGoogleGeocoder({ apiKey, timeoutMs });
  return createArcGisGeocoder({ timeoutMs });
}
