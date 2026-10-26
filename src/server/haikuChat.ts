import { cityById, type City } from "../shared/cities.ts";
import type { ChatEvent } from "../shared/chatEvents.ts";
import { dedupeListings, sortListings, withinBudget, withinDates, type EventKind, type Listing } from "../shared/event.ts";
import { dateRange, isTimeZone, type DatePhrase } from "../shared/when.ts";
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
const RESULT_LIMIT = 8;
const ROUND_LIMIT = 3;

const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    city: { type: "string", enum: ["bengaluru", "mumbai", "delhi", "hyderabad"] },
    when: { type: "string", enum: ["today", "weekend", "week"] },
    kind: { type: "string", enum: ["movie", "concert", "comedy", "theatre", "workshop", "other", "any"] },
    budgetRupees: { type: "integer" },
  },
  required: ["city", "when", "kind", "budgetRupees"],
} as const;

const TOOLS = [
  {
    name: "search_luma",
    description: "Search Luma's public event list for one city and date window.",
    input_schema: INPUT_SCHEMA,
  },
  {
    name: "search_district",
    description: "Search District events and movies for one city and date window.",
    input_schema: INPUT_SCHEMA,
  },
  {
    name: "search_bookmyshow",
    description: "Search BookMyShow movies and events through Pomerado for one city and date window.",
    input_schema: INPUT_SCHEMA,
  },
] as const;

const INSTRUCTIONS = [
  "You are Event Scout, talking with one person. Reply in a few plain sentences.",
  "Your harness is three tools: search_luma, search_district, and search_bookmyshow.",
  "When they ask what is on, call all three with the same city, date, and kind.",
  "You can search Bengaluru, Mumbai, Delhi, and Hyderabad. For any other city, say so and do not call a tool.",
  "when is today, weekend, or week. kind is any when they did not name a type. budgetRupees is 0 when they did not name a maximum.",
  "Do not invent events, prices, or links. After the tools answer, talk about those results.",
  "You do not book tickets or take payment. If they are just chatting, answer without tools.",
].join(" ");

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
        system: INSTRUCTIONS,
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
  const parsed = searchInput(call.input);
  if (!parsed) {
    return { ok: false, content: "Use city bengaluru, mumbai, delhi, or hyderabad, and when today, weekend, or week.", shown: 0 };
  }
  const line = statusLine(parsed.city.name, parsed.when, parsed.budget);
  if (!announced.has(line)) {
    announced.add(line);
    emit({ type: "status", message: line });
  }
  const range = dateRange(parsed.when, turn.now(), timeZone(turn));
  const result = await tool.load({
    city: parsed.city,
    range,
    kind: parsed.kind,
    timezone: timeZone(turn),
    retrievedAt: new Date(turn.now()).toISOString(),
    timeoutMs: turn.timeoutMs,
    signal: turn.signal,
    fetchImpl: turn.fetchImpl,
    cache: turn.cache,
    pomeradoApiKey: turn.pomeradoApiKey,
  });
  emit({ type: "source", source: result.name, ok: result.ok, message: result.message });
  for (const warning of result.warnings) emit({ type: "source", source: result.name, ok: false, message: warning });
  const shown = dedupeListings(sortListings(result.listings.filter((listing) => keepListing(listing, parsed, range)))).slice(0, CARD_LIMIT);
  const fresh = shown.filter((listing) => !seen.has(listing.url));
  for (const listing of fresh) {
    seen.add(listing.url);
    emit({ type: "card", listing });
  }
  return {
    ok: result.ok,
    shown: fresh.length,
    content: summarise(result.name, result.message, fresh),
    patch: {
      cityId: parsed.city.id,
      date: parsed.when,
      kind: parsed.kind,
      budget: parsed.budget,
    },
  };
}

function keepListing(listing: Listing, parsed: SearchInput, range: { startMs: number; endMs: number }): boolean {
  if (parsed.kind && listing.kind !== parsed.kind) return false;
  if (!withinBudget(listing, parsed.budget)) return false;
  if (listing.platform === "BookMyShow" && listing.start == null) return true;
  return withinDates(listing, range);
}

function summarise(name: ToolName, message: string, listings: Listing[]): string {
  const lines = listings.slice(0, RESULT_LIMIT).map((listing) => {
    const price = listing.price.provenance === "free"
      ? "free"
      : listing.price.min == null || listing.price.provenance === "unknown"
        ? "price unknown"
        : `₹${listing.price.min}`;
    return `- ${listing.title} | ${listing.kind} | ${price} | ${listing.url}`;
  });
  const extra = listings.length > RESULT_LIMIT ? `\n${listings.length - RESULT_LIMIT} more cards are on screen.` : "";
  return [`${name}: ${message}`, ...lines].join("\n") + extra;
}

function statusLine(city: string, date: DatePhrase, budget: number | null): string {
  const window = date === "today" ? "today" : date === "weekend" ? "this weekend" : "the next seven days";
  const price = budget == null ? "" : ` under ₹${budget}`;
  return `Looking in ${city} for ${window}${price}.`;
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
  return value === "today" || value === "weekend" || value === "week";
}

function isKind(value: unknown): value is KindWord {
  return value === "movie" || value === "concert" || value === "comedy" || value === "theatre" || value === "workshop" || value === "other" || value === "any";
}
