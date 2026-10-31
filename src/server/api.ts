import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAddressDraft } from "../shared/address.ts";
import type { DeliveryArea } from "../shared/offer.ts";
import { AddressBook } from "./addressBook.ts";
import type { PriceCache } from "./cache.ts";
import type { Connector } from "./connectors/types.ts";
import { ChatMemoryStore } from "./chatMemory.ts";
import { runChat } from "./chatRun.ts";
import { streamDemo } from "./demo/script.ts";
import { ListingCache } from "./listingCache.ts";
import { GeocodeError, type Geocoder } from "./geocode.ts";
import { RateLimit } from "./rateLimit.ts";
import { runSearch } from "./search.ts";
import { applyCors } from "./cors.ts";
import { healthPayload } from "./health.ts";
import { browserRuntimeMaySkipSignIn, routeBrowser } from "./browser/routes.ts";
import type { BrowserRuntimeConfig } from "./browser/runtimeTicket.ts";
import type { BrowserWorker } from "./browser/worker.ts";
import type { EmailAuth } from "./auth/emailAuth.ts";
import { CommerceHub, createCommerceHub, type CommerceRequest } from "./commerce/hub.ts";
import { isAgentId } from "../shared/hosts.ts";
import { isLiveShopQuery, parsePayRequest, runListingPay, runShopSearch } from "./shopRun.ts";
import { listingPlatform } from "./events/pageText.ts";
import { DeskStore } from "./desk.ts";
import type { UserDirectory } from "./db/userDirectory.ts";
import { PairTickets } from "./pairTickets.ts";
import { indianMobile, preferredName } from "../shared/onboarding.ts";
import { ocrResponse } from "./ocr.ts";
import { OCR_BYTES } from "../shared/ocr.ts";
import { voiceResponse } from "./voice/sarvam.ts";
import type { AppInvite } from "./invites/appRelease.ts";
import { clearSessionCookie, currentSessionId, sessionId, setSessionCookie } from "./session.ts";
import { writeEvents } from "./sseWriter.ts";
import { isAssistantRoute, routeAssistant } from "./assistantRoutes.ts";
import type { InboxStore } from "./notify/inbox.ts";
import type { ProfileStore } from "./profile/profileStore.ts";
import type { WatchRunner } from "./watch/watchRunner.ts";
import type { WatchStore } from "./watch/watchStore.ts";
import type { ChatTurn } from "./chatRun.ts";
import type { AgentId } from "../shared/hosts.ts";
import type { BolnaConfig } from "./voice/bolna.ts";
import { isBolnaLlmRoute, routeBolnaLlm, routeBolnaSession, routeVoiceLive, type TurnBuilder } from "./voice/bolnaRoutes.ts";
import type { LiveRelay } from "./voice/liveRelay.ts";

export type ApiDeps = {
  liveConnectors: Connector[];
  cache: PriceCache;
  timeoutMs: number;
  now: () => number;
  demoStepMs: number;
  geocoder?: Geocoder;
  addressBook?: AddressBook;
  geocodeRate?: RateLimit;
  chatMemory?: ChatMemoryStore;
  listingCache?: ListingCache;
  fetchImpl?: typeof fetch;
  mapsApiKey?: string;
  pomeradoApiKey?: string;
  anthropicApiKey?: string;
  commerce?: CommerceHub;
  pairTickets?: PairTickets;
  browser?: BrowserWorker;
  browserRuntime?: BrowserRuntimeConfig;
  desk?: DeskStore;
  directory?: UserDirectory;
  auth?: EmailAuth;
  invite?: AppInvite;
  sarvamApiKey?: string;
  profile?: ProfileStore;
  watches?: WatchStore;
  watchRunner?: WatchRunner;
  inbox?: InboxStore;
  bolna?: BolnaConfig | null;
  liveRelay?: LiveRelay;
};

