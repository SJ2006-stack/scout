import { cityById, type City } from "../shared/cities.ts";
import type { ChatEvent } from "../shared/chatEvents.ts";
import { datePhraseInMessage } from "../shared/chatIntent.ts";
import { dedupeListings, listingInWindow, sortListings, withinBudget, type EventKind, type Listing } from "../shared/event.ts";
import { calendarDate, dateRange, isTimeZone, windowLabel, type DatePhrase, type DateRange } from "../shared/when.ts";
import type { ChatLine, ChatMemory } from "./chatMemory.ts";
import type { ChatTurn } from "./chatRun.ts";
import { bookMyShowTool } from "./tools/bookmyshow.ts";
import { districtTool } from "./tools/district.ts";
import { lumaTool } from "./tools/luma.ts";
import type { EventTool, ToolName } from "./tools/types.ts";

export const HAIKU_MODEL = "claude-haiku-5-5";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const MODEL_TIMEOUT_MS = 20_000;
const CARD_LIMIT = 24;
const ROUND_LIMIT = 3;

const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    city: { type: "string", enum: ["bengaluru", "mumbai", "delhi", "hyderabad"] },
    when: { type: "string", enum: ["today", "tomorrow", "weekend", "week"] },
    kind: { type: "string", enum: ["movie", "concert", "comedy", "theatre", "workshop", "other", "any"] },
    budgetRupees: { type: "integer" },
  },
  required: ["city", "when", "kind", "budgetRupees"],
} as const;

const WHEN_RULE = "when is today, tomorrow, weekend, or week. A single day the user named uses that value. Do not use week for tomorrow.";

const TOOLS = [
  {
    name: "search_luma",
    description: `Search Luma's public event list for one city and date window. ${WHEN_RULE}`,
    input_schema: INPUT_SCHEMA,
  },
  {
    name: "search_district",
    description: `Search District events and movies for one city and date window. ${WHEN_RULE}`,
    input_schema: INPUT_SCHEMA,
  },
  {
    name: "search_bookmyshow",
    description: `Search BookMyShow movies and events through Pomerado for one city and date window. ${WHEN_RULE}`,
    input_schema: INPUT_SCHEMA,
  },
] as const;

type ToolId = (typeof TOOLS)[number]["name"];
type WhenWord = DatePhrase;
type KindWord = EventKind | "any";
type SearchInput = { city: City; when: WhenWord; kind: EventKind | null; budget: number | null };
type Block = Record<string, unknown>;
type ApiMessage = { role: "user" | "assistant"; content: string | Block[] };

export async function converseWithHaiku(turn: ChatTurn, emit: (event: ChatEvent) => void): Promise<boolean> {
  const messages = transcript(turn.memory.get(turn.sessionId).lines, turn.text);
  const seen = new Set<string>();
  const announced = new Set<string>();
  const spoken: string[] = [];
  let shown = 0;
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
    if (calls.length === 0) return finish(turn, spoken.join("\n\n"), patch, shown, emit);
    started = true;
    messages.push({ role: "assistant", content: blocks });
    const results = await Promise.all(calls.map(async (call) => {
      const ran = await runTool(turn, call, emit, seen, announced);
      shown += ran.shown;
      if (ran.patch) patch = { ...patch, ...ran.patch };
      return { type: "tool_result", tool_use_id: call.id, is_error: !ran.ok, content: ran.content };
    }));
    messages.push({ role: "user", content: results });
  }
  return finish(turn, spoken.join("\n\n"), patch, shown, emit);
}

function finish(
  turn: ChatTurn,
  reply: string,
  patch: Partial<ChatMemory>,
  shown: number,
  emit: (event: ChatEvent) => void,
): boolean {
  const spoken = reply.trim();
  if (spoken.length > 0) emit({ type: "question", message: spoken });
  const previous = turn.memory.get(turn.sessionId);
  const remembered = spoken.length > 0 ? spoken : "I checked the listings.";
  const lines = [...previous.lines, { role: "user" as const, text: turn.text }, { role: "assistant" as const, text: remembered }].slice(-12);
  turn.memory.save(turn.sessionId, { ...previous, ...patch, lines });
  emit({ type: "done", count: shown });
  return true;
}

