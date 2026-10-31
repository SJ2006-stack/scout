import type { EventKind, Listing, ListingPrice } from "../../shared/event.ts";
import { listingsFromHtml } from "../events/htmlListings.ts";
import { httpsUrl, isListingUrl, kindFromText, priceFromAmount, unknownPrice } from "../../shared/event.ts";
import { calendarDates } from "../../shared/when.ts";
import type { EventTool, ToolContext, ToolResult } from "./types.ts";

const TOOL_ID = "tool_1528e3718e37c1b0489614053d3b4080";
const RUN_URL = "https://api.pomerado.ai/v1/runs/read-only";
const PAGE_LIMIT = 8;

export const bookMyShowTool: EventTool = {
  name: "BookMyShow",
  load(context) {
    return loadBookMyShow(context);
  },
};

async function loadBookMyShow(context: ToolContext): Promise<ToolResult> {
  if (context.pomeradoApiKey.trim().length === 0) {
    return { name: "BookMyShow", ok: false, message: "BookMyShow is not configured.", listings: [], warnings: [] };
  }
  const dates = calendarDates(context.range.startMs, context.range.endMs, context.timezone);
  const calls: Promise<CallResult>[] = [];
  if (wantsMovies(context.kind)) {
    const date = dates[0];
    if (date) calls.push(loadKind(context, "movies", date));
  }
  if (wantsEvents(context.kind)) {
    for (const date of dates) calls.push(loadKind(context, "events", date));
  }
  const parts = await Promise.all(calls);
  const listings = parts.flatMap((part) => part.listings);
  const warnings = parts.flatMap((part) => (part.ok ? [] : [part.message]));
  if (listings.length === 0 && warnings.length > 0) {
    return { name: "BookMyShow", ok: false, message: warnings[0] ?? "BookMyShow is unavailable.", listings: [], warnings: warnings.slice(1) };
  }
  return { name: "BookMyShow", ok: true, message: "BookMyShow listings loaded.", listings, warnings };
}

type CallResult = { ok: true; listings: Listing[] } | { ok: false; message: string; listings: [] };

async function loadKind(context: ToolContext, kind: "movies" | "events", date: string): Promise<CallResult> {
  const key = `bookmyshow|${context.city.id}|${date}|${kind}`;
  const cached = context.cache.get(key);
  if (cached) return { ok: true, listings: cached };
  const ran = await runSearch(context, kind, date);
  if (!ran.ok) {
    const page = await loadBookMyShowPage(context, ran.message);
    if (page.ok) context.cache.set(key, page.listings);
    return page;
  }
  const listings = bookMyShowListings(ran.payload, context.retrievedAt, context.city.name);
  context.cache.set(key, listings);
  return { ok: true, listings };
}

async function loadBookMyShowPage(context: ToolContext, failure: string): Promise<CallResult> {
  if (!context.readPage) return { ok: false, message: failure, listings: [] };
  const url = `https://in.bookmyshow.com/explore/home/${encodeURIComponent(context.city.bookMyShowCity)}`;
  const read = await context.readPage(url);
  if (!read.ok) return { ok: false, message: read.message, listings: [] };
  const listings = listingsFromHtml(read.html, "BookMyShow", context.city.name, context.retrievedAt);
  if (listings.length === 0) return { ok: false, message: failure, listings: [] };
  return { ok: true, listings };
}

type RunResult = { ok: true; payload: unknown } | { ok: false; message: string };

