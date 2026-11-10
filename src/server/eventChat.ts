import { cityById, type City } from "../shared/cities.ts";
import type { ChatEvent } from "../shared/chatEvents.ts";
import { dedupeListings, listingInWindow, sortListings, withinBudget, type EventKind, type Listing } from "../shared/event.ts";
import { calendarDate, dateRange, isCalendarDay, isSingleDay, isTimeZone, whenInMessage, windowLabel, type DateRange, type WhenWindow } from "../shared/when.ts";
import type { ChatMemory } from "./chatMemory.ts";
import { askedUser, askPicks, askReply, blockText, contentBlocks, transcript } from "./toolLoop.ts";
import type { ChatTurn } from "./chatRun.ts";
import { SIGN_IN_CODE_MESSAGE } from "./browser/signIn.ts";
import { bookMyShowTool } from "./tools/bookmyshow.ts";
import { districtTool } from "./tools/district.ts";
import { lumaTool } from "./tools/luma.ts";
import type { EventTool, ToolName } from "./tools/types.ts";
import { postSarvam, type ChatMessage } from "./sarvamChat.ts";
import { scoutPurpose } from "./scoutPrompt.ts";
import { withEmoji } from "../shared/emoji.ts";
import { browseFollowUp, matchFound, readablePage, type FoundEvent } from "./events/pageText.ts";
import { assistantPrompt, assistantTools, isAssistantTool, runAssistantTool, type AssistantContext, type AssistantToolName } from "./assistantTools.ts";
import { asksForOtherResults } from "./otherResults.ts";

const CARD_LIMIT = 24;
const SHOW_LIMIT = 3;
const MORE_LIMIT = 21;
const MORE_FOR_MODEL = 8;
const ROUND_LIMIT = 4;

const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    city: { type: "string", enum: ["bengaluru", "mumbai", "delhi", "hyderabad"] },
    when: { type: "string", description: "today, tomorrow, weekend, week, or a calendar day YYYY-MM-DD" },
    kind: { type: "string", enum: ["movie", "concert", "comedy", "theatre", "workshop", "sports", "other", "any"] },
    budgetRupees: { type: "integer" },
  },
  required: ["city", "when", "kind", "budgetRupees"],
} as const;

const WHEN_RULE = "when is today, tomorrow, weekend, week, or the calendar day they mean as YYYY-MM-DD. A named date, day of the month, or weekday becomes that YYYY-MM-DD. Keep a day they already named until they change it. Do not refuse a specific date, and do not say search is limited to today, tomorrow, a weekend, or a week. Do not use week for one day.";

const TOOLS = [
  {
    name: "search_luma",
    description: `Search Luma events for one city and date window. Sign-in uses the account Gmail or phone. ${WHEN_RULE}`,
    input_schema: INPUT_SCHEMA,
  },
  {
    name: "search_district",
    description: `Search District events and movies for one city and date window. Sign-in uses the account Gmail or phone. ${WHEN_RULE}`,
    input_schema: INPUT_SCHEMA,
  },
  {
    name: "search_bookmyshow",
    description: `Search BookMyShow movies and events for one city and date window. Sign-in uses the account Gmail or phone. ${WHEN_RULE}`,
    input_schema: INPUT_SCHEMA,
  },
  {
    name: "open_event",
    description: "Open one event in the browser worker and read the full page: description, time, place, and host. Use this when they ask for more detail about one event. Pass the event title from the last search.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        url: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "register_event",
    description: "Register or RSVP with the browser worker, using the Gmail and phone already saved on this account. Use this when they ask to register, RSVP, book, or use their email. Do not tell them to open the page themselves.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        url: { type: "string" },
      },
      required: ["title"],
    },
  },
] as const;

type ToolId = (typeof TOOLS)[number]["name"] | AssistantToolName;
type WhenWord = WhenWindow;
type KindWord = EventKind | "any";
type SearchInput = { city: City; when: WhenWord; kind: EventKind | null; budget: number | null };
type Block = Record<string, unknown>;
type ApiMessage = ChatMessage;

const FETCH_SOURCES = ["Luma", "District", "BookMyShow"] as const;

/** "Event Scout fetching from Luma, District, and BookMyShow." Names only the sources in this call. */
export function fetchingLine(sources: readonly string[]): string {
  const names = FETCH_SOURCES.filter((name) => sources.includes(name));
  if (names.length === 0) return "Event Scout fetching listings.";
  if (names.length === 1) return `Event Scout fetching from ${names[0]}.`;
  if (names.length === 2) return `Event Scout fetching from ${names[0]} and ${names[1]}.`;
  return `Event Scout fetching from ${names[0]}, ${names[1]}, and ${names[2]}.`;
}

