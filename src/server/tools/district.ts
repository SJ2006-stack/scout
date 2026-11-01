import type { Listing } from "../../shared/event.ts";
import { districtEvents, districtMovies } from "../events/district.ts";
import { plainGet } from "../events/http.ts";
import type { EventTool, ToolContext, ToolResult } from "./types.ts";

export const districtTool: EventTool = {
  name: "District",
  load(context) {
    return loadDistrict(context);
  },
};

async function loadDistrict(context: ToolContext): Promise<ToolResult> {
  const [events, movies] = await Promise.all([
    loadEvents(context),
    loadMovies(context),
  ]);
  const warnings = [events, movies].flatMap((part) => (part.ok ? [] : [part.message]));
  const listings = [events, movies].flatMap((part) => part.listings);
  if (listings.length === 0 && warnings.length > 0) {
    return { name: "District", ok: false, message: warnings[0] ?? "District is unavailable.", listings: [], warnings: warnings.slice(1) };
  }
  const loaded = [events, movies].filter((part) => part.ok).map((part) => part.message);
  return {
    name: "District",
    ok: true,
    message: loaded.join(" ") || "District listings loaded.",
    listings,
    warnings,
  };
}

type Part = { ok: true; message: string; listings: Listing[] } | { ok: false; message: string; listings: [] };

async function loadEvents(context: ToolContext): Promise<Part> {
  const key = `district-events|${context.city.id}`;
  const cached = context.cache.get(key);
  if (cached) return { ok: true, message: "Cached District events.", listings: cached };
  const read = await districtRead(context, "https://www.district.in/events/", (html) => districtEvents(html, context.city, context.retrievedAt));
  if (!read.ok) return { ok: false, message: `District events are unavailable. ${read.message}`, listings: [] };
  if (read.listings.length > 0) context.cache.set(key, read.listings);
  return { ok: true, message: "District events loaded.", listings: read.listings };
}

async function loadMovies(context: ToolContext): Promise<Part> {
  const key = "district-movies";
  const cached = context.cache.get(key);
  if (cached) return { ok: true, message: "Cached District movies.", listings: cached };
  const read = await districtRead(context, "https://www.district.in/movies/", (html) => districtMovies(html, context.retrievedAt));
  if (!read.ok) return { ok: false, message: `District movies are unavailable. ${read.message}`, listings: [] };
  if (read.listings.length > 0) context.cache.set(key, read.listings);
  return { ok: true, message: "District movies loaded.", listings: read.listings };
}

/**
 * The plain request first. District answers datacenter addresses with a 403 or a
 * page without listings, so either falls back to the browser worker, which goes
 * through the user's phone when it is connected.
 */
async function districtRead(context: ToolContext, url: string, parse: (html: string) => Listing[]): Promise<{ ok: true; listings: Listing[] } | { ok: false; message: string }> {
  const response = await plainGet(url, "text/html", context.timeoutMs, context.signal, context.fetchImpl);
  const plain = response.ok ? parse(response.body) : [];
  if (plain.length > 0 || !context.readPage) return response.ok ? { ok: true, listings: plain } : { ok: false, message: response.message };
  const read = await context.readPage(url);
  if (!read.ok) return response.ok ? { ok: true, listings: [] } : { ok: false, message: read.message };
  return { ok: true, listings: parse(read.html) };
}
