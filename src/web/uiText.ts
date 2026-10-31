import { matchesCardFilter, type CardFilter, type Listing } from "../shared/event.ts";
import type { Conversation } from "./conversations.ts";

const DAY_MS = 86_400_000;

export function firstName(name: string | null): string | null {
  const first = name?.trim().split(/\s+/)[0] ?? "";
  return first.length > 0 ? first : null;
}

export function greeting(name: string | null): string {
  const first = firstName(name);
  return first ? `Hi, ${first}` : "Hi there";
}

export function initialOf(name: string | null, email: string | null): string {
  const source = (name?.trim() || email?.trim() || "S").charAt(0);
  return source.toUpperCase();
}

export function formatPhone(phone: string | null): string | null {
  if (phone == null) return null;
  const match = /^\+91(\d{5})(\d{5})$/.exec(phone);
  return match ? `+91 ${match[1]} ${match[2]}` : phone;
}

function validZone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en-IN", { timeZone: zone });
    return zone;
  } catch {
    return "Asia/Kolkata";
  }
}

function dayKey(date: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** "Today · 7:30 pm", "Tomorrow", "Sat, 1 Nov · 7:30 pm". A start at exactly midnight is treated as date-only. */
export function formatWhen(start: string | null, timezone: string, now: Date): string | null {
  if (start == null) return null;
  const date = new Date(start);
  if (Number.isNaN(date.getTime())) return null;
  const zone = validZone(timezone);
  const day = dayKey(date, zone);
  let label: string;
  if (day === dayKey(now, zone)) label = "Today";
  else if (day === dayKey(new Date(now.getTime() + DAY_MS), zone)) label = "Tomorrow";
  else label = new Intl.DateTimeFormat("en-IN", { timeZone: zone, weekday: "short", day: "numeric", month: "short" }).format(date);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "numeric", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "0";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  if (Number(hour) === 0 && Number(minute) === 0) return label;
  const clock = new Intl.DateTimeFormat("en-IN", { timeZone: zone, hour: "numeric", minute: "2-digit", hour12: true }).format(date).toLowerCase();
  return `${label} · ${clock}`;
}

export function filterCounts(listings: readonly Pick<Listing, "kind">[], filters: readonly CardFilter[]): Record<CardFilter, number> {
  const counts = { all: listings.length } as Record<CardFilter, number>;
  for (const filter of filters) {
    if (filter === "all") continue;
    counts[filter] = listings.filter((listing) => matchesCardFilter(listing.kind, filter)).length;
  }
  return counts;
}

export function hasUserTurn(conversation: Pick<Conversation, "turns">): boolean {
  return conversation.turns.some((turn) => turn.kind === "user");
}

export function friendlyBrowserError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("not enabled")) return "Browser tasks aren't available right now.";
  if (lower.includes("could not reach") || lower.includes("could not be reached")) {
    return "Scout couldn't reach its browser right now. Try again in a moment.";
  }
  return message;
}
