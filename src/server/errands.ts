import { randomBytes } from "node:crypto";
import { BASKET_LIMIT } from "../shared/cartQuote.ts";
import { CITIES, cityById, cityFromText } from "../shared/cities.ts";
import type { ErrandForm, ErrandQuestion } from "../shared/errands.ts";
import type { WatchWhen } from "./watch/watchStore.ts";
import type { BasketItem } from "./basket.ts";
import type { TimeOfDay } from "./browser/buses.ts";
import { isLiveShopQuery } from "./browser/shelf.ts";
import { postSarvam } from "./sarvamChat.ts";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const PLANNER_MODEL = "claude-haiku-5-5";
const PLANNER_TIMEOUT_MS = 25_000;
const ERRAND_LIMIT = 6;
const QUESTION_LIMIT = 8;
const EVENT_KINDS = ["movie", "concert", "comedy", "theatre", "workshop"] as const;
const TIMES: readonly TimeOfDay[] = ["any", "morning", "afternoon", "evening", "night"];
const WHENS: readonly WatchWhen[] = ["today", "tomorrow", "weekend", "week"];

type GroceryItem = BasketItem & { clarify: { prompt: string; options: string[] } | null };

export type Errand =
  | { kind: "groceries"; summary: string; items: GroceryItem[] }
  | { kind: "events"; summary: string; city: string | null; when: WatchWhen | null; eventKind: (typeof EVENT_KINDS)[number] | null }
  | { kind: "whatsapp"; summary: string; contact: string | null; message: string | null; messageFromPhoto: boolean }
  | { kind: "bus"; summary: string; from: string | null; to: string | null; date: string | null; timeOfDay: TimeOfDay | null }
  | { kind: "other"; summary: string };

export type ErrandPlan = { errands: Errand[] };

const NULLABLE = (type: string) => ({ type: [type, "null"] });

const PLAN_TOOL = {
  name: "plan_errands",
  description: "Split their message into errands for Scout's specialists.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      errands: {
        type: "array",
        maxItems: ERRAND_LIMIT,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["groceries", "events", "whatsapp", "bus", "other"] },
            summary: { type: "string", description: "A few words, such as 'Bread, butter, and jam' or 'Bus to Bareilly tomorrow'." },
            items: {
              type: "array",
              maxItems: BASKET_LIMIT,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  query: { type: "string", description: "The grocery words to search, with a brand and size only if they said one." },
                  quantity: { type: "integer", minimum: 1, maximum: 20 },
                  clarify: {
                    type: ["object", "null"],
                    additionalProperties: false,
                    properties: { prompt: { type: "string" }, options: { type: "array", items: { type: "string" }, maxItems: 4 } },
                    required: ["prompt", "options"],
                  },
                },
                required: ["query", "quantity", "clarify"],
              },
            },
            city: { type: ["string", "null"], enum: [...CITIES.map((city) => city.id), null] },
            when: { type: ["string", "null"], enum: [...WHENS, null] },
            eventKind: { type: ["string", "null"], enum: [...EVENT_KINDS, null] },
            contact: NULLABLE("string"),
            message: NULLABLE("string"),
            messageFromPhoto: { type: "boolean" },
            from: NULLABLE("string"),
            to: NULLABLE("string"),
            date: { type: ["string", "null"], description: "YYYY-MM-DD." },
            timeOfDay: { type: ["string", "null"], enum: [...TIMES, null] },
          },
          required: ["kind", "summary", "items", "city", "when", "eventKind", "contact", "message", "messageFromPhoto", "from", "to", "date", "timeOfDay"],
        },
      },
    },
    required: ["errands"],
  },
} as const;

/** Sarvam's guided decoding stalls on null unions and long required lists; readErrand fills what is left out. */
const SARVAM_PLAN_TOOL = {
  name: PLAN_TOOL.name,
  description: PLAN_TOOL.description,
  input_schema: {
    type: "object",
    properties: {
      errands: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["groceries", "events", "whatsapp", "bus", "other"] },
            summary: { type: "string" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  quantity: { type: "integer" },
                  clarify: { type: "object", properties: { prompt: { type: "string" }, options: { type: "array", items: { type: "string" } } } },
                },
                required: ["query"],
              },
            },
            city: { type: "string", enum: CITIES.map((city) => city.id) },
            when: { type: "string", enum: [...WHENS] },
            eventKind: { type: "string", enum: [...EVENT_KINDS] },
            contact: { type: "string" },
            message: { type: "string" },
            messageFromPhoto: { type: "boolean" },
            from: { type: "string" },
            to: { type: "string" },
            date: { type: "string", description: "YYYY-MM-DD." },
            timeOfDay: { type: "string", enum: [...TIMES] },
          },
          required: ["kind", "summary"],
        },
      },
    },
    required: ["errands"],
  },
};

