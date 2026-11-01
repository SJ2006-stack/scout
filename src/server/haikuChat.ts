import { cityById, type City } from "../shared/cities.ts";
import type { ChatEvent } from "../shared/chatEvents.ts";
import { dedupeListings, listingInWindow, sortListings, withinBudget, type EventKind, type Listing } from "../shared/event.ts";
import { calendarDate, dateRange, isCalendarDay, isSingleDay, isTimeZone, whenInMessage, windowLabel, type DateRange, type WhenWindow } from "../shared/when.ts";
import type { ChatLine, ChatMemory } from "./chatMemory.ts";
import type { ChatTurn } from "./chatRun.ts";
import { SIGN_IN_CODE_MESSAGE } from "./browser/signIn.ts";
import { bookMyShowTool } from "./tools/bookmyshow.ts";
import { districtTool } from "./tools/district.ts";
import { lumaTool } from "./tools/luma.ts";
import type { EventTool, ToolName } from "./tools/types.ts";
import { postHaiku, type HaikuMessage } from "./haikuClient.ts";
import { scoutPurpose } from "./scoutPrompt.ts";
import { withEmoji } from "../shared/emoji.ts";
import { browseFollowUp, matchFound, readablePage, type FoundEvent } from "./events/pageText.ts";
import { assistantPrompt, assistantTools, isAssistantTool, runAssistantTool, type AssistantContext, type AssistantToolName } from "./assistantTools.ts";

export { HAIKU_MODEL } from "./haikuClient.ts";
const CARD_LIMIT = 24;
const SHOW_LIMIT = 3;
const ROUND_LIMIT = 4;

const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    city: { type: "string", enum: ["bengaluru", "mumbai", "delhi", "hyderabad"] },
    when: { type: "string", description: "today, tomorrow, weekend, week, or a calendar day YYYY-MM-DD" },
    kind: { type: "string", enum: ["movie", "concert", "comedy", "theatre", "workshop", "other", "any"] },
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
type ApiMessage = HaikuMessage;