/** The system prompt and tool list Event Scout is given. The same values are sent when the model runs. */
export function eventScoutFeed(turn: ChatTurn): { prompt: string; tools: { name: string; description: string }[] } {
  const prompt = `${instructions(turn.now(), timeZone(turn), turn.memory.get(turn.sessionId).date)} ${assistantPrompt(assistantContext(turn))}`.trim();
  const tools = modelTools(turn).flatMap((tool) => {
    const access = toolAccess(tool);
    return access ? [access] : [];
  });
  return { prompt, tools };
}

function modelTools(turn: ChatTurn): readonly Record<string, unknown>[] {
  return [...TOOLS.map((tool) => ({ ...tool })), ...assistantTools(assistantContext(turn))];
}

function toolAccess(tool: Record<string, unknown>): { name: string; description: string } | null {
  const record = tool as { name?: unknown; description?: unknown };
  if (typeof record.name !== "string" || record.name.trim().length === 0) return null;
  return { name: record.name, description: typeof record.description === "string" ? record.description : "" };
}

export async function converseEvent(turn: ChatTurn, emit: (event: ChatEvent) => void): Promise<boolean> {
  const feed = eventScoutFeed(turn);
  emit({ type: "status", message: "Message sent to Event Scout." });
  emit({ type: "brief", scout: "Event Scout", fed: true, prompt: feed.prompt, tools: feed.tools });
  const remembered = turn.history ?? turn.memory.get(turn.sessionId).lines;
  const messages = transcript(remembered, turn.text);
  const seen = new Set<string>(asksForOtherResults(turn.text) ? (turn.memory.get(turn.sessionId).found ?? []).map((item) => item.url) : []);
  const announced = new Set<string>();
  const spoken: string[] = [];
  const shown: string[] = [];
  const more: string[] = [];
  let patch: Partial<ChatMemory> = {};
  let started = false;
  for (let round = 0; round < ROUND_LIMIT; round += 1) {
    if (turn.signal.aborted) return finish(turn, spoken.join("\n\n"), patch, shown, emit, more);
    const body = await complete(turn, messages);
    if (body == null) {
      if (!started) return false;
      return finish(turn, spoken.join("\n\n"), patch, shown, emit, more);
    }
    if (body.stop_reason === "refusal") {
      return finish(turn, "I can't help with that.", patch, shown, emit, more);
    }
    const blocks = contentBlocks(body.content);
    const text = blockText(blocks);
    if (text.length > 0 && !spoken.includes(text)) spoken.push(text);
    const calls = blocks.filter(isToolUse);
    if (calls.length === 0) return finish(turn, text.length > 0 ? text : spoken.join("\n\n"), patch, shown, emit, more);
    const fetching = calls.flatMap((call) => (isSearchTool(call.name) ? [sourceName(call.name)] : []));
    if (fetching.length > 0) emit({ type: "status", message: fetchingLine(fetching) });
    started = true;
    messages.push({ role: "assistant", content: blocks });
    const gathered: Listing[] = [];
    const results = await Promise.all(calls.map(async (call) => {
      const ran = await runTool(turn, call, emit, announced);
      gathered.push(...ran.listings);
      if (ran.patch) patch = { ...patch, ...ran.patch, found: mergeFound(patch.found, ran.patch.found) };
      return ran;
    }));
    if (askedUser(calls, results)) return finish(turn, askReply(text), patch, shown, emit, more);
    const fresh = dedupeListings(sortListings(gathered)).filter((listing) => !seen.has(listing.url));
    const preview = fresh.slice(0, SHOW_LIMIT);
    const rest = fresh.slice(SHOW_LIMIT, SHOW_LIMIT + MORE_LIMIT);
    const visible = new Set(preview.map((listing) => listing.url));
    for (const listing of preview) {
      seen.add(listing.url);
      emit({ type: "card", listing });
    }
    if (rest.length > 0) {
      for (const listing of rest) seen.add(listing.url);
      emit({ type: "more", listings: rest });
      more.push(...rest.map((listing) => listing.title));
    }
    shown.push(...preview.map((listing) => listing.title));
    messages.push({
      role: "user",
      content: results.map((ran) => ({
        type: "tool_result",
        tool_use_id: ran.id,
        is_error: !ran.ok,
        content: ran.fill ? ran.fill(visible) : ran.content,
      })),
    });
  }
  return finish(turn, spoken.join("\n\n"), patch, shown, emit, more);
}