function plannerPrompt(today: string, weekday: string, timezone: string): string {
  return [
    "You split one message to Main Scout into errands for its specialists. Use the plan_errands tool once.",
    `Today is ${weekday} ${today} in ${timezone}.`,
    "groceries: things to buy, or a price to check, on Blinkit, Zepto, or Instamart. 'The price of tea in the quick commerce apps' is groceries, with the item tea. One item per thing; quantity is the count they said, else 1. Keep a brand or size only if they said it.",
    "For an item too vague to pick well (jam, bread, chips, juice), set clarify to a short question with 2 to 4 common choices, such as 'Which jam?' with 'Mixed fruit', 'Strawberry', 'Any'. Otherwise clarify is null.",
    "events: things to do, events, movies, or shows. city is one of bengaluru, mumbai, delhi, hyderabad, or null if they did not name one. when is today, tomorrow, weekend, or week, or null.",
    "whatsapp: a message to send someone on WhatsApp. contact is the name or number exactly as they wrote it. message is the text to send. If the message also contains text read from an attached photo (lines after their request, such as a menu), use that text as message. If what they want to send is in a photo or document they have not attached yet (the mess menu, a bill, a screenshot), message is null and messageFromPhoto is true. Keep a message under 450 characters; when a menu covers several days or meals and they asked for the current one, keep only today's part.",
    "bus: a bus trip. from and to are city names; from is null unless they said it. date is YYYY-MM-DD worked out from today. timeOfDay is any, morning, afternoon, evening, or night, or null if they did not say.",
    "other: anything else they asked for, such as an alarm or a reminder. A price or a search on Blinkit, Zepto, Instamart, or the quick commerce apps is groceries, not other. Its summary is that request in their own words with every detail they gave (time, name, place), because Main Scout runs it from the summary alone. Do not invent contacts, cities, dates, or message text. Unused fields are null, items is empty, messageFromPhoto is false.",
  ].join(" ");
}

type PlanRequest = {
  text: string;
  apiKey: string;
  sarvamApiKey?: string;
  now: number;
  timezone: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
};

/** Claude plans when the account has credit; Sarvam's tool call is the fallback. */
export async function planErrands(options: PlanRequest): Promise<ErrandPlan | null> {
  const today = isoDay(options.now, options.timezone, 0);
  const weekday = new Intl.DateTimeFormat("en-IN", { weekday: "long", timeZone: options.timezone }).format(options.now);
  const system = plannerPrompt(today, weekday, options.timezone);
  const claude = options.apiKey.trim().length > 0 ? await planWithClaude(options, system) : null;
  if (claude) return groundPlan(claude, options.text);
  const sarvamKey = options.sarvamApiKey?.trim() ?? "";
  if (sarvamKey.length === 0) return null;
  const body = await postSarvam({
    apiKey: sarvamKey,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    system: `${system} Leave out a field you do not know instead of writing null. Answer only by calling plan_errands.`,
    tools: [SARVAM_PLAN_TOOL],
    messages: [{ role: "user", content: options.text }],
    maxTokens: 6000,
    timeoutMs: PLANNER_TIMEOUT_MS,
    mustCallTool: true,
  });
  const plan = planFrom(body?.content);
  return plan ? groundPlan(plan, options.text) : null;
}

const WHEN_WORDS: Record<WatchWhen, readonly string[]> = {
  today: ["today", "tonight"],
  tomorrow: ["tomorrow", "tmrw", "tomorrw"],
  weekend: ["weekend", "saturday", "sunday"],
  week: ["week"],
};

const DOCUMENT = /\b(menu|bill|photo|pic|picture|screenshot|receipt|schedule|timetable|pdf|document|notes)\b/i;
const SHOP_LOOK = /\b(?:blinkit|zepto|instamart|quick[\s-]?commerce|q-?commerce)\b/i;
const PRICE_OF = /\b(?:price|cost|how much|rate|daam)\s+(?:of|for)\s+(?:a |an |the )?([a-z][a-z0-9]*(?:\s+(?!in\b|on\b|from\b|across\b|at\b|for\b|and\b)[a-z0-9]+){0,3})/i;
const ITEM_PRICES = /^([a-z][a-z0-9]*(?:\s+(?!in\b|on\b|from\b|across\b|at\b|prices?\b|costs?\b)[a-z0-9]+){0,3})\s+(?:prices?|costs?)\b/i;
const LOOK_FOR = /\b(?:look(?:ing)?(?:\s+for)?|find|search|check)\s+(?:for\s+)?(?:a |an |the )?(?:price\s+of\s+)?([a-z][a-z0-9]*(?:\s+(?!in\b|on\b|from\b|across\b|at\b|for\b|and\b)[a-z0-9]+){0,3})/i;
const NOT_GROCERY = /^(?:price|prices|what|whats|happening|event|events|movie|movies|show|shows|bus|buses|ticket|tickets|quick|commerce)$/i;