export function createApiServer(deps: ApiDeps): Server {
  const resolved: ApiDeps = {
    ...deps,
    addressBook: deps.addressBook ?? new AddressBook(deps.now),
    geocodeRate: deps.geocodeRate ?? new RateLimit(1_000, deps.now),
    chatMemory: deps.chatMemory ?? new ChatMemoryStore(),
    listingCache: deps.listingCache ?? new ListingCache(60_000, deps.now),
    fetchImpl: deps.fetchImpl ?? fetch,
    mapsApiKey: deps.mapsApiKey ?? "",
    pomeradoApiKey: deps.pomeradoApiKey ?? "",
    anthropicApiKey: deps.anthropicApiKey ?? "",
    commerce: deps.commerce ?? createCommerceHub(deps.now),
  };
  return createServer((request, response) => {
    void handleApi(request, response, resolved);
  });
}

export async function handleApi(request: IncomingMessage, response: ServerResponse, deps: ApiDeps): Promise<void> {
  if (!deps.commerce) deps.commerce = createCommerceHub(deps.now);
  try {
    await routeApi(request, response, deps);
  } catch (error) {
    console.error(error);
    if (!response.headersSent && !response.writableEnded) {
      sendJson(response, 500, { error: "Scout could not complete that request." });
    } else if (!response.writableEnded) {
      response.end();
    }
  }
}