function finish(
  turn: ChatTurn,
  reply: string,
  patch: Partial<ChatMemory>,
  shown: string[],
  emit: (event: ChatEvent) => void,
  more: string[] = [],
): boolean {
  const cleaned = reply
    .split("\n")
    .filter((line) => !/^\s*(?:\[?Shown on screen in order:|\(Cards on screen:|\(Under Show more:|Mentioned in order:)|held back \d+/i.test(line))
    .join("\n")
    .trim();
  const asked = askPicks(turn.sessionId, "event", browseFollowUp(cleaned || "I checked Luma, District, and BookMyShow.", shown.length, turn.text), emit);
  const spoken = asked.length > 0 ? withEmoji(asked) : "";
  if (spoken.length > 0) emit({ type: "question", message: spoken });
  const previous = turn.memory.get(turn.sessionId);
  const titles = shown.slice(0, 6).map((title, index) => `${index + 1}. ${title}`).join("; ");
  const extra = more.slice(0, 12).join("; ");
  const remembered = `${spoken.length > 0 ? spoken : "I checked the listings."}${titles ? `\n(Cards on screen: ${titles})` : ""}${extra ? `\n(Under Show more: ${extra})` : ""}`;
  const lines = turn.history ? previous.lines : [...previous.lines, { role: "user" as const, text: turn.text }, { role: "assistant" as const, text: remembered }].slice(-12);
  turn.memory.save(turn.sessionId, { ...previous, ...patch, found: mergeFound(previous.found, patch.found), lines });
  emit({ type: "done", count: shown.length });
  return true;
}

async function complete(turn: ChatTurn, messages: ApiMessage[]): Promise<{ stop_reason?: string; content?: unknown } | null> {
  return postSarvam({
    apiKey: turn.sarvamApiKey,
    fetchImpl: turn.fetchImpl,
    signal: turn.signal,
    system: eventScoutFeed(turn).prompt,
    tools: modelTools(turn),
    messages,
  });
}

export function assistantContext(turn: ChatTurn): AssistantContext {
  return {
    userId: turn.sessionId,
    agent: turn.agent ?? "event",
    now: turn.now,
    timezone: timeZone(turn),
    ...(turn.profile ? { profile: turn.profile } : {}),
    ...(turn.vault ? { vault: turn.vault } : {}),
    ...(turn.watches ? { watches: turn.watches } : {}),
    ...(turn.phone ? { phone: turn.phone } : {}),
    ...(turn.google ? { google: turn.google, fetchImpl: turn.fetchImpl, googleRedirect: turn.googleRedirect } : {}),
  };
}

type ToolRan = {
  id: string;
  ok: boolean;
  content: string;
  listings: Listing[];
  fill?: (visible: ReadonlySet<string>) => string;
  patch?: Partial<ChatMemory>;
};

async function runTool(
  turn: ChatTurn,
  call: { id: string; name: ToolId; input: unknown },
  emit: (event: ChatEvent) => void,
  announced: Set<string>,
): Promise<ToolRan> {
  if (isAssistantTool(call.name)) {
    const ran = await runAssistantTool(assistantContext(turn), call.name, call.input, emit);
    return { id: call.id, ok: ran.ok, content: ran.content, listings: [] };
  }
  if (call.name === "open_event") return openEvent(turn, call, emit);
  if (call.name === "register_event") return registerEvent(turn, call, emit);
  const tool = toolByName(call.name);
  const zone = timeZone(turn);
  const parsed = searchInput(call.input);
  if (!parsed) {
    return { id: call.id, ok: false, content: rejectedTool(sourceName(call.name), zone), listings: [] };
  }
  const asked = whenInMessage(turn.text, turn.now(), zone);
  const search = asked ? { ...parsed, when: asked } : parsed;
  const line = statusLine(search.city.name, search.when, search.budget);
  if (!announced.has(line)) {
    announced.add(line);
    emit({ type: "status", message: line });
  }
  const range = dateRange(search.when, turn.now(), zone);
  const key = windowCacheKey(tool.name, search.city.id, range, search.kind);
  const cached = turn.cache.get(key);
  let ok = true;
  let message = "Cached listings.";
  let warnings: string[] = [];
  let windowed: Listing[];
  const fromCache = cached !== undefined;
  if (cached !== undefined) {
    windowed = cached;
  } else {
    const result = await tool.load({
      city: search.city,
      range,
      kind: search.kind,
      timezone: zone,
      retrievedAt: new Date(turn.now()).toISOString(),
      timeoutMs: turn.timeoutMs,
      signal: turn.signal,
      fetchImpl: turn.fetchImpl,
      cache: turn.cache,
      readPage: turn.readListings ?? turn.readPage,
    });
    ok = result.ok;
    message = result.message;
    warnings = result.warnings;
    windowed = ok ? dedupeListings(sortListings(result.listings.filter((listing) => keepListing(listing, search, range)))) : [];
    if (ok) turn.cache.set(key, windowed);
  }
  emit({ type: "source", source: tool.name, ok, message });
  for (const warning of warnings) emit({ type: "source", source: tool.name, ok: false, message: warning });
  const omit = asksForOtherResults(turn.text) ? new Set((turn.memory.get(turn.sessionId).found ?? []).map((item) => item.url)) : new Set<string>();
  const matched = windowed.filter((listing) => withinBudget(listing, search.budget) && !omit.has(listing.url)).slice(0, CARD_LIMIT);
  if (turn.profile) {
    turn.profile.set(turn.sessionId, "city", search.city.id, "inferred", turn.now());
    if (search.kind) turn.profile.set(turn.sessionId, "event_kinds", search.kind, "inferred", turn.now());
    if (search.budget != null) turn.profile.set(turn.sessionId, "budget_rupees", String(search.budget), "inferred", turn.now());
  }
  return {
    id: call.id,
    ok,
    content: "",
    listings: matched,
    fill: (visible) => toolContent(tool.name, ok, fromCache, range, zone, matched.filter((listing) => visible.has(listing.url)), matched.filter((listing) => !visible.has(listing.url)), message),
    patch: {
      cityId: search.city.id,
      date: search.when,
      kind: search.kind,
      budget: search.budget,
      found: matched.map((listing) => ({ title: listing.title, url: listing.url })),
    },
  };
}

async function openEvent(
  turn: ChatTurn,
  call: { id: string; input: unknown },
  emit: (event: ChatEvent) => void,
): Promise<ToolRan> {
  const blank = { id: call.id, listings: [] as Listing[] };
  const input = callInput(call.input);
  const match = matchFound(turn.memory.get(turn.sessionId).found ?? [], input.title, input.url);
  if (!match) return { ...blank, ok: false, content: "No saved event matches that title." };
  if (!turn.readPage) return { ...blank, ok: false, content: "The browser worker is not enabled on this server." };
  emit({ type: "status", message: `Opening ${match.title}.` });
  const read = await turn.readPage(match.url);
  if (!read.ok) return { ...blank, ok: false, content: read.message };
  const details = readablePage(read.html);
  return { ...blank, ok: true, content: JSON.stringify({ title: match.title, url: match.url, details: details || "The page had no readable text." }) };
}

async function registerEvent(
  turn: ChatTurn,
  call: { id: string; input: unknown },
  emit: (event: ChatEvent) => void,
): Promise<ToolRan> {
  const blank = { id: call.id, listings: [] as Listing[] };
  const input = callInput(call.input);
  const match = matchFound(turn.memory.get(turn.sessionId).found ?? [], input.title, input.url);
  if (!match) return { ...blank, ok: false, content: "No saved event matches that title." };
  if (!turn.registerPage) return { ...blank, ok: false, content: "The browser worker is not enabled on this server." };
  emit({ type: "status", message: `Registering for ${match.title}.` });
  const result = await turn.registerPage(match.url, match.title);
  if (!result) return { ...blank, ok: false, content: "The browser worker could not open the registration." };
  const pay = result.pay ? ` Pay link: ${result.pay.url}` : "";
  return { ...blank, ok: true, content: `${result.message}${pay}`.trim() };
}

function callInput(value: unknown): { title: string; url: string } {
  if (!value || typeof value !== "object") return { title: "", url: "" };
  const record = value as { title?: unknown; url?: unknown };
  return {
    title: typeof record.title === "string" ? record.title : "",
    url: typeof record.url === "string" ? record.url : "",
  };
}

function mergeFound(left: FoundEvent[] | undefined, right: FoundEvent[] | undefined): FoundEvent[] {
  const seen = new Set<string>();
  const merged: FoundEvent[] = [];
  for (const item of [...(left ?? []), ...(right ?? [])]) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    merged.push(item);
  }
  return merged.slice(0, 40);
}

function keepListing(listing: Listing, parsed: SearchInput, range: DateRange): boolean {
  if (parsed.kind && listing.kind !== parsed.kind) return false;
  return listingInWindow(listing, range);
}

function windowCacheKey(tool: ToolName, cityId: string, range: DateRange, kind: EventKind | null): string {
  return `window|${tool}|${cityId}|${range.startMs}|${range.endMs}|${kind ?? "any"}`;
}

function toolContent(source: ToolName, ok: boolean, cached: boolean, range: DateRange, timezone: string, listings: Listing[], hidden: Listing[], message: string): string {
  const start = calendarDate(range.startMs, timezone);
  const end = calendarDate(Math.max(range.startMs, range.endMs - 1), timezone);
  const singleDay = isSingleDay(range.phrase);
  return JSON.stringify({
    source,
    ok,
    cached,
    window: range.phrase,
    date: singleDay ? start : null,
    start,
    end,
    timezone,
    note: message === SIGN_IN_CODE_MESSAGE || !ok ? message : undefined,
    listings: listings.map((listing) => ({
      title: listing.title,
      kind: listing.kind,
      start: listing.start,
      price: listingPrice(listing),
      url: listing.url,
    })),
    more: hidden.slice(0, MORE_FOR_MODEL).map((listing) => ({ title: listing.title, price: listingPrice(listing) })),
    moreCount: hidden.length,
  });
}

function rejectedTool(source: ToolName, timezone: string): string {
  return JSON.stringify({
    source,
    ok: false,
    cached: false,
    window: null,
    date: null,
    start: null,
    end: null,
    timezone,
    listings: [],
  });
}

function listingPrice(listing: Listing): string {
  if (listing.price.provenance === "free") return "free";
  if (listing.price.min == null || listing.price.provenance === "unknown") return "price unknown";
  return `₹${listing.price.min}`;
}

function statusLine(city: string, date: WhenWindow, budget: number | null): string {
  const price = budget == null ? "" : ` under ₹${budget}`;
  return `Looking in ${city} for ${windowLabel(date)}${price}.`;
}

function instructions(nowMs: number, timeZoneName: string, remembered: WhenWindow): string {
  const today = calendarDate(nowMs, timeZoneName);
  const tomorrow = calendarDate(dateRange("tomorrow", nowMs, timeZoneName).startMs, timeZoneName);
  const rememberedDay = isCalendarDay(remembered) ? remembered : windowLabel(remembered);
  return [
    scoutPurpose("Event Scout", "Find shows, movies, and things to do on Luma, District, and BookMyShow. Reply in a few sentences."),
    "Your harness is search_luma, search_district, search_bookmyshow, open_event, and register_event. The browser worker is available. Never say you have no browser worker, no login, or no way to register.",
    "If they are not asking what is on, for a detail, or to book, answer them and do not call a tool. Use the earlier messages in this chat.",
    "When they ask what is on, or which listing is cheaper, call all three search tools with the same city, date, and kind. Compare only prices those tools returned. Do not invent a price or a link. The screen shows only three events. Mention those three, say this is what you got when you last checked, and ask if they are looking for something particular. Then wait. Do not list the rest.",
    "When they ask for any other, more, or to leave out what you already showed, the tools omit those listings. If listings is empty because of that, say those were the only matches and do not repeat their titles.",
    "When they ask for more detail about one event, call open_event with that title. Answer from the page text it returns. Do not say the search listing is all you can see.",
    "When app_event_book is available and they ask to book or get tickets, call it for the cheaper listing on an app the phone can drive. For a BookMyShow or District movie, pass the cinema they named as ref.venue and the time they named as showtime (ISO with offset); the phone goes to that seat map. For a District event, pass the day and slot start as showtime and their price limit as maxPricePerTicket; the phone adds the tickets and stops on Checkout. For Luma, no showtime is needed; the phone stops on the filled registration form. If they named no show or day, call it without a showtime; the phone reports the showtimes or open days, so ask which one. Tell them to tap Allow, then finish in the app: pick seats and pay, tap Checkout, or tap Register. Do not call register_event for that event.",
    "When app_event_book is not available and they ask to register, RSVP, book, or use their Gmail, call register_event with that title. The worker uses the saved Gmail and phone. Tell them what the tool result says. Do not send them the link to do it themselves.",
    "You can search Bengaluru, Mumbai, Delhi, and Hyderabad. Map a city name in any language to bengaluru, mumbai, delhi, or hyderabad. For any other city, say so in their language and do not call a tool.",
    "City ids and the when value stay in that English form even when the reply is in another language.",
    `Today is ${today} in ${timeZoneName}. Tomorrow is ${tomorrow}. The current search window is ${rememberedDay}.`,
    `${WHEN_RULE} kind is any when they did not name a type. budgetRupees is 0 when they did not name a maximum.`,
    "A search result is JSON. Its fields are source, ok, cached, window, date, start, end, timezone, listings, more, and moreCount. window is today, tomorrow, weekend, week, or YYYY-MM-DD. date is YYYY-MM-DD when window is a single day, and null otherwise. start and end are the first and last calendar dates in the window. listings items are title, kind, start, price, and url; those have cards. more is the title and price of other matches, which sit under a Show more button on screen; moreCount is how many there are. When they ask about the other listings, name them from more, or from the Under Show more note in this chat, and point to the Show more button. Each listing's start is the time to judge. open_event returns the full page text for one event.",
    "The reply may mention only listings inside the requested window. A named day means that day only. If listings is empty, say nothing matched that day.",
    "A failed result has a note. If the note says a source is still loading, say that source is still loading and offer to check again in a moment. Do not say it found nothing.",
    "If register_event already ran for an event in this chat, report that result when they ask whether it worked. Do not call register_event again unless they ask you to retry.",
    "Do not invent events, prices, or links. After the tools answer, talk about those results.",
    "Sign in with the Gmail address and phone number already on this account. The browser worker types that phone number or that Gmail address and asks the site to send a code. When the code comes back, the signed-in browser session is saved in the vault and reused. Do not say you have no login, no account, or no booking ability. If a tool says a sign-in code was sent, tell them to approve that code on their phone.",
    "Payment still opens in their UPI app. Never ask for a UPI PIN. If they are just chatting, answer without tools.",
    "The cards on screen already show each event's link, price, and date. Do not paste links. Do not list more than three events. Write two or three short sentences. Never repeat bracketed notes or the order they were mentioned. Do not say listings were held back; say the rest are under Show more.",
  ].join(" ");
}

function timeZone(turn: ChatTurn): string {
  return isTimeZone(turn.timezone) ? turn.timezone : "Asia/Kolkata";
}

function toolByName(name: SearchToolId): EventTool {
  switch (name) {
    case "search_luma":
      return lumaTool;
    case "search_district":
      return districtTool;
    case "search_bookmyshow":
      return bookMyShowTool;
    default: {
      const neverName: never = name;
      return neverName;
    }
  }
}

function sourceName(name: SearchToolId): ToolName {
  switch (name) {
    case "search_luma":
      return "Luma";
    case "search_district":
      return "District";
    case "search_bookmyshow":
      return "BookMyShow";
    default: {
      const neverName: never = name;
      return neverName;
    }
  }
}

function isToolUse(block: Block): block is Block & { id: string; name: ToolId; input: unknown } {
  return block.type === "tool_use" && typeof block.id === "string" && isToolId(block.name);
}

type SearchToolId = "search_luma" | "search_district" | "search_bookmyshow";

function isSearchTool(value: string): value is SearchToolId {
  return value === "search_luma" || value === "search_district" || value === "search_bookmyshow";
}

function isToolId(value: unknown): value is ToolId {
  return value === "search_luma" || value === "search_district" || value === "search_bookmyshow" || value === "open_event" || value === "register_event" || isAssistantTool(value);
}

function searchInput(value: unknown): SearchInput | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const city = typeof record.city === "string" ? cityById(record.city) : null;
  if (!city || !isWhen(record.when) || !isKind(record.kind)) return null;
  const budget = record.budgetRupees === 0 || typeof record.budgetRupees !== "number" ? null : Math.floor(record.budgetRupees);
  return {
    city,
    when: record.when,
    kind: record.kind === "any" ? null : record.kind,
    budget: budget != null && budget >= 0 ? budget : null,
  };
}

function isWhen(value: unknown): value is WhenWord {
  return value === "today" || value === "tomorrow" || value === "weekend" || value === "week" || (typeof value === "string" && isCalendarDay(value));
}

function isKind(value: unknown): value is KindWord {
  return value === "movie" || value === "concert" || value === "comedy" || value === "theatre" || value === "workshop" || value === "sports" || value === "other" || value === "any";
}
