import { cityById, cityFromPincode } from "../shared/cities.ts";
import type { ChatEvent } from "../shared/chatEvents.ts";
import { parseChatIntent } from "../shared/chatIntent.ts";
import { dedupeListings, listingInWindow, sortListings, withinBudget, type Listing } from "../shared/event.ts";
import { dateRange, isTimeZone, windowLabel, type WhenWindow } from "../shared/when.ts";
import type { AgentId } from "../shared/hosts.ts";
import type { ChatMemory } from "./chatMemory.ts";
import { ChatMemoryStore } from "./chatMemory.ts";
import type { ListingCache } from "./listingCache.ts";
import type { CommerceHub } from "./commerce/hub.ts";
import type { ShopRun } from "./browser/shelf.ts";
import { converseWithHaiku } from "./haikuChat.ts";
import { converseSpecialist, fallbackSpecialist, type SpecialistAgent } from "./specialistChat.ts";
import { eventTools } from "./tools/index.ts";
import { driveMinutes } from "./travel.ts";
import type { ProfileStore } from "./profile/profileStore.ts";
import type { WatchStore } from "./watch/watchStore.ts";
import { withEmoji } from "../shared/emoji.ts";

const CARD_LIMIT = 24;
const TRAVEL_LIMIT = 8;
const DRIVE_PARALLEL = 4;

export type ChatTurn = {
  sessionId: string;
  text: string;
  timezone: string;
  pincode: string;
  lat: number | null;
  lon: number | null;
  timeoutMs: number;
  signal: AbortSignal;
  now: () => number;
  memory: ChatMemoryStore;
  cache: ListingCache;
  fetchImpl: typeof fetch;
  mapsApiKey: string;
  pomeradoApiKey: string;
  anthropicApiKey: string;
  readPage?: (url: string) => Promise<{ ok: true; html: string } | { ok: false; message: string }>;
  registerPage?: (url: string, title: string) => Promise<{ pay: { url: string } | null; message: string } | null>;
  agent?: AgentId;
  commerce?: CommerceHub;
  compareShop?: (query: string, signal: AbortSignal, onStatus: (message: string) => void) => Promise<ShopRun>;
  profile?: ProfileStore;
  watches?: WatchStore;
};

