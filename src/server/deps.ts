import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { AddressBook } from "./addressBook.ts";
import type { ApiDeps } from "./api.ts";
import { idleMsFromEnv, limitsFromEnv } from "./browser/budget.ts";
import { PlaywrightBrowserDriver } from "./browser/playwrightDriver.ts";
import { browserConfigFromEnv, browserRoleError } from "./browser/policy.ts";
import { browserRuntimeFromEnv } from "./browser/runtimeTicket.ts";
import { ProfileVault } from "./browser/profileVault.ts";
import { BrowserStore } from "./browser/store.ts";
import { BrowserWorker } from "./browser/worker.ts";
import { PriceCache } from "./cache.ts";
import { ChatMemoryStore } from "./chatMemory.ts";
import { DeskStore } from "./desk.ts";
import { createCommerceHub } from "./commerce/hub.ts";
import { ListingCache, listingCacheTtlMs } from "./listingCache.ts";
import { agentMailFromEnv } from "./auth/agentMail.ts";
import { distributionFromEnv } from "./invites/appRelease.ts";
import { EmailAuth } from "./auth/emailAuth.ts";
import { scoutDbPath, UserDirectory } from "./db/userDirectory.ts";
import { createArcGisGeocoder, createGoogleGeocoder } from "./geocode.ts";
import { fcmFromEnv, FcmSender } from "./notify/fcm.ts";
import { InboxStore } from "./notify/inbox.ts";
import { Notifier } from "./notify/notifier.ts";
import { ProfileStore } from "./profile/profileStore.ts";
import { eventTools } from "./tools/index.ts";
import { WatchRunner } from "./watch/watchRunner.ts";
import { WatchStore } from "./watch/watchStore.ts";
import { bolnaFromEnv } from "./voice/bolna.ts";
import { LiveRelay } from "./voice/liveRelay.ts";

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
  const directory = new UserDirectory(scoutDbPath(root));
  const auth = new EmailAuth(directory, agentMailFromEnv(process.env), Date.now);
  const dbPath = scoutDbPath(root);
  const listingCache = new ListingCache(listingCacheTtlMs(process.env.LISTING_CACHE_TTL_MS), Date.now);
  const connectorTimeoutMs = Number(process.env.CONNECTOR_TIMEOUT_MS ?? 8_000);
  const inbox = new InboxStore(dbPath);
  const fcm = fcmFromEnv(process.env);
  if (!fcm) console.error("Push notifications stay off until FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY are set.");
  const notifier = new Notifier(inbox, fcm ? new FcmSender(fcm, fetch, Date.now) : null, Date.now);
  const watches = new WatchStore(dbPath);
  const watchRunner = new WatchRunner({
    store: watches,
    notifier,
    tools: eventTools,
    cache: listingCache,
    fetchImpl: fetch,
    pomeradoApiKey: process.env.POMERADO_API_KEY?.trim() ?? "",
    timeoutMs: connectorTimeoutMs,
    now: Date.now,
  });
  const bolna = bolnaFromEnv(process.env);
  if (!bolna) console.error("Bolna voice calls stay off until BOLNA_API_KEY and BOLNA_LLM_KEY are set.");
  return {
    bolna,
    liveRelay: new LiveRelay(),
    profile: new ProfileStore(dbPath),
    watches,
    watchRunner,
    inbox,
    liveConnectors: [],
    cache: new PriceCache(Number(process.env.CACHE_TTL_MS ?? 60_000), Date.now),
    timeoutMs: connectorTimeoutMs,
    now: Date.now,
    demoStepMs: Number(process.env.DEMO_STEP_MS ?? 400),
    geocoder: googleGeocoder(timeoutMs),
    addressBook: new AddressBook(Date.now),
    chatMemory: new ChatMemoryStore(dbPath),
    listingCache,
    mapsApiKey: process.env.GOOGLE_MAPS_API_KEY?.trim() ?? "",
    pomeradoApiKey: process.env.POMERADO_API_KEY?.trim() ?? "",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() ?? "",
    sarvamApiKey: process.env.SARVAM_API_KEY?.trim() ?? "",
    commerce: createCommerceHub(Date.now),
    browser: createBrowserWorker(directory),
    browserRuntime: browserRuntimeFromEnv(process.env),
    desk: new DeskStore(join(root, ".data", "desk", "conversations.json")),
    directory,
    auth,
    invite: distributionFromEnv(process.env),
  };
}

export function useLocalBrowserWorker(env: NodeJS.ProcessEnv, enabled: boolean): boolean {
  if (env.SCOUT_ROLE === "browser") return enabled;
  if ((env.BROWSER_RUNTIME_URL?.trim() ?? "").length > 0) return false;
  return enabled;
}

function createBrowserWorker(directory: UserDirectory): BrowserWorker | undefined {
  const config = browserConfigFromEnv(process.env, root);
  const roleError = browserRoleError(config);
  if (roleError) throw new Error(roleError);
  if (!useLocalBrowserWorker(process.env, config.enabled)) return undefined;
  const vault = config.profileKey
    ? new ProfileVault(join(config.stateDir, "profiles"), config.profileKey, config.profileTtlMs, Date.now)
    : null;
  if (config.profileKey == null) console.error("Browser profiles stay off until BROWSER_PROFILE_KEY is 64 hex characters.");
  const idleMs = idleMsFromEnv(process.env);
  return new BrowserWorker({
    driver: new PlaywrightBrowserDriver(config.operationTimeoutMs),
    store: new BrowserStore(join(config.stateDir, "sessions.json"), directory),
    vault,
    canShowWindow: false,
    operationTimeoutMs: config.operationTimeoutMs,
    sessionTtlMs: config.sessionTtlMs,
    maxSessions: config.maxSessions,
    maxLanes: config.maxLanes,
    allowedHosts: config.allowedHosts,
    directory,
    now: Date.now,
    limits: limitsFromEnv(process.env),
    rssMb: () => process.memoryUsage().rss / (1024 * 1024),
    ...(idleMs === undefined ? {} : { idleMs }),
  });
}

function googleGeocoder(timeoutMs: number) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim() ?? "";
  if (apiKey.length > 0) return createGoogleGeocoder({ apiKey, timeoutMs });
  return createArcGisGeocoder({ timeoutMs });
}