async function routeApi(request: IncomingMessage, response: ServerResponse, deps: ApiDeps): Promise<void> {
  if (applyCors(request, response)) return;
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, healthPayload());
    return;
  }
  if (url.pathname.startsWith("/api/auth/")) {
    await routeSignIn(request, response, url, deps);
    return;
  }
  if (isBolnaLlmRoute(url.pathname)) {
    await routeBolnaLlm(request, response, url, deps, voiceTurn(deps));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/invite") {
    await routeInvite(request, response, deps);
    return;
  }
  if (deps.auth && !browserRuntimeMaySkipSignIn(request, url.pathname, deps.browser) && !deps.auth.account(currentSessionId(request))) {
    sendJson(response, 401, { error: "Sign in with the code from your email." });
    return;
  }
  if (url.pathname === "/api/onboarding/phone" || url.pathname === "/api/onboarding/name") {
    await routeOnboarding(request, response, url, deps);
    return;
  }
  if (url.pathname === "/api/voice/stt" || url.pathname === "/api/voice/tts") {
    const raw = await readBytes(request, 4_000_000);
    if (!raw.ok) {
      sendJson(response, 400, { error: raw.error });
      return;
    }
    const result = await voiceResponse(
      request.method ?? "GET",
      url.pathname,
      raw.bytes,
      request.headers["content-type"] ?? "",
      deps,
    );
    if (result) sendJson(response, result.status, result.body);
    return;
  }
  if (url.pathname === "/api/ocr") {
    const raw = await readBytes(request, OCR_BYTES);
    if (!raw.ok) {
      sendJson(response, 400, { error: raw.error });
      return;
    }
    const result = await ocrResponse(request.method ?? "GET", raw.bytes, request.headers["content-type"] ?? "", deps);
    sendJson(response, result.status, result.body);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/pair") {
    const ticket = currentPairTicket(deps);
    const secondsLeft = Math.max(0, Math.ceil((ticket.expiresAt - deps.now()) / 1000));
    sendJson(response, 200, { ...ticket, secondsLeft });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/demo") {
    await drain(request);
    await writeEvents(response, (emit, signal) => streamDemo(emit, deps.demoStepMs, signal));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/chat") {
    const body = await readJson(request);
    if (!body.ok) {
      sendJson(response, 400, { error: body.error });
      return;
    }
    const parsed = parseChatRequest(body.value);
    if (!parsed.ok) {
      sendJson(response, 400, { error: parsed.error });
      return;
    }
    const owner = sessionId(request, response);
    deps.directory?.touch(owner, deps.now());
    await writeEvents(response, (emit, signal) =>
      runChat(
        chatTurn(deps, owner, { ...parsed, agent: parsed.agent ?? "event" }, signal),
        emit,
      ),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/voice/bolna/session") {
    await routeBolnaSession(request, response, sessionId(request, response), deps);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/voice/live") {
    await routeVoiceLive(request, response, sessionId(request, response), deps);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/commerce") {
    await commerceTurn(request, response, deps);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/pay") {
    await payTurn(request, response, deps);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/search") {
    const body = await readJson(request);
    if (!body.ok) {
      sendJson(response, 400, { error: body.error });
      return;
    }
    const parsed = parseLiveRequest(body.value);
    if (!parsed.ok) {
      sendJson(response, 400, { error: parsed.error });
      return;
    }
    await writeEvents(response, (emit, signal) =>
      runSearch(
        {
          text: parsed.text,
          area: parsed.area,
          connectors: deps.liveConnectors,
          cache: deps.cache,
          timeoutMs: deps.timeoutMs,
          signal,
          now: deps.now,
        },
        emit,
      ),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/location/reverse-geocode") {
    await reverseGeocode(request, response, deps);
    return;
  }
  if (url.pathname === "/api/desk" && (request.method === "GET" || request.method === "PUT")) {
    await deskRoute(request, response, deps);
    return;
  }
  if (isAssistantRoute(url.pathname)) {
    await routeAssistant(request, response, url, sessionId(request, response), deps);
    return;
  }
  if (url.pathname === "/api/browser" || url.pathname.startsWith("/api/browser/")) {
    await routeBrowser(request, response, url, deps);
    return;
  }
  const addressId = url.pathname.match(/^\/api\/addresses\/([a-f0-9]{16})$/);
  if (url.pathname === "/api/addresses" || addressId) {
    await savedAddresses(request, response, deps, addressId?.[1] ?? null);
    return;
  }
  sendJson(response, 404, { error: "Not found" });
}

type TurnInput = { text: string; agent: AgentId; timezone: string; pincode: string; lat: number | null; lon: number | null };

function chatTurn(deps: ApiDeps, owner: string, input: TurnInput, signal: AbortSignal): ChatTurn {
  if (!deps.commerce) deps.commerce = createCommerceHub(deps.now);
  const browser = deps.browser;
  return {
    sessionId: owner,
    text: input.text,
    timezone: input.timezone,
    pincode: input.pincode,
    lat: input.lat,
    lon: input.lon,
    timeoutMs: deps.timeoutMs,
    signal,
    now: deps.now,
    memory: deps.chatMemory ?? new ChatMemoryStore(),
    cache: deps.listingCache ?? new ListingCache(60_000, deps.now),
    fetchImpl: deps.fetchImpl ?? fetch,
    mapsApiKey: deps.mapsApiKey ?? "",
    pomeradoApiKey: deps.pomeradoApiKey ?? "",
    anthropicApiKey: deps.anthropicApiKey ?? "",
    agent: input.agent,
    commerce: deps.commerce,
    ...(deps.profile ? { profile: deps.profile } : {}),
    ...(deps.watches ? { watches: deps.watches } : {}),
    compareShop: browser ? (query, shopSignal, onStatus) => browser.compareShop(query, shopSignal, owner, onStatus) : undefined,
    readPage: browser ? (url) => browser.readHtml(url, signal, owner) : undefined,
    registerPage: browser
      ? (url, title) => {
          const merchant = listingPlatform(url);
          if (!merchant) return Promise.resolve(null);
          return browser.collectPay(url, title, merchant, signal, owner);
        }
      : undefined,
  };
}

function voiceTurn(deps: ApiDeps): TurnBuilder {
  return (userId, agent, text, signal) =>
    chatTurn(deps, userId, { text, agent, timezone: "Asia/Kolkata", pincode: "", lat: null, lon: null }, signal);
}

async function routeInvite(request: IncomingMessage, response: ServerResponse, deps: ApiDeps): Promise<void> {
  const invite = deps.invite;
  if (!invite?.configured) {
    await drain(request);
    sendJson(response, 503, { error: "The install link is not connected." });
    return;
  }
  const body = await readJson(request, "Send an email address.");
  if (!body.ok) {
    sendJson(response, 400, { error: body.error });
    return;
  }
  const record = body.value && typeof body.value === "object" ? body.value as Record<string, unknown> : {};
  const email = typeof record.email === "string" ? record.email : "";
  const result = await invite.send(email);
  if (!result.ok) {
    sendJson(response, result.status, { error: result.error });
    return;
  }
  sendJson(response, 200, { sent: true });
}

async function routeSignIn(request: IncomingMessage, response: ServerResponse, url: URL, deps: ApiDeps): Promise<void> {
  const auth = deps.auth;
  if (!auth) {
    sendJson(response, 503, { error: "Email sign-in is not connected." });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    const account = auth.account(currentSessionId(request));
    sendJson(response, 200, account
      ? { signedIn: true, email: account.email, userId: account.id, phone: account.phone, name: account.name }
      : { signedIn: false });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/auth/signout") {
    await drain(request);
    clearSessionCookie(response);
    sendJson(response, 200, { signedIn: false });
    return;
  }
  if (request.method !== "POST") {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  const body = await readJson(request);
  if (!body.ok) {
    sendJson(response, 400, { error: body.error });
    return;
  }
  const record = body.value && typeof body.value === "object" ? body.value as Record<string, unknown> : {};
  const email = typeof record.email === "string" ? record.email : "";
  if (url.pathname === "/api/auth/email") {
    const result = await auth.requestCode(email);
    if (!result.ok) {
      sendJson(response, result.status, { error: result.error });
      return;
    }
    sendJson(response, 200, { sent: true });
    return;
  }
  if (url.pathname === "/api/auth/verify") {
    const code = typeof record.code === "string" ? record.code : "";
    const result = auth.verify(email, code);
    if (!result.ok || result.kind !== "session") {
      sendJson(response, result.ok ? 400 : result.status, { error: result.ok ? "Enter the 6-digit code from your email." : result.error });
      return;
    }
    setSessionCookie(response, result.userId);
    sendJson(response, 200, { signedIn: true, email: result.email, userId: result.userId });
    return;
  }
  sendJson(response, 404, { error: "Not found" });
}

async function routeOnboarding(request: IncomingMessage, response: ServerResponse, url: URL, deps: ApiDeps): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  const auth = deps.auth;
  const directory = deps.directory;
  if (!auth || !directory) {
    sendJson(response, 503, { error: "Sign-in is not connected." });
    return;
  }
  const account = auth.account(currentSessionId(request));
  if (!account) {
    sendJson(response, 401, { error: "Sign in with the code from your email." });
    return;
  }
  const body = await readJson(request);
  if (!body.ok) {
    sendJson(response, 400, { error: body.error });
    return;
  }
  const record = body.value && typeof body.value === "object" ? body.value as Record<string, unknown> : {};
  if (url.pathname === "/api/onboarding/phone") {
    const phone = indianMobile(typeof record.phone === "string" ? record.phone : "");
    if (!phone) {
      sendJson(response, 400, { error: "Enter an Indian mobile number." });
      return;
    }
    if (!directory.setPhone(account.id, phone, deps.now())) {
      sendJson(response, 400, { error: "Sign in with Gmail before adding a phone number." });
      return;
    }
    sendJson(response, 200, { phone });
    return;
  }
  if (account.phone == null) {
    sendJson(response, 400, { error: "Add an Indian mobile number first." });
    return;
  }
  const name = preferredName(typeof record.name === "string" ? record.name : "");
  if (!name) {
    sendJson(response, 400, { error: "Enter the name Scout should use." });
    return;
  }
  if (!directory.setName(account.id, name, deps.now())) {
    sendJson(response, 400, { error: "Add an Indian mobile number first." });
    return;
  }
  sendJson(response, 200, { name });
}

async function deskRoute(request: IncomingMessage, response: ServerResponse, deps: ApiDeps): Promise<void> {
  const desk = deps.desk ?? new DeskStore(join(tmpdir(), `scout-desk-${randomBytes(8).toString("hex")}.json`));
  if (!deps.desk) deps.desk = desk;
  if (request.method === "GET") {
    sendJson(response, 200, { conversations: desk.read() });
    return;
  }
  const body = await readDeskBody(request);
  if (!body.ok) {
    sendJson(response, 400, { error: body.error });
    return;
  }
  const saved = desk.write(body.value);
  if (saved == null) {
    sendJson(response, 400, { error: "Send the conversation list." });
    return;
  }
  sendJson(response, 200, { conversations: saved });
}

async function readDeskBody(request: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2_000_000) return { ok: false, error: "That desk is too large." };
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) return { ok: false, error: "Send the conversation list." };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "Request was not valid JSON." };
  }
}