async function complete(turn: ChatTurn, messages: ApiMessage[]): Promise<{ stop_reason?: string; content?: unknown } | null> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), MODEL_TIMEOUT_MS);
  const signal = AbortSignal.any([turn.signal, timeout.signal]);
  try {
    const response = await turn.fetchImpl(MESSAGES_URL, {
      method: "POST",
      headers: {
        "x-api-key": turn.anthropicApiKey.trim(),
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 1024,
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
        system: instructions(turn.now(), timeZone(turn)),
        tools: TOOLS,
        messages,
      }),
      signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as { stop_reason?: string; content?: unknown };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function runTool(
  turn: ChatTurn,
  call: { id: string; name: ToolId; input: unknown },
  emit: (event: ChatEvent) => void,
  seen: Set<string>,
  announced: Set<string>,
): Promise<{ ok: boolean; content: string; shown: number; patch?: Partial<ChatMemory> }> {
  const tool = toolByName(call.name);
  const zone = timeZone(turn);
  const parsed = searchInput(call.input);
  if (!parsed) {
    return { ok: false, content: rejectedTool(sourceName(call.name), zone), shown: 0 };
  }
  const asked = datePhraseInMessage(turn.text);
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
      pomeradoApiKey: turn.pomeradoApiKey,
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
  const fresh = matched.filter((listing) => !seen.has(listing.url));
  for (const listing of fresh) {
    seen.add(listing.url);
    emit({ type: "card", listing });
  }
  return {
    ok,
    shown: fresh.length,
    content: toolContent(tool.name, ok, fromCache, range, zone, matched),
    patch: {
      cityId: search.city.id,
      date: search.when,
      kind: search.kind,
      budget: search.budget,
    },
  };
}

function keepListing(listing: Listing, parsed: SearchInput, range: DateRange): boolean {
  if (parsed.kind && listing.kind !== parsed.kind) return false;
  return listingInWindow(listing, range);
}

function windowCacheKey(tool: ToolName, cityId: string, range: DateRange, kind: EventKind | null): string {
  return `window|${tool}|${cityId}|${range.startMs}|${range.endMs}|${kind ?? "any"}`;
}

function toolContent(source: ToolName, ok: boolean, cached: boolean, range: DateRange, timezone: string, listings: Listing[]): string {
  const start = calendarDate(range.startMs, timezone);
  const end = calendarDate(Math.max(range.startMs, range.endMs - 1), timezone);
  const singleDay = range.phrase === "today" || range.phrase === "tomorrow";
  return JSON.stringify({
    source,
    ok,
    cached,
    window: range.phrase,
    date: singleDay ? start : null,
    start,
    end,
    timezone,
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

function statusLine(city: string, date: DatePhrase, budget: number | null): string {
  const price = budget == null ? "" : ` under ₹${budget}`;
  return `Looking in ${city} for ${windowLabel(date)}${price}.`;
}

function instructions(nowMs: number, timeZoneName: string): string {
  const today = calendarDate(nowMs, timeZoneName);
  const tomorrow = calendarDate(dateRange("tomorrow", nowMs, timeZoneName).startMs, timeZoneName);
  return [
    "You are Event Scout, talking with one person. Reply in a few plain sentences.",
    "Your harness is three tools: search_luma, search_district, and search_bookmyshow.",
    "When they ask what is on, call all three with the same city, date, and kind.",
    "You can search Bengaluru, Mumbai, Delhi, and Hyderabad. For any other city, say so and do not call a tool.",
    `Today is ${today} in ${timeZoneName}. Tomorrow is ${tomorrow}.`,
    `${WHEN_RULE} kind is any when they did not name a type. budgetRupees is 0 when they did not name a maximum.`,
    "Each tool result is JSON. That JSON is the only set of events that exist. Its fields are source, ok, cached, window, date, start, end, timezone, and listings. window is today, tomorrow, weekend, or week. date is YYYY-MM-DD when window is a single day, and null otherwise. start and end are the first and last calendar dates in the window. listings items are title, kind, start, price, and url. Each listing's start is the time to judge.",
    "The reply may mention only listings inside the requested window. If they asked for tomorrow, do not mention or imply events on any other date. If listings is empty, say nothing matched that day.",
    "Do not invent events, prices, or links. After the tools answer, talk about those results.",
    "You do not book tickets or take payment. If they are just chatting, answer without tools.",
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

function toolByName(name: ToolId): EventTool {
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

function sourceName(name: ToolId): ToolName {
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

function isToolId(value: unknown): value is ToolId {
  return value === "search_luma" || value === "search_district" || value === "search_bookmyshow";
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
  return value === "today" || value === "tomorrow" || value === "weekend" || value === "week";
}

function isKind(value: unknown): value is KindWord {
  return value === "movie" || value === "concert" || value === "comedy" || value === "theatre" || value === "workshop" || value === "other" || value === "any";
}
