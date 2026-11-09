import { cityFromText, type City } from "./cities.ts";
import type { EventKind } from "./event.ts";
import { whenInMessage, type WhenWindow } from "./when.ts";

const KIND_WORD = "comedy|comedies|movies?|films?|concerts?|music|theatres?|theaters?|plays?|workshops?";

export type BudgetUpdate = { kind: "set"; amount: number } | { kind: "clear" } | { kind: "keep" };

export type KindUpdate = { kind: "set"; value: EventKind } | { kind: "clear" } | { kind: "keep" };

export type ChatIntent = {
  city: City | null;
  namedUnsupportedPlace: boolean;
  budget: BudgetUpdate;
  date: WhenWindow | null;
  kind: KindUpdate;
};

const PLACES = ["pune", "chennai", "kolkata", "ahmedabad", "jaipur", "goa", "kochi", "lucknow"];

export function parseChatIntent(text: string, nowMs = Date.now(), timeZone = "Asia/Kolkata"): ChatIntent {
  const value = text.toLowerCase();
  return {
    city: cityFromText(value),
    namedUnsupportedPlace: cityFromText(value) == null && PLACES.some((place) => value.includes(place)),
    budget: readBudget(value),
    date: whenInMessage(text, nowMs, timeZone),
    kind: readKind(value),
  };
}

function readBudget(value: string): BudgetUpdate {
  if (/\b(any budget|no budget|whatever the price)\b/.test(value)) return { kind: "clear" };
  const match = value.match(/(?:under|below|max(?:imum)?|budget)\s*₹?\s*(\d[\d,]*)/);
  if (!match?.[1]) return { kind: "keep" };
  const amount = Number(match[1].replaceAll(",", ""));
  if (!Number.isFinite(amount) || amount < 0) return { kind: "keep" };
  return { kind: "set", amount };
}

/** Kinds they told Scout to leave out, as in "aside from comedy" or "not movies". */
export function excludedKinds(text: string): EventKind[] {
  const exclusion = new RegExp(
    `\\b(?:aside from|other than|apart from|besides|except|excluding|without|not)\\s+(?:the\\s+|any\\s+|more\\s+|those\\s+|these\\s+)?(?:stand-?up\\s+)?(${KIND_WORD})`,
    "gi",
  );
  const found = new Set<EventKind>();
  for (const match of text.toLowerCase().matchAll(exclusion)) {
    const kind = kindOfWord(match[1] ?? "");
    if (kind) found.add(kind);
  }
  return [...found];
}

function kindOfWord(word: string): EventKind | null {
  if (word.startsWith("comed")) return "comedy";
  if (word.startsWith("movie") || word.startsWith("film")) return "movie";
  if (word.startsWith("concert") || word === "music") return "concert";
  if (word.startsWith("theat") || word.startsWith("play")) return "theatre";
  if (word.startsWith("workshop")) return "workshop";
  return null;
}

function namedKinds(value: string): EventKind[] {
  const kinds: EventKind[] = [];
  if (value.includes("comedy")) kinds.push("comedy");
  if (value.includes("concert") || value.includes("music")) kinds.push("concert");
  if (value.includes("theatre") || value.includes("theater") || value.includes("play")) kinds.push("theatre");
  if (value.includes("workshop")) kinds.push("workshop");
  if (value.includes("movie") || value.includes("film")) kinds.push("movie");
  return kinds;
}

function readKind(value: string): KindUpdate {
  if (/\b(anything|everything|all events|whatever)\b/.test(value)) return { kind: "clear" };
  const excluded = new Set(excludedKinds(value));
  const wanted = namedKinds(value).filter((kind) => !excluded.has(kind));
  const named = wanted[0];
  if (wanted.length === 1 && named) return { kind: "set", value: named };
  if (excluded.size > 0) return { kind: "clear" };
  return { kind: "keep" };
}