function currentPairTicket(deps: ApiDeps) {
  if (!deps.pairTickets) deps.pairTickets = new PairTickets(deps.now);
  return deps.pairTickets.current();
}

function parseChatRequest(value: unknown): {
  ok: true;
  text: string;
  timezone: string;
  pincode: string;
  lat: number | null;
  lon: number | null;
  agent: "main" | "event" | "travel" | "food" | "shop" | "home" | "appointments";
} | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "Send a message." };
  const body = value as Record<string, unknown>;
  if (typeof body.text !== "string" || body.text.trim().length === 0) return { ok: false, error: "Tell Scout what you want to find." };
  if (body.agent != null && !isAgentId(body.agent)) return { ok: false, error: "That scout is not available." };
  const timezone = typeof body.timezone === "string" && body.timezone.trim().length > 0 ? body.timezone.trim() : "Asia/Kolkata";
  const pincode = typeof body.pincode === "string" && /^\d{6}$/.test(body.pincode) ? body.pincode : "";
  const lat = readOptionalCoord(body.lat, -90, 90);
  const lon = readOptionalCoord(body.lon, -180, 180);
  if (lat === "bad" || lon === "bad") return { ok: false, error: "Coordinates are not a valid point." };
  return { ok: true, text: body.text.trim(), timezone, pincode, lat, lon, agent: isAgentId(body.agent) ? body.agent : "event" };
}

