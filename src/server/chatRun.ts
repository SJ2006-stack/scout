import { cityById, cityFromPincode } from "../shared/cities.ts";
import type { ChatEvent } from "../shared/chatEvents.ts";
import { parseChatIntent } from "../shared/chatIntent.ts";
import { dedupeListings, sortListings, withinBudget, withinDates, type Listing } from "../shared/event.ts";
import { dateRange, isTimeZone, type DatePhrase } from "../shared/when.ts";
import type { ChatMemory } from "./chatMemory.ts";
import { ChatMemoryStore } from "./chatMemory.ts";
import type { ListingCache } from "./listingCache.ts";
import { converseWithHaiku } from "./haikuChat.ts";
import { eventTools } from "./tools/index.ts";
import { driveMinutes } from "./travel.ts";

const CARD_LIMIT = 24;
const TRAVEL_LIMIT = 8;

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
};

export async function runChat(turn: ChatTurn, emit: (event: ChatEvent) => void): Promise<void> {
  if (turn.anthropicApiKey.trim().length > 0) {
    const spoke = await converseWithHaiku(turn, emit);
    if (spoke) return;
    if (turn.signal.aborted) {
      emit({ type: "done", count: 0 });
      return;
    }
  }
  const previous = turn.memory.get(turn.sessionId);
  const intent = parseChatIntent(turn.text);
  const pincodeCity = cityFromPincode(turn.pincode);
  const unsupportedPincode = turn.pincode.length === 6 && pincodeCity == null && intent.city == null;
  if (intent.namedUnsupportedPlace || unsupportedPincode) {
    emit({
      type: "question",
      message: "I can look in Bengaluru, Mumbai, Delhi, or Hyderabad.",
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
    timezone: isTimeZone(turn.timezone) ? turn.timezone : previous.timezone,
    lines: previous.lines,
  };
  turn.memory.save(turn.sessionId, next);
  if (!city) {
    emit({
      type: "question",
      message: "Which city should I look in? Bengaluru, Mumbai, Delhi, or Hyderabad.",
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
      if (!listedInWindow(listing, range)) continue;
      if (!withinBudget(listing, next.budget)) continue;
      collected.push(listing);
    }
  }
  const shown = dedupeListings(sortListings(collected)).slice(0, CARD_LIMIT);
  await attachTravel(shown, next, turn);
  for (const listing of shown) emit({ type: "card", listing });
  if (shown.length === 0) {
    emit({ type: "status", message: `Nothing matched in ${city.name} for that window.` });
  } else {
    emit({ type: "status", message: `${shown.length} listing${shown.length === 1 ? "" : "s"} in ${city.name}.` });
  }
  emit({ type: "done", count: shown.length });
}

function listedInWindow(listing: Listing, range: { startMs: number; endMs: number }): boolean {
  if (listing.platform === "BookMyShow" && listing.start == null) return true;
  return withinDates(listing, range);
}

function statusLine(city: string, date: DatePhrase, budget: number | null): string {
  const window = date === "today" ? "today" : date === "weekend" ? "this weekend" : "the next seven days";
  const price = budget == null ? "" : ` under ₹${budget}`;
  return `Looking in ${city} for ${window}${price}.`;
}

async function attachTravel(listings: Listing[], memory: ChatMemory, turn: ChatTurn): Promise<void> {
  if (memory.lat == null || memory.lon == null || turn.mapsApiKey.trim().length === 0) return;
  let used = 0;
  for (const listing of listings) {
    if (used >= TRAVEL_LIMIT) return;
    if (listing.lat == null || listing.lon == null) continue;
    used += 1;
    const minutes = await driveMinutes(
      { lat: memory.lat, lon: memory.lon },
      { lat: listing.lat, lon: listing.lon },
      turn.mapsApiKey,
      turn.timeoutMs,
      turn.signal,
      turn.fetchImpl,
    );
    if (minutes != null) listing.driveMinutes = minutes;
  }
}
