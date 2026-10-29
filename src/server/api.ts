import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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
import { routeBrowser } from "./browser/routes.ts";
import type { BrowserWorker } from "./browser/worker.ts";
import { CommerceHub, createCommerceHub, type CommerceRequest } from "./commerce/hub.ts";
import { PairTickets } from "./pairTickets.ts";
import { sessionId } from "./session.ts";
import { writeEvents } from "./sseWriter.ts";

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
    await writeEvents(response, (emit, signal) =>
      runChat(
        {
          sessionId: owner,
          text: parsed.text,
          timezone: parsed.timezone,
          pincode: parsed.pincode,
          lat: parsed.lat,
          lon: parsed.lon,
          timeoutMs: deps.timeoutMs,
          signal,
          now: deps.now,
          memory: deps.chatMemory ?? new ChatMemoryStore(),
          cache: deps.listingCache ?? new ListingCache(60_000, deps.now),
          fetchImpl: deps.fetchImpl ?? fetch,
          mapsApiKey: deps.mapsApiKey ?? "",
          pomeradoApiKey: deps.pomeradoApiKey ?? "",
          anthropicApiKey: deps.anthropicApiKey ?? "",
        },
        emit,
      ),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/commerce") {
    await commerceTurn(request, response, deps);
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
} | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "Send a message." };
  const body = value as Record<string, unknown>;
  if (typeof body.text !== "string" || body.text.trim().length === 0) return { ok: false, error: "Tell Scout what you want to find." };
  const timezone = typeof body.timezone === "string" && body.timezone.trim().length > 0 ? body.timezone.trim() : "Asia/Kolkata";
  const pincode = typeof body.pincode === "string" && /^\d{6}$/.test(body.pincode) ? body.pincode : "";
  const lat = readOptionalCoord(body.lat, -90, 90);
  const lon = readOptionalCoord(body.lon, -180, 180);
  if (lat === "bad" || lon === "bad") return { ok: false, error: "Coordinates are not a valid point." };
  return { ok: true, text: body.text.trim(), timezone, pincode, lat, lon };
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
  const hub = deps.commerce ?? createCommerceHub(deps.now);
  deps.commerce = hub;
  const commerceRequest: CommerceRequest = parsed.action === "confirm"
    ? { sessionId: owner, agent: parsed.agent, action: "confirm", quoteId: parsed.quoteId }
    : { sessionId: owner, agent: parsed.agent, action: "message", text: parsed.text };
  await writeEvents(response, async (emit) => {
    for (const event of hub.handle(commerceRequest)) emit(event);
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