export async function runChat(turn: ChatTurn, emit: (event: ChatEvent) => void): Promise<void> {
  const agent = turn.agent ?? "event";
  if (agent !== "event") {
    await runSpecialist(agent, turn, emit);
    return;
  }
  if (turn.anthropicApiKey.trim().length > 0) {
    const spoke = await converseWithHaiku(turn, emit);
    if (spoke) return;
    if (turn.signal.aborted) {
      emit({ type: "done", count: 0 });
      return;
    }
  }
  const previous = turn.memory.get(turn.sessionId);
  const zone = isTimeZone(turn.timezone) ? turn.timezone : isTimeZone(previous.timezone) ? previous.timezone : "Asia/Kolkata";
  const intent = parseChatIntent(turn.text, turn.now(), zone);
  const pincodeCity = cityFromPincode(turn.pincode);
  const unsupportedPincode = turn.pincode.length === 6 && pincodeCity == null && intent.city == null;
  if (intent.namedUnsupportedPlace || unsupportedPincode) {
    emit({
      type: "question",
      message: withEmoji("I can look in Bengaluru, Mumbai, Delhi, or Hyderabad."),
    });
    emit({ type: "done", count: 0 });
    return;
  }
  const city = intent.city ?? pincodeCity ?? cityById(previous.cityId);
  const next: ChatMemory = {
    cityId: city?.id ?? null,
    lat: turn.lat ?? previous.lat,
    lon: turn.lon ?? previous.lon,
    budget: intent.budget.kind === "set" ? intent.budget.amount : intent.budget.kind === "clear" ? null : previous.budget,
    date: intent.date ?? previous.date,
    kind: intent.kind.kind === "set" ? intent.kind.value : intent.kind.kind === "clear" ? null : previous.kind,
    timezone: zone,
    lines: previous.lines,
    found: previous.found ?? [],
  };
  turn.memory.save(turn.sessionId, next);
  if (!city) {
    emit({
      type: "question",
      message: withEmoji("Which city should I look in? Bengaluru, Mumbai, Delhi, or Hyderabad."),
    });
    emit({ type: "done", count: 0 });
    return;
  }

  const range = dateRange(next.date, turn.now(), next.timezone);
  emit({ type: "status", message: statusLine(city.name, next.date, next.budget) });
  const loaded = await Promise.all(eventTools.map((tool) => tool.load({
    city,
    range,
    kind: next.kind,
    timezone: next.timezone,
    retrievedAt: new Date(turn.now()).toISOString(),
    timeoutMs: turn.timeoutMs,
    signal: turn.signal,
    fetchImpl: turn.fetchImpl,
    cache: turn.cache,
    pomeradoApiKey: turn.pomeradoApiKey,
    readPage: turn.readPage,
  })));
  const collected: Listing[] = [];
  for (const result of loaded) {
    emit({ type: "source", source: result.name, ok: result.ok, message: result.message });
    for (const warning of result.warnings) {
      emit({ type: "source", source: result.name, ok: false, message: warning });
    }
    if (!result.ok) continue;
    for (const listing of result.listings) {
      if (next.kind && listing.kind !== next.kind) continue;
      if (!listingInWindow(listing, range)) continue;
      if (!withinBudget(listing, next.budget)) continue;
      collected.push(listing);
    }
  }
  const shown = dedupeListings(sortListings(collected)).slice(0, CARD_LIMIT);
  for (const listing of shown) emit({ type: "card", listing: { ...listing } });
  if (shown.length === 0) {
    emit({ type: "status", message: `Nothing matched in ${city.name} for that window.` });
  } else {
    emit({ type: "status", message: `${shown.length} listing${shown.length === 1 ? "" : "s"} in ${city.name}.` });
  }
  await attachTravel(shown, next, turn, (url, minutes) => emit({ type: "drive", url, minutes }));
  emit({ type: "done", count: shown.length });
}

function statusLine(city: string, date: WhenWindow, budget: number | null): string {
  const price = budget == null ? "" : ` under ₹${budget}`;
  return `Looking in ${city} for ${windowLabel(date)}${price}.`;
}

async function runSpecialist(agent: SpecialistAgent, turn: ChatTurn, emit: (event: ChatEvent) => void): Promise<void> {
  if (turn.anthropicApiKey.trim().length > 0) {
    const spoke = await converseSpecialist(agent, turn, emit);
    if (spoke) return;
    if (turn.signal.aborted) {
      emit({ type: "done", count: 0 });
      return;
    }
  }
  await fallbackSpecialist(agent, turn, emit);
}

async function attachTravel(
  listings: Listing[],
  memory: ChatMemory,
  turn: ChatTurn,
  onDrive: (url: string, minutes: number) => void,
): Promise<void> {
  if (memory.lat == null || memory.lon == null || turn.mapsApiKey.trim().length === 0) return;
  const targets = listings.filter((listing) => listing.lat != null && listing.lon != null).slice(0, TRAVEL_LIMIT);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const listing = targets[cursor];
      cursor += 1;
      if (!listing || listing.lat == null || listing.lon == null || memory.lat == null || memory.lon == null) continue;
      const minutes = await driveMinutes(
        { lat: memory.lat, lon: memory.lon },
        { lat: listing.lat, lon: listing.lon },
        turn.mapsApiKey,
        turn.timeoutMs,
        turn.signal,
        turn.fetchImpl,
      );
      if (minutes == null) continue;
      listing.driveMinutes = minutes;
      onDrive(listing.url, minutes);
    }
  }
  const workers = Math.min(DRIVE_PARALLEL, targets.length);
  if (workers === 0) return;
  await Promise.all(Array.from({ length: workers }, () => worker()));
}
