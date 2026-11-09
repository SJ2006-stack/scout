import type { FlightCite, FlightResult } from "../../shared/errands.ts";
import type { IsolatedPage } from "./driver.ts";
import { busesInWindow, cityName, windowLabel, type TimeOfDay } from "./buses.ts";

type Step = <T>(run: (signal: AbortSignal) => Promise<T>) => Promise<T>;

const AIRPORTS: Readonly<Record<string, string>> = {
  delhi: "DEL",
  "new delhi": "DEL",
  mumbai: "BOM",
  bombay: "BOM",
  bengaluru: "BLR",
  bangalore: "BLR",
  hyderabad: "HYD",
  chennai: "MAA",
  madras: "MAA",
  kolkata: "CCU",
  calcutta: "CCU",
  goa: "GOI",
  jaipur: "JAI",
  pune: "PNQ",
  ahmedabad: "AMD",
  lucknow: "LKO",
  kochi: "COK",
  cochin: "COK",
  chandigarh: "IXC",
  indore: "IDR",
  bhopal: "BHO",
  patna: "PAT",
  varanasi: "VNS",
  guwahati: "GAU",
  srinagar: "SXR",
  amritsar: "ATQ",
  coimbatore: "CJB",
  nagpur: "NAG",
  visakhapatnam: "VTZ",
  vizag: "VTZ",
  thiruvananthapuram: "TRV",
  trivandrum: "TRV",
  bhubaneswar: "BBI",
  ranchi: "IXR",
  raipur: "RPR",
  dehradun: "DED",
  udaipur: "UDR",
  jodhpur: "JDH",
  vadodara: "BDQ",
  baroda: "BDQ",
  surat: "STV",
  madurai: "IXM",
  mangalore: "IXE",
  mangaluru: "IXE",
  bagdogra: "IXB",
  siliguri: "IXB",
  leh: "IXL",
  portblair: "IXZ",
  "port blair": "IXZ",
  imphal: "IMF",
  agartala: "IXA",
  agra: "AGR",
};

const PASSES = 4;

export type FlightSearch = { site: string; url: string };

/** Search links for the same one-way trip. Google Flights takes the city names. The others need an airport code. */
export function flightSearches(from: string, to: string, isoDate: string, timeOfDay: TimeOfDay): FlightSearch[] {
  const origin = cityName(from);
  const destination = cityName(to);
  const fromCode = airportCode(from);
  const toCode = airportCode(to);
  const day = flightDay(isoDate);
  if (!origin || !destination || origin.toLowerCase() === destination.toLowerCase() || !day) return [];
  const when = timeOfDay === "any" ? "one way" : timeOfDay;
  const google = `https://www.google.com/travel/flights?hl=en&curr=INR&q=${encodeURIComponent(`${when} flights from ${origin} to ${destination} on ${day.spoken}`)}`;
  const cites: FlightSearch[] = [{ site: "Google Flights", url: google }];
  if (!fromCode || !toCode || fromCode === toCode) return cites;
  cites.push(
    { site: "MakeMyTrip", url: `https://www.makemytrip.com/flight/search?itinerary=${fromCode}-${toCode}-${day.slash}&tripType=O&paxType=A-1_C-0_I-0&intl=false&cabinClass=E` },
    { site: "Goibibo", url: `https://www.goibibo.com/flights/air-${fromCode}-${toCode}-${day.compact}--1-0-0-E-D/` },
    { site: "Cleartrip", url: `https://www.cleartrip.com/flights/results?from=${fromCode}&to=${toCode}&depart_date=${day.slash}&adults=1&childs=0&infants=0&class=Economy&intl=n` },
    { site: "ixigo", url: `https://www.ixigo.com/search/result/flight/${fromCode}/${toCode}/${day.digits}/1/0/0/e` },
    { site: "EaseMyTrip", url: `https://flight.easemytrip.com/FlightList/Index?org=${fromCode}&dept=${toCode}&adt=1&chd=0&inf=0&dt=${day.slash}&cabin=E` },
  );
  return cites;
}

export function airportCode(city: string): string | null {
  return AIRPORTS[cityName(city).toLowerCase()] ?? null;
}

