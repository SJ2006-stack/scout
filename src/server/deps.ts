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
import { CheckoutLedger } from "./browser/checkoutLedger.ts";
import { OtpBroker } from "./browser/otpBroker.ts";
import { allowBrowserRequest, checkNavigationUrl } from "./browser/policy.ts";
import { SessionVault } from "./browser/sessionVault.ts";
import { TaskRunner } from "./browser/taskRunner.ts";
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
    ...createBrowserRuntime(directory, inbox, notifier),
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

function createBrowserRuntime(directory: UserDirectory, inbox: InboxStore, notifier: Notifier): { browser?: BrowserWorker; scoutTasks?: TaskRunner; sessionVault?: SessionVault | null } {
  const config = browserConfigFromEnv(process.env, root);
  const roleError = browserRoleError(config);
  if (roleError) throw new Error(roleError);
  if (!useLocalBrowserWorker(process.env, config.enabled)) return {};
  const vault = config.profileKey
    ? new SessionVault(join(config.stateDir, "sites"), config.profileKey, config.profileTtlMs, Date.now)
    : null;
  if (config.profileKey == null) console.error("Browser profiles stay off until BROWSER_PROFILE_KEY is 64 hex characters.");
  const idleMs = idleMsFromEnv(process.env);
  const driver = new PlaywrightBrowserDriver(config.operationTimeoutMs);
  const scoutTasks = new TaskRunner({
    driver,
    vault,
    broker: new OtpBroker(Date.now),
    ledger: new CheckoutLedger(join(config.stateDir, "checkouts.json"), Date.now),
    account: (userId) => {
      const account = directory.account(userId);
      return account ? { email: account.email, phone: account.phone, name: account.name } : null;
    },
    devices: (userId) => inbox.devices(userId).filter((device) => device.platform === "android").map((device) => device.deviceId),
    allow: (url) => allowBrowserRequest(url, config.allowedHosts),
    checkUrl: (url) => checkNavigationUrl(url, config.allowedHosts),
    now: Date.now,
    notify: (userId, title, body) => {
      void notifier.notify(userId, { agent: "shop", kind: "browser-task", title, body, url: null }).catch(() => undefined);
    },
    onPhoneVerified: (userId) => directory.markPhoneVerified(userId, Date.now()),
  });
  return { browser: createBrowserWorker(directory, vault, driver, config, idleMs), scoutTasks, sessionVault: vault };
}

function createBrowserWorker(
  directory: UserDirectory,
  vault: SessionVault | null,
  driver: PlaywrightBrowserDriver,
  config: ReturnType<typeof browserConfigFromEnv>,
  idleMs: number | undefined,
): BrowserWorker {
  return new BrowserWorker({
    driver,
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