/** A price question the planner filed as "other" is still a shop lookup. "Price of tea on the quick commerce apps" becomes the item tea. */
function groceryFromQuestion(summary: string, request: string): GroceryItem | null {
  const asksPrice = /\b(?:price|cost|how much|rate|daam|prices)\b/i.test(summary);
  const shops = SHOP_LOOK.test(summary) || (SHOP_LOOK.test(request) && asksPrice);
  if (!shops || /\b(?:happening|events?|movies?|shows?|concerts?|buses?|tickets?)\b/i.test(summary)) return null;
  const raw = PRICE_OF.exec(summary)?.[1] ?? ITEM_PRICES.exec(summary)?.[1] ?? (asksPrice ? null : LOOK_FOR.exec(summary)?.[1]) ?? null;
  const query = raw?.replace(/\s+/g, " ").trim() ?? "";
  if (query.length < 2 || query.length > 40 || NOT_GROCERY.test(query) || !isLiveShopQuery(query)) return null;
  return { query, quantity: 1, clarify: null };
}

/**
 * Keeps only what their message says. A city, time, or message the planner filled in on its own
 * goes back to null so the question form asks for it.
 */
export function groundPlan(plan: ErrandPlan, request: string): ErrandPlan {
  const said = ` ${request.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ")} `;
  const mentions = (value: string | null): boolean => value != null && said.includes(` ${value.toLowerCase().trim()} `);
  const hasPhotoText = request.includes("\n");
  return {
    errands: plan.errands.map((errand): Errand => {
      switch (errand.kind) {
        case "events": {
          const when = errand.when && WHEN_WORDS[errand.when].some(mentions) ? errand.when : null;
          return { ...errand, city: errand.city != null && cityFromText(request)?.id === errand.city ? errand.city : null, when };
        }
        case "bus":
          return { ...errand, from: mentions(errand.from) ? errand.from : null, timeOfDay: errand.timeOfDay && errand.timeOfDay !== "any" && mentions(errand.timeOfDay) ? errand.timeOfDay : null };
        case "whatsapp": {
          const placeholder = errand.message != null && !hasPhotoText && (DOCUMENT.test(errand.message) || errand.message.trimEnd().endsWith(":")) && errand.message.length < 80;
          if (placeholder || (errand.messageFromPhoto && !hasPhotoText)) return { ...errand, message: null, messageFromPhoto: true };
          return errand;
        }
        case "groceries":
          return errand;
        case "other": {
          const lookedUp = groceryFromQuestion(errand.summary, request);
          return lookedUp ? { kind: "groceries", summary: errand.summary, items: [lookedUp] } : errand;
        }
        default: {
          const unknown: never = errand;
          return unknown;
        }
      }
    }),
  };
}

async function planWithClaude(options: PlanRequest, system: string): Promise<ErrandPlan | null> {
  let response: Response;
  try {
    response = await options.fetchImpl(MESSAGES_URL, {
      method: "POST",
      headers: { "x-api-key": options.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        model: PLANNER_MODEL,
        max_tokens: 2048,
        system,
        tools: [PLAN_TOOL],
        tool_choice: { type: "tool", name: PLAN_TOOL.name },
        messages: [{ role: "user", content: options.text }],
      }),
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(PLANNER_TIMEOUT_MS)]),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as { content?: unknown } | null;
  return planFrom(payload?.content);
}

function planFrom(content: unknown): ErrandPlan | null {
  const blocks: unknown[] = Array.isArray(content) ? content : [];
  const call = blocks.find((block): block is { type: "tool_use"; name: string; input: unknown } => Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "tool_use" && (block as { name?: unknown }).name === PLAN_TOOL.name);
  return call ? readPlan(call.input) : null;
}

export function readPlan(raw: unknown): ErrandPlan | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { errands?: unknown }).errands)) return null;
  const errands: Errand[] = [];
  for (const item of (raw as { errands: unknown[] }).errands.slice(0, ERRAND_LIMIT)) {
    const errand = readErrand(item);
    if (errand) errands.push(errand);
  }
  return { errands };
}

