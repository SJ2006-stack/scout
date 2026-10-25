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
  const response = await plainGet("https://www.district.in/events/", "text/html", context.timeoutMs, context.signal, context.fetchImpl);
  if (!response.ok) return { ok: false, message: `District events are unavailable. ${response.message}`, listings: [] };
  const listings = districtEvents(response.body, context.city, context.retrievedAt);
  context.cache.set(key, listings);
  return { ok: true, message: "District events loaded.", listings };
}

async function loadMovies(context: ToolContext): Promise<Part> {
  const key = "district-movies";
  const cached = context.cache.get(key);
  if (cached) return { ok: true, message: "Cached District movies.", listings: cached };
  const response = await plainGet("https://www.district.in/movies/", "text/html", context.timeoutMs, context.signal, context.fetchImpl);
  if (!response.ok) return { ok: false, message: `District movies are unavailable. ${response.message}`, listings: [] };
  const listings = districtMovies(response.body, context.retrievedAt);
  context.cache.set(key, listings);
  return { ok: true, message: "District movies loaded.", listings };
}