function readOptionalCoord(value: unknown, min: number, max: number): number | null | "bad" {
  if (value == null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return "bad";
  return value;
}

function parseLiveRequest(value: unknown): { ok: true; text: string; area: DeliveryArea } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "Send a grocery request and a confirmed area." };
  const body = value as Record<string, unknown>;
  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    return { ok: false, error: "Tell Scout what to find." };
  }
  const area = parseArea(body.area);
  if (!area.ok) return area;
  return { ok: true, text: body.text.trim(), area: area.area };
}

function parseArea(value: unknown): { ok: true; area: DeliveryArea } | { ok: false; error: string } {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "Confirm the delivery area before searching." };
  }
  const area = value as Record<string, unknown>;
  if (area.confirmed !== true || area.approximate !== true) {
    return { ok: false, error: "Confirm the approximate delivery area before searching." };
  }
  if (area.pincode != null && area.pincode !== "" && (typeof area.pincode !== "string" || !/^\d{6}$/.test(area.pincode))) {
    return { ok: false, error: "Enter a 6-digit pincode." };
  }
  const pincode = typeof area.pincode === "string" && /^\d{6}$/.test(area.pincode) ? area.pincode : "";
  const lat = readCoordinate(area.lat, -90, 90);
  const lon = readCoordinate(area.lon, -180, 180);
  if (lat === "bad" || lon === "bad") return { ok: false, error: "Coordinates are not a valid approximate point." };
  const point = lat != null && lon != null;
  if (pincode.length === 0 && !point) {
    return { ok: false, error: "Allow location, or enter a 6-digit pincode." };
  }
  if (typeof area.label !== "string") {
    return { ok: false, error: "Keep the area label approximate." };
  }
  const label = area.label.toLowerCase();
  if (pincode.length > 0 && !label.includes(`pincode ${pincode}`)) {
    return { ok: false, error: "Keep the area label approximate and include the pincode." };
  }
  if (pincode.length === 0 && point && !label.includes(`around ${lat.toFixed(2)}, ${lon.toFixed(2)}`)) {
    return { ok: false, error: "Keep the area label to the approximate point." };
  }
  return {
    ok: true,
    area: {
      pincode,
      lat,
      lon,
      label: area.label,
      confirmed: true,
      approximate: true,
    },
  };
}

