import { cityById, cityFromPincode } from "../shared/cities.ts";
import type { ChatEvent } from "../shared/chatEvents.ts";
import { parseChatIntent } from "../shared/chatIntent.ts";
import { dedupeListings, listingInWindow, sortListings, withinBudget, type Listing } from "../shared/event.ts";
import { dateRange, isTimeZone, windowLabel, type WhenWindow } from "../shared/when.ts";
import type { AgentId } from "../shared/hosts.ts";
import type { PhoneAutomation } from "../shared/deviceActions.ts";
import type { StoreBill } from "../shared/cartQuote.ts";
import type { ScreenReading } from "../shared/screenReading.ts";
import type { ChatMemory } from "./chatMemory.ts";
import { ChatMemoryStore } from "./chatMemory.ts";
import type { ListingCache } from "./listingCache.ts";
import type { CommerceHub } from "./commerce/hub.ts";
import type { ScoutTaskView } from "../shared/scoutTask.ts";
import type { BasketRun, ShopRun } from "./browser/shelf.ts";
import { converseEvent } from "./eventChat.ts";
import { converseSpecialist, fallbackSpecialist, type SpecialistAgent } from "./specialistChat.ts";
import { eventTools } from "./tools/index.ts";
import { driveMinutes } from "./travel.ts";
import type { ProfileStore } from "./profile/profileStore.ts";
import type { WatchStore } from "./watch/watchStore.ts";
import { withEmoji } from "../shared/emoji.ts";
import type { BusResult, ErrandAnswers } from "../shared/errands.ts";
import type { BusTrip } from "./browser/buses.ts";
import { runAnsweredErrands, runMainScout } from "./mainScout.ts";
import { answersMessage, pendingForms } from "./questionBack.ts";
import { screenSpecialist } from "./screenChat.ts";

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
  sarvamApiKey: string;
  readPage?: (url: string) => Promise<{ ok: true; html: string } | { ok: false; message: string }>;
  /** Reads a listings page for an event source without trying to sign in on it. */
  readListings?: (url: string) => Promise<{ ok: true; html: string } | { ok: false; message: string }>;
  registerPage?: (url: string, title: string) => Promise<{ pay: { url: string } | null; message: string } | null>;
  agent?: AgentId;
  commerce?: CommerceHub;
  compareShop?: (query: string, signal: AbortSignal, onStatus: (message: string) => void) => Promise<ShopRun>;
  compareBasket?: (queries: readonly string[], signal: AbortSignal, onStatus: (message: string) => void) => Promise<BasketRun>;
  /** Cart bills the phone read for this user, oldest first, which tune the total estimates. */
  cartBills?: () => StoreBill[];
  /** Starts a live cart task on one store and resolves when it needs the user or stops. */
  prepareCart?: (
    store: string,
    item: string,
    quantity: number,
    onStart: (taskId: string) => void,
    onStatus: (message: string) => void,
  ) => Promise<{ ok: true; task: ScoutTaskView } | { ok: false; error: string }>;
  profile?: ProfileStore;
  watches?: WatchStore;
  /** What the Scout Android app reports it can automate; absent outside the app. */
  phone?: PhoneAutomation;
  /** Receives the reply so far while Sarvam streams; an empty string means earlier text was superseded. */
  onSpeech?: (text: string) => void;
  /** Main Scout splits a message into errands with Claude Haiku; empty means it only chats. */
  anthropicApiKey?: string;
  /** Their answers to Main Scout's question form. */
  answers?: ErrandAnswers;
  compareBuses?: (trip: BusTrip, signal: AbortSignal) => Promise<{ result: BusResult | null; failure: string | null }>;
  /** A screenshot the user chose to ask about. Only `text` is their request; this is context. */
  screen?: ScreenReading;
};

export async function runChat(turn: ChatTurn, emit: (event: ChatEvent) => void): Promise<void> {
  if (turn.answers) {
    await resumeForm(turn, turn.answers, emit);
    return;
  }
  if (turn.screen) {
    await runSpecialist(screenSpecialist(turn.agent), turn, emit);
    return;
  }
  const agent = turn.agent ?? "event";
  if (agent === "main" && (await runMainScout(turn, emit, listEvents))) return;
  await runAgent(agent, turn, emit);
}