/** The cheapest fare whose nearby clock, when one is written, leaves in the window. */
export function readFlightFare(html: string, timeOfDay: TimeOfDay): { rupees: number; departs: string | null } | null {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  let best: { rupees: number; departs: string | null } | null = null;
  const pattern = /(?:₹|Rs\.?|INR)\s*([1-9]\d{0,2}(?:,\d{3})+|\d{3,6})/gi;
  for (const match of text.matchAll(pattern)) {
    const rupees = Number((match[1] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(rupees) || rupees < 800 || rupees > 150_000) continue;
    const departs = clockNear(text, match.index ?? 0, timeOfDay);
    if (timeOfDay !== "any" && !departs) continue;
    if (!best || rupees < best.rupees) best = { rupees, departs };
  }
  return best;
}

export async function readFlightPage(page: IsolatedPage, timeOfDay: TimeOfDay, search: FlightSearch, step: Step): Promise<FlightCite> {
  await step((signal) => page.goto(search.url, signal));
  let fare: { rupees: number; departs: string | null } | null = null;
  for (let pass = 0; pass < PASSES && !fare; pass += 1) {
    if (pass > 0) {
      await pause(500);
      await step((signal) => page.scroll(signal)).catch(() => false);
    }
    await pause(400);
    const html = await step((signal) => page.html(signal));
    fare = readFlightFare(html, timeOfDay);
  }
  return { site: search.site, url: search.url, rupees: fare?.rupees ?? null, departs: fare?.departs ?? null };
}

export function mergeFlights(from: string, to: string, date: string, timeOfDay: TimeOfDay, cites: readonly FlightCite[]): FlightResult | null {
  const opened = cites.filter((cite) => cite.url.startsWith("https://"));
  if (opened.length === 0) return null;
  return { from: cityName(from), to: cityName(to), date, window: windowLabel(timeOfDay), cites: [...opened] };
}

export function flightSummary(result: FlightResult | null): string {
  if (!result) return "Those flight sites did not open for that route.";
  const route = `${result.from} to ${result.to} on ${result.date}`;
  const names = result.cites.map((cite) => cite.site).join(", ");
  const priced = result.cites.filter((cite) => cite.rupees != null).sort((left, right) => (left.rupees ?? 0) - (right.rupees ?? 0));
  const cheapest = priced[0];
  if (!cheapest || cheapest.rupees == null) {
    return `Scout opened ${names} for ${route} and looked for the ${result.window}. No fare in that window could be read off the pages. Each search is linked on the card. Scout does not book or pay.`;
  }
  const leaves = cheapest.departs ? `, leaving ${cheapest.departs}` : "";
  return `Scout opened ${names} for ${route}. The lowest ${result.window} fare it could read is ₹${cheapest.rupees} on ${cheapest.site}${leaves}. The card links every site. Scout does not book or pay.`;
}

function clockNear(text: string, index: number, timeOfDay: TimeOfDay): string | null {
  let nearest: { clock: string; distance: number } | null = null;
  for (const match of text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)) {
    if (!match[1] || !match[2] || match.index == null) continue;
    const distance = Math.abs(match.index - index);
    if (distance > 40 || (nearest && distance >= nearest.distance)) continue;
    nearest = { clock: `${match[1].padStart(2, "0")}:${match[2]}`, distance };
  }
  if (!nearest) return null;
  if (timeOfDay !== "any" && !departsInWindow(nearest.clock, timeOfDay)) return null;
  return nearest.clock;
}

function departsInWindow(clock: string, timeOfDay: TimeOfDay): boolean {
  return busesInWindow([{ operator: "", busType: "", departs: clock, arrives: clock, duration: "", seats: null, rupees: 1, rating: null }], timeOfDay).length === 1;
}

function flightDay(isoDate: string): { slash: string; compact: string; digits: string; spoken: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const month = months[Number(match[2]) - 1];
  if (!month) return null;
  return {
    slash: `${match[3]}/${match[2]}/${match[1]}`,
    compact: `${match[1]}${match[2]}${match[3]}`,
    digits: `${match[3]}${match[2]}${match[1]}`,
    spoken: `${month} ${Number(match[3])} ${match[1]}`,
  };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