async function runSearch(context: ToolContext, kind: "movies" | "events", date: string): Promise<RunResult> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), context.timeoutMs);
  const signal = AbortSignal.any([context.signal, timeout.signal]);
  try {
    const response = await context.fetchImpl(RUN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${context.pomeradoApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tool_id: TOOL_ID,
        input: {
          city: context.city.bookMyShowCity,
          date,
          kind,
          limit: PAGE_LIMIT,
        },
      }),
      signal,
    });
    if (!response.ok) return { ok: false, message: `BookMyShow is unavailable. HTTP ${response.status}` };
    let job = (await response.json()) as unknown;
    const deadline = Date.now() + context.timeoutMs;
    while (isPending(job) && Date.now() < deadline) {
      await wait(2_000, signal);
      job = await readJob(jobId(job), context, signal);
    }
    return readResult(job, context, signal);
  } catch {
    if (context.signal.aborted) return { ok: false, message: "Search stopped." };
    if (timeout.signal.aborted) return { ok: false, message: "BookMyShow is unavailable. The source timed out." };
    return { ok: false, message: "BookMyShow could not be reached." };
  } finally {
    clearTimeout(timer);
  }
}

async function readJob(id: string | null, context: ToolContext, signal: AbortSignal): Promise<unknown> {
  if (id == null) return { status: "failed", message: "BookMyShow returned no job." };
  const response = await context.fetchImpl(`https://api.pomerado.ai/v1/jobs/${id}`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${context.pomeradoApiKey}`,
    },
    signal,
  });
  if (!response.ok) return { status: "failed", message: `BookMyShow is unavailable. HTTP ${response.status}` };
  return response.json() as Promise<unknown>;
}

async function readResult(job: unknown, context: ToolContext, signal: AbortSignal): Promise<RunResult> {
  if (!job || typeof job !== "object") return { ok: false, message: "BookMyShow returned an unreadable result." };
  const record = job as Record<string, unknown>;
  switch (record.status) {
    case "succeeded":
      return succeeded(record, context, signal);
    case "needs_input":
      return { ok: false, message: needsInput(record) };
    case "queued":
    case "running":
    case "paused":
      return { ok: false, message: "BookMyShow is unavailable. The source timed out." };
    case "failed":
    case "cancelled":
      return { ok: false, message: `BookMyShow is unavailable. ${errorText(record)}` };
    default:
      return { ok: false, message: `BookMyShow is unavailable. ${errorText(record)}` };
  }
}

async function succeeded(record: Record<string, unknown>, context: ToolContext, signal: AbortSignal): Promise<RunResult> {
  if (record.result && typeof record.result === "object") return { ok: true, payload: record.result };
  const file = record.result_file;
  if (!file || typeof file !== "object") return { ok: false, message: "BookMyShow returned no listings." };
  const download = (file as Record<string, unknown>).download_url;
  if (typeof download !== "string" || !download.startsWith("https://")) {
    return { ok: false, message: "BookMyShow returned no listings." };
  }
  const response = await context.fetchImpl(download, { headers: { accept: "application/json" }, signal });
  if (!response.ok) return { ok: false, message: `BookMyShow is unavailable. HTTP ${response.status}` };
  return { ok: true, payload: (await response.json()) as unknown };
}

function needsInput(record: Record<string, unknown>): string {
  const request = record.input_request;
  const answer = request && typeof request === "object" ? (request as Record<string, unknown>).answer_url : null;
  const link = typeof answer === "string" ? answer : typeof record.watch_url === "string" ? record.watch_url : "";
  return link.length > 0 ? `BookMyShow needs an answer at ${link}` : "BookMyShow needs an answer before it can continue.";
}

function errorText(record: Record<string, unknown>): string {
  const error = record.error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim().length > 0) return message.trim();
  }
  if (typeof record.message === "string" && record.message.trim().length > 0) return record.message.trim();
  return "The search did not finish.";
}

function isPending(job: unknown): boolean {
  if (!job || typeof job !== "object") return false;
  const status = (job as Record<string, unknown>).status;
  return status === "queued" || status === "running";
}

function jobId(job: unknown): string | null {
  if (!job || typeof job !== "object") return null;
  const id = (job as Record<string, unknown>).id;
  return typeof id === "string" && /^job_[0-9a-f]{32}$/.test(id) ? id : null;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function wantsMovies(kind: EventKind | null): boolean {
  return kind == null || kind === "movie";
}

function wantsEvents(kind: EventKind | null): boolean {
  if (kind == null) return true;
  switch (kind) {
    case "movie":
      return false;
    case "comedy":
    case "concert":
    case "theatre":
    case "workshop":
    case "other":
      return true;
    default: {
      const neverKind: never = kind;
      return neverKind;
    }
  }
}

export function bookMyShowListings(payload: unknown, retrievedAt: string, cityName: string): Listing[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const rows = Array.isArray(record.listings) ? record.listings : [];
  const city = typeof record.applied_city === "string" && record.applied_city.trim().length > 0 ? record.applied_city.trim() : cityName;
  const listings: Listing[] = [];
  for (const row of rows) {
    const listing = readListing(row, retrievedAt, city);
    if (listing) listings.push(listing);
  }
  return listings;
}

function readListing(row: unknown, retrievedAt: string, city: string): Listing | null {
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  if (typeof record.title !== "string" || record.title.trim().length === 0) return null;
  if (typeof record.detail_url !== "string" || !isListingUrl(record.detail_url, "BookMyShow")) return null;
  if (typeof record.id !== "string" || record.id.trim().length === 0) return null;
  const kind = record.kind === "movies" ? "movie" : kindFromText(`${record.title} ${textList(record.genres)} ${typeof record.category === "string" ? record.category : ""}`);
  const show = earliestShow(record.venues);
  const category = typeof record.category === "string" && record.category.trim().length > 0
    ? record.category.trim()
    : typeof record.certificate === "string" && record.certificate.trim().length > 0
      ? record.certificate.trim()
      : null;
  return {
    id: `bookmyshow:${record.id}`,
    sourceId: record.id,
    platform: "BookMyShow",
    title: record.title.trim(),
    kind,
    posterUrl: httpsUrl(record.poster_url),
    start: show.start,
    end: null,
    timezone: "Asia/Kolkata",
    city,
    venue: show.venue,
    lat: null,
    lon: null,
    price: readPrice(record.advertised_price, show.amounts),
    url: record.detail_url,
    retrievedAt,
    category,
    driveMinutes: null,
  };
}

function earliestShow(value: unknown): { start: string | null; venue: string | null; amounts: number[] } {
  if (!Array.isArray(value)) return { start: null, venue: null, amounts: [] };
  let start: string | null = null;
  let venue: string | null = null;
  const amounts: number[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const place = entry as Record<string, unknown>;
    const name = typeof place.name === "string" && place.name.trim().length > 0 ? place.name.trim() : null;
    const showtimes = Array.isArray(place.showtimes) ? place.showtimes : [];
    if (venue == null && name != null) venue = name;
    for (const show of showtimes) {
      if (!show || typeof show !== "object") continue;
      const time = (show as Record<string, unknown>).starts_at;
      if (typeof time === "string" && (start == null || time < start)) {
        start = time;
        if (name != null) venue = name;
      }
      const prices = (show as Record<string, unknown>).prices;
      if (!Array.isArray(prices)) continue;
      for (const price of prices) amounts.push(...readMinor(price));
    }
  }
  return { start, venue, amounts };
}

function readPrice(advertised: unknown, showAmounts: number[]): ListingPrice {
  const advertisedMinor = readMinor(advertised);
  const amounts = [...advertisedMinor, ...showAmounts].filter((amount) => Number.isFinite(amount) && amount >= 0);
  if (amounts.length === 0) return unknownPrice();
  const min = Math.min(...amounts) / 100;
  const max = Math.max(...amounts) / 100;
  return priceFromAmount(min, max > min ? max : null);
}

function readMinor(value: unknown): number[] {
  if (!value || typeof value !== "object") return [];
  const amount = (value as Record<string, unknown>).amount_minor;
  return typeof amount === "number" && Number.isFinite(amount) ? [amount] : [];
}

function textList(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.filter((item) => typeof item === "string").join(" ");
}
