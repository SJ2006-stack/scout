import type { BusOption, BusResult } from "../../shared/errands.ts";
import type { IsolatedPage } from "./driver.ts";

export type TimeOfDay = "any" | "morning" | "afternoon" | "evening" | "night";

export type BusTrip = { from: string; to: string; date: string; timeOfDay: TimeOfDay };

type Step = <T>(run: (signal: AbortSignal) => Promise<T>) => Promise<T>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WINDOWS: Readonly<Record<TimeOfDay, { label: string; from: number; to: number }>> = {
  any: { label: "any time", from: 0, to: 24 * 60 },
  morning: { label: "morning (6 am to noon)", from: 6 * 60, to: 12 * 60 },
  afternoon: { label: "afternoon (noon to 6 pm)", from: 12 * 60, to: 18 * 60 },
  evening: { label: "evening (6 pm to midnight)", from: 18 * 60, to: 24 * 60 },
  night: { label: "night (midnight to 6 am)", from: 0, to: 6 * 60 },
};
const ATTEMPTS = 12;

/** redBus opens the day's search from the city names alone, for example /bus-tickets/delhi-to-bareilly?…&onward=07-Nov-2026. */
export function redbusSearchUrl(from: string, to: string, isoDate: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  const fromSlug = citySlug(from);
  const toSlug = citySlug(to);
  if (!match || !month || !fromSlug || !toSlug || fromSlug === toSlug) return null;
  const onward = `${match[3]}-${month}-${match[1]}`;
  const query = new URLSearchParams({ fromCityName: cityName(from), toCityName: cityName(to), onward });
  return `https://www.redbus.in/bus-tickets/${fromSlug}-to-${toSlug}?${query.toString()}`;
}

/** Each result row carries a spoken label: "FlixBus, A/C Sleeper (2+1). Departs 22:30, arrives 04:00. Duration 5h 30m. Available seats 18 Seats. Price 856.19 INR. Rated 4.3 out of 5." */
export function readBusRows(html: string): BusOption[] {
  const rows: BusOption[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/aria-label="([^"]*?Departs \d{1,2}:\d{2}[^"]*?)"/g)) {
    const label = decode(match[1] ?? "");
    const head = /^(.+?), (.+?)\. Departs (\d{1,2}:\d{2}), arrives (\d{1,2}:\d{2})\. Duration ([^.]+)\./.exec(label);
    const price = /Price ([0-9][0-9,]*(?:\.\d+)?) INR/.exec(label);
    if (!head?.[1] || !head[2] || !head[3] || !head[4] || !head[5] || !price?.[1]) continue;
    const rupees = Math.round(Number(price[1].replace(/,/g, "")));
    if (!Number.isFinite(rupees) || rupees <= 0) continue;
    const seats = /Available seats (\d+)/.exec(label)?.[1];
    const rating = /Rated (\d(?:\.\d)?) out of 5/.exec(label)?.[1];
    const option: BusOption = {
      operator: head[1].trim(),
      busType: head[2].trim(),
      departs: head[3].padStart(5, "0"),
      arrives: head[4].padStart(5, "0"),
      duration: head[5].trim(),
      seats: seats ? Number(seats) : null,
      rupees,
      rating: rating ? Number(rating) : null,
    };
    const key = `${option.operator}\0${option.departs}\0${option.rupees}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(option);
  }
  return rows;
}

export function busTotal(html: string): number | null {
  const count = /(\d{1,4}) buses found/.exec(html)?.[1];
  return count ? Number(count) : null;
}

/** Buses that leave in the window they asked for, with seats, cheapest first. */
export function busesInWindow(options: readonly BusOption[], timeOfDay: TimeOfDay): BusOption[] {
  const window = WINDOWS[timeOfDay];
  return options
    .filter((option) => option.seats == null || option.seats > 0)
    .filter((option) => {
      const minutes = clockMinutes(option.departs);
      return minutes != null && minutes >= window.from && minutes < window.to;
    })
    .sort((left, right) => left.rupees - right.rupees || left.departs.localeCompare(right.departs));
}

export function windowLabel(timeOfDay: TimeOfDay): string {
  return WINDOWS[timeOfDay].label;
}

export async function readBuses(page: IsolatedPage, trip: BusTrip, step: Step): Promise<BusResult | null> {
  const url = redbusSearchUrl(trip.from, trip.to, trip.date);
  if (!url) return null;
  await step((signal) => page.goto(url, signal));
  let html = "";
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (attempt > 0) await pause(1_000);
    html = await step((signal) => page.html(signal));
    if (readBusRows(html).length > 0) break;
  }
  const options = busesInWindow(readBusRows(html), trip.timeOfDay);
  return { from: cityName(trip.from), to: cityName(trip.to), date: trip.date, window: windowLabel(trip.timeOfDay), url, total: busTotal(html), options: options.slice(0, 10) };
}

export function busSummary(result: BusResult | null): string {
  if (!result) return "redBus did not open for that route.";
  const route = `${result.from} to ${result.to} on ${result.date}`;
  const cheapest = result.options[0];
  if (!cheapest) return `redBus lists ${result.total ?? "no"} buses ${route}, but none of the first ones it showed leave in the ${result.window}. Open redBus to see them all: ${result.url}`;
  const seats = cheapest.seats == null ? "" : `, ${cheapest.seats} seats left`;
  return `redBus lists ${result.total ?? result.options.length} buses ${route}. In the ${result.window}, the cheapest is ${cheapest.operator} at ₹${cheapest.rupees}, leaving ${cheapest.departs} and arriving ${cheapest.arrives} (${cheapest.busType}${seats}). Book it on redBus: ${result.url}`;
}

function citySlug(city: string): string {
  return cityName(city).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function cityName(city: string): string {
  const trimmed = city.replace(/\s+/g, " ").trim();
  if (/^(?:new delhi|delhi ncr)$/i.test(trimmed)) return "Delhi";
  if (/^bengaluru$/i.test(trimmed)) return "Bangalore";
  return trimmed.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function clockMinutes(clock: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(clock);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function decode(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
