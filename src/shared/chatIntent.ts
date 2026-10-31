import { cityFromText, type City } from "./cities.ts";
import type { EventKind } from "./event.ts";
import { whenInMessage, type WhenWindow } from "./when.ts";

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

function readKind(value: string): KindUpdate {
  if (/\b(anything|everything|all events|whatever)\b/.test(value)) return { kind: "clear" };
  if (value.includes("comedy")) return { kind: "set", value: "comedy" };
  if (value.includes("concert") || value.includes("music")) return { kind: "set", value: "concert" };
  if (value.includes("theatre") || value.includes("theater") || value.includes("play")) return { kind: "set", value: "theatre" };
  if (value.includes("workshop")) return { kind: "set", value: "workshop" };
  if (value.includes("movie") || value.includes("film")) return { kind: "set", value: "movie" };
  return { kind: "keep" };
}