function readErrand(raw: unknown): Errand | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const summary = text(row.summary, 120) ?? "";
  switch (row.kind) {
    case "groceries": {
      const items = Array.isArray(row.items) ? row.items.map(readItem).filter((item): item is GroceryItem => item != null).slice(0, BASKET_LIMIT) : [];
      return items.length > 0 ? { kind: "groceries", summary, items } : null;
    }
    case "events":
      return {
        kind: "events",
        summary,
        city: typeof row.city === "string" && cityById(row.city) ? row.city : null,
        when: WHENS.find((when) => when === row.when) ?? null,
        eventKind: EVENT_KINDS.find((kind) => kind === row.eventKind) ?? null,
      };
    case "whatsapp":
      return { kind: "whatsapp", summary, contact: text(row.contact, 80), message: lines(row.message, 3_000), messageFromPhoto: row.messageFromPhoto === true };
    case "bus":
      return {
        kind: "bus",
        summary,
        from: text(row.from, 60),
        to: text(row.to, 60),
        date: typeof row.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date : null,
        timeOfDay: TIMES.find((time) => time === row.timeOfDay) ?? null,
      };
    case "other":
      return summary.length > 0 ? { kind: "other", summary } : null;
    default:
      return null;
  }
}

function readItem(raw: unknown): GroceryItem | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { query?: unknown; quantity?: unknown; clarify?: unknown };
  const query = text(row.query, 80);
  if (!query || query.length < 2) return null;
  const quantity = typeof row.quantity === "number" && Number.isInteger(row.quantity) ? Math.min(20, Math.max(1, row.quantity)) : 1;
  const clarify = row.clarify && typeof row.clarify === "object" ? (row.clarify as { prompt?: unknown; options?: unknown }) : null;
  const prompt = clarify ? text(clarify.prompt, 120) : null;
  const options = clarify && Array.isArray(clarify.options) ? clarify.options.map((option) => text(option, 40)).filter((option): option is string => option != null).slice(0, 4) : [];
  return { query, quantity, clarify: prompt && options.length >= 2 ? { prompt, options } : null };
}

/** The question bank: what each errand needs before it can run, asked all at once. */
export function questionsFor(plan: ErrandPlan, defaults: { city: string | null }): ErrandQuestion[] {
  const questions: ErrandQuestion[] = [];
  const cityNames = CITIES.map((city) => city.name);
  plan.errands.forEach((errand, index) => {
    switch (errand.kind) {
      case "groceries":
        errand.items.forEach((item, at) => {
          if (item.clarify) questions.push({ id: `${index}.item.${at}`, prompt: item.clarify.prompt, kind: "choice", options: item.clarify.options });
        });
        return;
      case "events":
        if (!errand.city && !defaults.city) questions.push({ id: `${index}.city`, prompt: "Events in which city?", kind: "choice", options: cityNames });
        if (!errand.when) questions.push({ id: `${index}.when`, prompt: "Events for when?", kind: "choice", options: ["Today", "Tomorrow", "This weekend", "This week"] });
        return;
      case "whatsapp":
        if (!errand.contact) questions.push({ id: `${index}.contact`, prompt: "Who should get the WhatsApp message? Their name as saved in WhatsApp, or the number.", kind: "text", options: [] });
        if (!errand.message) {
          questions.push(errand.messageFromPhoto
            ? { id: `${index}.message`, prompt: `Attach a photo of what to send${errand.contact ? ` to ${errand.contact}` : ""}. Scout reads the text and sends it.`, kind: "photo", options: [] }
            : { id: `${index}.message`, prompt: `What should the message${errand.contact ? ` to ${errand.contact}` : ""} say?`, kind: "text", options: [] });
        }
        return;
      case "bus": {
        const home = defaults.city ? cityById(defaults.city)?.name ?? null : null;
        if (!errand.from) questions.push({ id: `${index}.from`, prompt: `Bus${errand.to ? ` to ${errand.to}` : ""} from which city?`, kind: home ? "choice" : "text", options: home ? [home] : [] });
        if (!errand.to) questions.push({ id: `${index}.to`, prompt: "Bus to which city?", kind: "text", options: [] });
        if (!errand.date) questions.push({ id: `${index}.date`, prompt: "Which day?", kind: "choice", options: ["Today", "Tomorrow"] });
        if (!errand.timeOfDay) questions.push({ id: `${index}.time`, prompt: "Leaving when?", kind: "choice", options: ["Morning", "Afternoon", "Evening", "Night", "Any time"] });
        return;
      }
      case "other":
        return;
      default: {
        const neverErrand: never = errand;
        return neverErrand;
      }
    }
  });
  return questions.slice(0, QUESTION_LIMIT);
}