function readCoordinate(value: unknown, min: number, max: number): number | null | "bad" {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return "bad";
  return value;
}

async function commerceTurn(request: IncomingMessage, response: ServerResponse, deps: ApiDeps): Promise<void> {
  const body = await readJson(request, "Send a shop, food, or appointment request.");
  if (!body.ok) {
    sendJson(response, 400, { error: body.error });
    return;
  }
  const parsed = parseCommerceRequest(body.value);
  if (!parsed.ok) {
    sendJson(response, 400, { error: parsed.error });
    return;
  }
  const owner = sessionId(request, response);
  deps.directory?.touch(owner, deps.now());
  const hub = deps.commerce ?? createCommerceHub(deps.now);
  deps.commerce = hub;
  const commerceRequest: CommerceRequest = parsed.action === "confirm"
    ? { sessionId: owner, agent: parsed.agent, action: "confirm", quoteId: parsed.quoteId }
    : { sessionId: owner, agent: parsed.agent, action: "message", text: parsed.text };
  await writeEvents(response, async (emit, signal) => {
    if (commerceRequest.action === "message" && commerceRequest.agent === "shop" && deps.browser && isLiveShopQuery(commerceRequest.text)) {
      await runShopSearch(deps.browser, commerceRequest.text, emit, signal, owner);
      return;
    }
    for (const event of hub.handle(commerceRequest)) emit(event);
  });
}

async function payTurn(request: IncomingMessage, response: ServerResponse, deps: ApiDeps): Promise<void> {
  const body = await readJson(request, "Send the listing to book.");
  if (!body.ok) {
    sendJson(response, 400, { error: body.error });
    return;
  }
  const parsed = parsePayRequest(body.value);
  if (!parsed.ok) {
    sendJson(response, 400, { error: parsed.error });
    return;
  }
  if (!deps.browser) {
    sendJson(response, 503, { error: "Browser worker is not enabled on this server." });
    return;
  }
  const worker = deps.browser;
  const owner = sessionId(request, response);
  await writeEvents(response, async (emit, signal) => {
    await runListingPay(worker, parsed.url, parsed.title, emit, signal, owner);
  });
}

function parseCommerceRequest(value: unknown): {
  ok: true;
  agent: "shop" | "food" | "appointments";
  action: "message";
  text: string;
} | {
  ok: true;
  agent: "shop" | "food" | "appointments";
  action: "confirm";
  quoteId: string;
} | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "Send a shop, food, or appointment request." };
  const body = value as Record<string, unknown>;
  if (body.agent === "event") return { ok: false, error: "Event Scout uses chat." };
  if (body.agent !== "shop" && body.agent !== "food" && body.agent !== "appointments") {
    return { ok: false, error: "That specialist is not connected." };
  }
  const agent = body.agent;
  if (body.action === "confirm") {
    if (typeof body.quoteId !== "string" || body.quoteId.trim().length === 0) {
      return { ok: false, error: "Confirm the review that is on screen." };
    }
    return { ok: true, agent, action: "confirm", quoteId: body.quoteId.trim() };
  }
  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    return { ok: false, error: "Tell Scout what you need." };
  }
  return { ok: true, agent, action: "message", text: body.text.trim() };
}

async function drain(request: IncomingMessage): Promise<void> {
  for await (const chunk of request) void chunk;
}

async function readBytes(
  request: IncomingMessage,
  limit: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) return { ok: false, error: "Request is too large." };
    chunks.push(buffer);
  }
  return { ok: true, bytes: new Uint8Array(Buffer.concat(chunks)) };
}

async function readJson(
  request: IncomingMessage,
  emptyError = "Send a grocery request and a confirmed area.",
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 20_000) return { ok: false, error: "Request is too large." };
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) return { ok: false, error: emptyError };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "Request was not valid JSON." };
  }
}