export async function converseWithHaiku(turn: ChatTurn, emit: (event: ChatEvent) => void): Promise<boolean> {
  const remembered = turn.memory.get(turn.sessionId).lines;
  const messages = transcript(remembered, turn.text);
  const seen = new Set<string>();
  const announced = new Set<string>();
  const spoken: string[] = [];
  const shown: string[] = [];
  let patch: Partial<ChatMemory> = {};
  let started = false;
  for (let round = 0; round < ROUND_LIMIT; round += 1) {
    if (turn.signal.aborted) return finish(turn, spoken.join("\n\n"), patch, shown, emit);
    const body = await complete(turn, messages);
    if (body == null) {
      if (!started) return false;
      return finish(turn, spoken.join("\n\n"), patch, shown, emit);
    }
    if (body.stop_reason === "refusal") {
      return finish(turn, "I can't help with that.", patch, shown, emit);
    }
    const blocks = Array.isArray(body.content) ? body.content.filter(isBlock) : [];
    const text = blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => String(block.text).trim()).filter((line) => line.length > 0).join("\n");
    if (text.length > 0 && !spoken.includes(text)) spoken.push(text);
    const calls = blocks.filter(isToolUse);
    if (calls.length === 0) return finish(turn, text.length > 0 ? text : spoken.join("\n\n"), patch, shown, emit);
    started = true;
    messages.push({ role: "assistant", content: blocks });
    const gathered: Listing[] = [];
    const results = await Promise.all(calls.map(async (call) => {
      const ran = await runTool(turn, call, emit, announced);
      gathered.push(...ran.listings);
      if (ran.patch) patch = { ...patch, ...ran.patch, found: mergeFound(patch.found, ran.patch.found) };
      return ran;
    }));
    const preview = dedupeListings(sortListings(gathered)).filter((listing) => !seen.has(listing.url)).slice(0, SHOW_LIMIT);
    const visible = new Set(preview.map((listing) => listing.url));
    for (const listing of preview) {
      seen.add(listing.url);
      emit({ type: "card", listing });
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
  return finish(turn, spoken.join("\n\n"), patch, shown, emit);
}

function finish(
  turn: ChatTurn,
  reply: string,
  patch: Partial<ChatMemory>,
  shown: string[],
  emit: (event: ChatEvent) => void,
): boolean {
  const asked = browseFollowUp(reply.trim(), shown.length, turn.text);
  const spoken = asked.length > 0 ? withEmoji(asked) : "";
  if (spoken.length > 0) emit({ type: "question", message: spoken });
  const previous = turn.memory.get(turn.sessionId);
  const titles = shown.slice(0, 6).map((title, index) => `${index + 1}. ${title}`).join("; ");
  const remembered = `${spoken.length > 0 ? spoken : "I checked the listings."}${titles ? `\n[Shown on screen in order: ${titles}]` : ""}`;
  const lines = [...previous.lines, { role: "user" as const, text: turn.text }, { role: "assistant" as const, text: remembered }].slice(-12);
  turn.memory.save(turn.sessionId, { ...previous, ...patch, found: patch.found ?? previous.found ?? [], lines });
  emit({ type: "done", count: shown.length });
  return true;
}

async function complete(turn: ChatTurn, messages: ApiMessage[]): Promise<{ stop_reason?: string; content?: unknown } | null> {
  return postHaiku({
    apiKey: turn.anthropicApiKey,
    fetchImpl: turn.fetchImpl,
    signal: turn.signal,
    system: `${instructions(turn.now(), timeZone(turn), turn.memory.get(turn.sessionId).date)} ${assistantPrompt(assistantContext(turn))}${voicePrompt(turn)}`,
    tools: [...TOOLS, ...assistantTools(assistantContext(turn))],
    messages,
    ...(turn.onSpeech ? { onText: turn.onSpeech } : {}),
  });
}

export function voicePrompt(turn: ChatTurn): string {
  if (!turn.onSpeech) return "";
  return " This reply is spoken aloud on a voice call. Answer in the language they used, including Hinglish, in at most two short sentences. Before a tool call, say one short line like 'Ek second, dekh raha hoon.' Never read links, emoji, prices with symbols, or lists longer than three items; say the rest is on screen.";
}

export function assistantContext(turn: ChatTurn): AssistantContext {
  return {
    userId: turn.sessionId,
    agent: turn.agent ?? "event",
    now: turn.now,
    timezone: timeZone(turn),
    ...(turn.profile ? { profile: turn.profile } : {}),
    ...(turn.watches ? { watches: turn.watches } : {}),
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
  const matched = windowed.filter((listing) => withinBudget(listing, search.budget)).slice(0, CARD_LIMIT);
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
    fill: (visible) => toolContent(tool.name, ok, fromCache, range, zone, matched.filter((listing) => visible.has(listing.url)), matched.length, message),
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

function toolContent(source: ToolName, ok: boolean, cached: boolean, range: DateRange, timezone: string, listings: Listing[], total: number, message: string): string {
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
    withheld: Math.max(0, total - listings.length),
    listings: listings.map((listing) => ({
      title: listing.title,
      kind: listing.kind,
      start: listing.start,
      price: listingPrice(listing),
      url: listing.url,
    })),
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
    "When they ask what is on, call all three search tools with the same city, date, and kind. The screen shows only three events. Mention those three, say this is what you got when you last checked, and ask if they are looking for something particular. Then wait. Do not list the rest.",
    "When they ask for more detail about one event, call open_event with that title. Answer from the page text it returns. Do not say the search listing is all you can see.",
    "When they ask to register, RSVP, book, or use their Gmail, call register_event with that title. The worker uses the saved Gmail and phone. Tell them what the tool result says. Do not send them the link to do it themselves.",
    "You can search Bengaluru, Mumbai, Delhi, and Hyderabad. Map a city name in any language to bengaluru, mumbai, delhi, or hyderabad. For any other city, say so in their language and do not call a tool.",
    "City ids and the when value stay in that English form even when the reply is in another language.",
    `Today is ${today} in ${timeZoneName}. Tomorrow is ${tomorrow}. The current search window is ${rememberedDay}.`,
    `${WHEN_RULE} kind is any when they did not name a type. budgetRupees is 0 when they did not name a maximum.`,
    "A search result is JSON. Its fields are source, ok, cached, window, date, start, end, timezone, withheld, and listings. window is today, tomorrow, weekend, week, or YYYY-MM-DD. date is YYYY-MM-DD when window is a single day, and null otherwise. start and end are the first and last calendar dates in the window. listings items are title, kind, start, price, and url. withheld is how many other listings were held back. Each listing's start is the time to judge. open_event returns the full page text for one event.",
    "The reply may mention only listings inside the requested window. A named day means that day only. If listings is empty, say nothing matched that day.",
    "A failed result has a note. If the note says a source is still loading, say that source is still loading and offer to check again in a moment. Do not say it found nothing.",
    "If register_event already ran for an event in this chat, report that result when they ask whether it worked. Do not call register_event again unless they ask you to retry.",
    "Do not invent events, prices, or links. After the tools answer, talk about those results.",
    "Sign in with the Gmail address and phone number already on this account. The browser worker types that phone number or that Gmail address and asks the site to send a code. When the code comes back, the signed-in browser session is saved in the vault and reused. Do not say you have no login, no account, or no booking ability. If a tool says a sign-in code was sent, tell them to approve that code on their phone.",
    "Payment still opens in their UPI app. Never ask for a UPI PIN. If they are just chatting, answer without tools.",
  ].join(" ");
}

function timeZone(turn: ChatTurn): string {
  return isTimeZone(turn.timezone) ? turn.timezone : "Asia/Kolkata";
}

function transcript(lines: ChatLine[], text: string): ApiMessage[] {
  const messages: ApiMessage[] = [];
  for (const line of lines) {
    const last = messages.at(-1);
    if (last && last.role === line.role && typeof last.content === "string") {
      last.content = `${last.content}\n${line.text}`;
      continue;
    }
    messages.push({ role: line.role, content: line.text });
  }
  if (messages[0]?.role === "assistant") messages.shift();
  const last = messages.at(-1);
  if (last?.role === "user" && typeof last.content === "string") last.content = `${last.content}\n${text}`;
  else messages.push({ role: "user", content: text });
  return messages;
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

function isBlock(value: unknown): value is Block {
  return Boolean(value) && typeof value === "object";
}

function isToolUse(block: Block): block is Block & { id: string; name: ToolId; input: unknown } {
  return block.type === "tool_use" && typeof block.id === "string" && isToolId(block.name);
}

type SearchToolId = "search_luma" | "search_district" | "search_bookmyshow";

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
  return value === "movie" || value === "concert" || value === "comedy" || value === "theatre" || value === "workshop" || value === "other" || value === "any";
}