/** Answers to a form go back to whoever asked: Main Scout's errands, or the scout that called ask_user. */
async function resumeForm(turn: ChatTurn, answers: ErrandAnswers, emit: (event: ChatEvent) => void): Promise<void> {
  const form = pendingForms.take(turn.sessionId, answers.formId);
  if (!form) {
    emit({ type: "question", message: withEmoji("Those questions have expired. Send your request again and I'll ask once more.") });
    emit({ type: "done", count: 0 });
    return;
  }
  switch (form.kind) {
    case "errands":
      await runAnsweredErrands(form.plan, answers.values, { ...turn, answers: undefined }, emit, listEvents);
      return;
    case "ask":
      await runAgent(form.agent, { ...turn, agent: form.agent, text: answersMessage(form.questions, answers.values), answers: undefined }, emit);
      return;
    default: {
      const neverForm: never = form;
      return neverForm;
    }
  }
}

async function runAgent(agent: AgentId, turn: ChatTurn, emit: (event: ChatEvent) => void): Promise<void> {
  if (agent !== "event") {
    await runSpecialist(agent, turn, emit);
    return;
  }
  if (turn.sarvamApiKey.trim().length > 0) {
    const spoke = await converseEvent(turn, emit);
    if (spoke) return;
    if (turn.signal.aborted) {
      emit({ type: "done", count: 0 });
      return;
    }
  }
  const found = await listEvents(turn, emit);
  emit({ type: "question", message: withEmoji(found.message) });
  await found.drives();
  emit({ type: "done", count: found.count });
}

const noDrives = async (): Promise<void> => undefined;

/** Reads Luma, District, and BookMyShow for the city and window in their words, without the chat model. drives adds drive times to the cards. */
export async function listEvents(turn: ChatTurn, emit: (event: ChatEvent) => void): Promise<{ message: string; count: number; drives: () => Promise<void> }> {
  const previous = turn.memory.get(turn.sessionId);
  const zone = isTimeZone(turn.timezone) ? turn.timezone : isTimeZone(previous.timezone) ? previous.timezone : "Asia/Kolkata";
  const intent = parseChatIntent(turn.text, turn.now(), zone);
  const pincodeCity = cityFromPincode(turn.pincode);
  const unsupportedPincode = turn.pincode.length === 6 && pincodeCity == null && intent.city == null;
  if (intent.namedUnsupportedPlace || unsupportedPincode) return { message: "I can look in Bengaluru, Mumbai, Delhi, or Hyderabad.", count: 0, drives: noDrives };
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
  if (!city) return { message: "Which city should I look in? Bengaluru, Mumbai, Delhi, or Hyderabad.", count: 0, drives: noDrives };

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
    readPage: turn.readListings ?? turn.readPage,
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
  const when = windowLabel(next.date);
  const drives = () => attachTravel(shown, next, turn, (url, minutes) => emit({ type: "drive", url, minutes }));
  if (shown.length === 0) {
    emit({ type: "status", message: `Nothing matched in ${city.name} for that window.` });
    return { message: `I checked Luma, District, and BookMyShow for ${when} in ${city.name}. Nothing listed there matches.`, count: 0, drives };
  }
  emit({ type: "status", message: `${shown.length} listing${shown.length === 1 ? "" : "s"} in ${city.name}.` });
  const names = shown.slice(0, 3).map((listing) => listing.title).join(", ");
  return { message: `${shown.length} in ${city.name} for ${when}: ${names}.`, count: shown.length, drives };
}

function statusLine(city: string, date: WhenWindow, budget: number | null): string {
  const price = budget == null ? "" : ` under ₹${budget}`;
  return `Looking in ${city} for ${windowLabel(date)}${price}.`;
}

async function runSpecialist(agent: SpecialistAgent, turn: ChatTurn, emit: (event: ChatEvent) => void): Promise<void> {
  if (turn.sarvamApiKey.trim().length > 0) {
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