/** Fills each errand from the form. A choice or text box may hold any text they typed. */
export function applyAnswers(plan: ErrandPlan, values: Readonly<Record<string, string>>, now: number, timezone: string, defaults: { city: string | null }): ErrandPlan {
  const value = (key: string) => values[key]?.trim() || null;
  const errands = plan.errands.map((errand, index): Errand => {
    switch (errand.kind) {
      case "groceries":
        return {
          ...errand,
          items: errand.items.map((item, at) => {
            const picked = value(`${index}.item.${at}`);
            if (!picked || /^any$/i.test(picked)) return { ...item, clarify: null };
            const query = picked.toLowerCase().includes(item.query.toLowerCase()) ? picked : `${picked} ${item.query}`;
            return { query: query.slice(0, 80), quantity: item.quantity, clarify: null };
          }),
        };
      case "events":
        return { ...errand, city: errand.city ?? cityFromAnswer(value(`${index}.city`)) ?? defaults.city, when: errand.when ?? whenFromAnswer(value(`${index}.when`)) };
      case "whatsapp":
        return { ...errand, contact: errand.contact ?? value(`${index}.contact`), message: errand.message ?? lines(values[`${index}.message`], 3_000) };
      case "bus":
        return {
          ...errand,
          from: errand.from ?? value(`${index}.from`),
          to: errand.to ?? value(`${index}.to`),
          date: errand.date ?? dateFromAnswer(value(`${index}.date`), now, timezone),
          timeOfDay: errand.timeOfDay ?? timeFromAnswer(value(`${index}.time`)) ?? "any",
        };
      case "other":
        return errand;
      default: {
        const neverErrand: never = errand;
        return neverErrand;
      }
    }
  });
  return { errands };
}

export function formFor(plan: ErrandPlan, questions: ErrandQuestion[]): ErrandForm {
  return { id: randomBytes(12).toString("hex"), tasks: plan.errands.map(errandLabel), questions };
}

export function errandLabel(errand: Errand): string {
  if (errand.summary.length > 0) return errand.summary;
  switch (errand.kind) {
    case "groceries":
      return errand.items.map((item) => item.query).join(", ");
    case "events":
      return "Events";
    case "whatsapp":
      return `WhatsApp ${errand.contact ?? "someone"}`;
    case "bus":
      return `Bus to ${errand.to ?? "somewhere"}`;
    case "other":
      return "Something else";
    default: {
      const neverErrand: never = errand;
      return neverErrand;
    }
  }
}

export function isoDay(now: number, timezone: string, plusDays: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now + plusDays * 86_400_000);
  return parts;
}

function cityFromAnswer(answer: string | null): string | null {
  if (!answer) return null;
  const lower = answer.toLowerCase();
  return CITIES.find((city) => city.aliases.some((alias) => lower.includes(alias)))?.id ?? null;
}

function whenFromAnswer(answer: string | null): WatchWhen | null {
  if (!answer) return null;
  if (/today|tonight/i.test(answer)) return "today";
  if (/tomorrow/i.test(answer)) return "tomorrow";
  if (/weekend/i.test(answer)) return "weekend";
  if (/week/i.test(answer)) return "week";
  return null;
}

function dateFromAnswer(answer: string | null, now: number, timezone: string): string | null {
  if (!answer) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(answer)) return answer;
  if (/today|tonight/i.test(answer)) return isoDay(now, timezone, 0);
  if (/tomorrow/i.test(answer)) return isoDay(now, timezone, 1);
  return null;
}

function timeFromAnswer(answer: string | null): TimeOfDay | null {
  if (!answer) return null;
  return TIMES.find((time) => answer.toLowerCase().includes(time)) ?? null;
}

/** Keeps line breaks, so a menu read from a photo still reads line by line on WhatsApp. */
export function lines(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const kept = value.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1] !== "")).join("\n").trim();
  return kept.length > 0 && !NO_VALUE.test(kept) ? kept.slice(0, limit) : null;
}

/** Sarvam writes "null" as a string for a field it does not know. */
const NO_VALUE = /^(null|none|n\/a|unknown)$/i;

function text(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 && !NO_VALUE.test(trimmed) ? trimmed.slice(0, limit) : null;
}
