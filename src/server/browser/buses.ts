import type { BusOption, BusResult, BusSiteResult } from "../../shared/errands.ts";
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
const MAX_PASSES = 12;
const FIRST_WAIT_MS = 400;
const SCROLL_WAIT_MS = 500;

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

export type BusScrollState = {
  timeOfDay: TimeOfDay;
  inWindow: number;
  grew: boolean;
  moved: boolean;
  pass: number;
  fruitless: number;
};

/**
 * Keep scrolling while the asked departure window is still missing.
 * Stop once a further scroll adds nothing, the page no longer moves, or the pass cap is hit.
 */
export function keepScrollingBuses(state: BusScrollState): boolean {
  if (state.pass >= MAX_PASSES) return false;
  if (state.pass >= 2 && !state.moved) return false;
  if (state.timeOfDay !== "any" && state.inWindow === 0) return state.fruitless < 2;
  if (state.inWindow > 0 && !state.grew) return false;
  return state.fruitless < 1 && state.pass < 6;
}

export type BusSearch = {
  site: string;
  url: string;
  readRows: (html: string) => BusOption[];
  readTotal: (html: string) => number | null;
};

/** redBus, ixigo, Goibibo, and ConfirmTkt. Each URL is the day's search; a missing slug drops that site. */
export function busSearches(trip: BusTrip): BusSearch[] {
  const from = cityName(trip.from);
  const to = cityName(trip.to);
  const fromSlug = citySlug(trip.from);
  const toSlug = citySlug(trip.to);
  if (!fromSlug || !toSlug || fromSlug === toSlug) return [];
  const day = tripDay(trip.date);
  if (!day) return [];
  const searches: BusSearch[] = [
    { site: "redBus", url: redbusSearchUrl(trip.from, trip.to, trip.date) ?? "", readRows: readBusRows, readTotal: busTotal },
    { site: "ixigo", url: `https://www.ixigo.com/search/result/bus/${encodeURIComponent(from)}/${encodeURIComponent(to)}/${day.ddmmyyyy}`, readRows: readLooseBuses, readTotal: () => null },
    { site: "Goibibo", url: `https://www.goibibo.com/bus/results?fromCity=${encodeURIComponent(from)}&toCity=${encodeURIComponent(to)}&doj=${day.dashed}`, readRows: readLooseBuses, readTotal: () => null },
    { site: "ConfirmTkt", url: `https://www.confirmtkt.com/bus/${fromSlug}-to-${toSlug}?date=${day.dashed}`, readRows: readLooseBuses, readTotal: () => null },
  ];
  return searches.filter((search) => search.url.startsWith("https://"));
}

/** Scrolls until the asked window shows up in the rows, or the list stops growing. */
export async function readBusPage(page: IsolatedPage, trip: BusTrip, search: BusSearch, step: Step): Promise<BusSiteResult> {
  await step((signal) => page.goto(search.url, signal));
  const collected = new Map<string, BusOption>();
  let total: number | null = null;
  let pass = 0;
  let moved = true;
  let grew = false;
  let fruitless = 0;
  while (pass < MAX_PASSES) {
    if (pass > 0) {
      await pause(SCROLL_WAIT_MS);
      moved = await step((signal) => page.scroll(signal)).catch(() => false);
      await pause(SCROLL_WAIT_MS);
    } else {
      await pause(FIRST_WAIT_MS);
    }
    const html = await step((signal) => page.html(signal));
    const before = collected.size;
    for (const option of search.readRows(html)) {
      const key = `${option.operator}\0${option.departs}\0${option.rupees}`;
      if (!collected.has(key)) collected.set(key, option);
    }
    grew = collected.size > before;
    fruitless = grew ? 0 : fruitless + 1;
    total = search.readTotal(html) ?? total;
    const inWindow = busesInWindow([...collected.values()], trip.timeOfDay).length;
    pass += 1;
    if (!keepScrollingBuses({ timeOfDay: trip.timeOfDay, inWindow, grew, moved, pass, fruitless })) break;
  }
  const loaded = [...collected.values()];
  return {
    site: search.site,
    url: search.url,
    total,
    loaded: loaded.length,
    options: busesInWindow(loaded, trip.timeOfDay).slice(0, 6),
  };
}