async function reverseGeocode(request: IncomingMessage, response: ServerResponse, deps: ApiDeps): Promise<void> {
  const body = await readJson(request);
  if (!body.ok) {
    sendJson(response, 400, { error: body.error });
    return;
  }
  const point = readPoint(body.value);
  if (!point.ok) {
    sendJson(response, 400, { error: point.error });
    return;
  }
  if (!deps.geocoder) {
    sendJson(response, 503, { error: "Address lookup is not configured." });
    return;
  }
  const rate = deps.geocodeRate ?? new RateLimit(1_000, deps.now);
  if (!rate.allow(request.socket.remoteAddress ?? "unknown")) {
    sendJson(response, 429, { error: "Wait a moment before looking up another address." });
    return;
  }
  try {
    const found = await deps.geocoder.reverse(point.latitude, point.longitude, AbortSignal.timeout(deps.timeoutMs));
    if (!found) {
      sendJson(response, 404, { error: "No address was found for that point." });
      return;
    }
    sendJson(response, 200, { ...found, accuracyMeters: point.accuracyMeters });
  } catch (error) {
    if (error instanceof GeocodeError) {
      sendJson(response, error.code === "timeout" ? 504 : 502, { error: error.message });
      return;
    }
    sendJson(response, 502, { error: "The address service could not be reached." });
  }
}

async function savedAddresses(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ApiDeps,
  id: string | null,
): Promise<void> {
  const book = deps.addressBook ?? new AddressBook(deps.now);
  const owner = sessionId(request, response);
  deps.directory?.touch(owner, deps.now());
  if (request.method === "GET" && id == null) {
    sendJson(response, 200, { addresses: book.list(owner) });
    return;
  }
  if (request.method === "POST" && id == null) {
    const body = await readJson(request);
    if (!body.ok) {
      sendJson(response, 400, { error: body.error });
      return;
    }
    const draft = parseAddressDraft(body.value);
    if (!draft.ok) {
      sendJson(response, 400, { error: draft.error });
      return;
    }
    sendJson(response, 201, { address: book.create(owner, draft.draft) });
    return;
  }
  if (request.method === "DELETE" && id) {
    if (!book.delete(owner, id)) {
      sendJson(response, 404, { error: "That address was not found." });
      return;
    }
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.method === "PATCH" && id) {
    const body = await readJson(request);
    if (!body.ok) {
      sendJson(response, 400, { error: body.error });
      return;
    }
    const patch = body.value;
    if (patch && typeof patch === "object" && (patch as Record<string, unknown>).isDefault === true && Object.keys(patch as object).length === 1) {
      const address = book.makeDefault(owner, id);
      if (!address) {
        sendJson(response, 404, { error: "That address was not found." });
        return;
      }
      sendJson(response, 200, { address });
      return;
    }
    const draft = parseAddressDraft(patch);
    if (!draft.ok) {
      sendJson(response, 400, { error: draft.error });
      return;
    }
    const address = book.update(owner, id, draft.draft);
    if (!address) {
      sendJson(response, 404, { error: "That address was not found." });
      return;
    }
    sendJson(response, 200, { address });
    return;
  }
  sendJson(response, 404, { error: "Not found" });
}

function readPoint(value: unknown): { ok: true; latitude: number; longitude: number; accuracyMeters: number | null } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "Send a latitude and longitude." };
  const body = value as Record<string, unknown>;
  if (typeof body.latitude !== "number" || typeof body.longitude !== "number") {
    return { ok: false, error: "Send a latitude and longitude." };
  }
  if (!Number.isFinite(body.latitude) || body.latitude < -90 || body.latitude > 90) {
    return { ok: false, error: "Latitude is not a valid point." };
  }
  if (!Number.isFinite(body.longitude) || body.longitude < -180 || body.longitude > 180) {
    return { ok: false, error: "Longitude is not a valid point." };
  }
  if (body.accuracyMeters == null) return { ok: true, latitude: body.latitude, longitude: body.longitude, accuracyMeters: null };
  if (typeof body.accuracyMeters !== "number" || !Number.isFinite(body.accuracyMeters) || body.accuracyMeters < 0) {
    return { ok: false, error: "Accuracy is not a usable distance." };
  }
  return { ok: true, latitude: body.latitude, longitude: body.longitude, accuracyMeters: body.accuracyMeters };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