export function mergeBusSites(trip: BusTrip, sites: readonly BusSiteResult[]): BusResult | null {
  const opened = sites.filter((site) => site.url.startsWith("https://"));
  if (opened.length === 0) return null;
  const options = opened
    .flatMap((site) => site.options.map((option) => ({ ...option, site: site.site })))
    .sort((left, right) => left.rupees - right.rupees || left.departs.localeCompare(right.departs))
    .slice(0, 10);
  const primary = opened.find((site) => site.site === "redBus") ?? opened[0];
  if (!primary) return null;
  return {
    from: cityName(trip.from),
    to: cityName(trip.to),
    date: trip.date,
    window: windowLabel(trip.timeOfDay),
    url: primary.url,
    total: primary.total,
    options,
    sites: [...opened],
  };
}

export function busSummary(result: BusResult | null): string {
  if (!result) return "Those bus sites did not open for that route.";
  const route = `${result.from} to ${result.to} on ${result.date}`;
  const cheapest = result.options[0];
  const names = result.sites?.map((site) => site.site).join(", ");
  if (!names) {
    if (!cheapest) return `redBus lists ${result.total ?? "no"} buses ${route}, but none of the rows it loaded leave in the ${result.window}. Open redBus to see them all: ${result.url}`;
    const seats = cheapest.seats == null ? "" : `, ${cheapest.seats} seats left`;
    return `redBus lists ${result.total ?? result.options.length} buses ${route}. In the ${result.window}, the cheapest is ${cheapest.operator} at ₹${cheapest.rupees}, leaving ${cheapest.departs} and arriving ${cheapest.arrives} (${cheapest.busType}${seats}). Book it on redBus: ${result.url}`;
  }
  if (!cheapest) return `Scout opened ${names} for ${route} and kept scrolling for the ${result.window}. None of the departures those pages loaded leave then. Each site's search is on the card.`;
  const where = cheapest.site ? ` on ${cheapest.site}` : "";
  return `Scout opened ${names} for ${route}. In the ${result.window}, the cheapest departure it loaded is ${cheapest.operator}${where} at ₹${cheapest.rupees}, leaving ${cheapest.departs} and arriving ${cheapest.arrives}. Booking stays on that site.`;
}

/** Times and a rupee fare written near each other. Used for sites that do not speak redBus's row label. */
export function readLooseBuses(html: string): BusOption[] {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const rows: BusOption[] = [];
  const seen = new Set<string>();
  const pattern = /(\d{1,2}:\d{2})\s*(?:-|–|to|arrives?)\s*(\d{1,2}:\d{2})[\s\S]{0,160}?(?:₹|Rs\.?|INR)\s*([1-9]\d{0,2}(?:,\d{3})+|\d{2,5})/gi;
  for (const match of text.matchAll(pattern)) {
    const departs = clock(match[1] ?? "");
    const arrives = clock(match[2] ?? "");
    const rupees = Number((match[3] ?? "").replace(/,/g, ""));
    if (!departs || !arrives || !Number.isFinite(rupees) || rupees < 50 || rupees > 20_000) continue;
    const before = text.slice(Math.max(0, (match.index ?? 0) - 48), match.index ?? 0);
    const operator = before.split(/[.|]/).pop()?.replace(/[^A-Za-z0-9& ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "Bus";
    const key = `${operator}\0${departs}\0${rupees}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ operator, busType: "Bus", departs, arrives, duration: "", seats: null, rupees, rating: null });
  }
  return rows;
}

function tripDay(isoDate: string): { dashed: string; ddmmyyyy: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return { dashed: `${match[3]}-${match[2]}-${match[1]}`, ddmmyyyy: `${match[3]}${match[2]}${match[1]}` };
}

function clock(value: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match?.[1] || !match[2]) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

export function citySlug(city: string): string {
  return cityName(city).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function cityName(city: string): string {
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
