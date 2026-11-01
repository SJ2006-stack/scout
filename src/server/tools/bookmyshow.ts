import type { EventKind, Listing } from "../../shared/event.ts";
import { bookMyShowExploreUrl, bookMyShowPageListings } from "../events/bookmyshow.ts";
import type { EventTool, ToolContext, ToolResult } from "./types.ts";

export const bookMyShowTool: EventTool = {
  name: "BookMyShow",
  load(context) {
    return loadBookMyShow(context);
  },
};

type Part = { ok: true; listings: Listing[] } | { ok: false; message: string; listings: [] };

/**
 * Reads BookMyShow's explore pages in the browser worker. BookMyShow blocks
 * datacenter addresses, so the worker sends these through the user's phone relay
 * when it is connected and tries Azure's own address otherwise.
 */
async function loadBookMyShow(context: ToolContext): Promise<ToolResult> {
  if (!context.readPage) {
    return { name: "BookMyShow", ok: false, message: "BookMyShow needs the browser worker, which is off on this server.", listings: [], warnings: [] };
  }
  const kinds: ("movies" | "events")[] = [];
  if (wantsMovies(context.kind)) kinds.push("movies");
  if (wantsEvents(context.kind)) kinds.push("events");
  const parts = await Promise.all(kinds.map((kind) => loadKind(context, kind)));
  const listings = parts.flatMap((part) => part.listings);
  const warnings = parts.flatMap((part) => (part.ok ? [] : [part.message]));
  if (listings.length === 0 && warnings.length > 0) {
    return { name: "BookMyShow", ok: false, message: warnings[0] ?? "BookMyShow is unavailable.", listings: [], warnings: warnings.slice(1) };
  }
  return { name: "BookMyShow", ok: true, message: "BookMyShow listings loaded.", listings, warnings };
}

async function loadKind(context: ToolContext, kind: "movies" | "events"): Promise<Part> {
  const key = `bookmyshow|${context.city.id}|${kind}`;
  const cached = context.cache.get(key);
  if (cached) return { ok: true, listings: cached };
  const read = await context.readPage?.(bookMyShowExploreUrl(kind, context.city.bookMyShowSlug));
  if (!read) return { ok: false, message: "BookMyShow needs the browser worker.", listings: [] };
  if (!read.ok) return { ok: false, message: `BookMyShow ${kind} are unavailable. ${read.message}`, listings: [] };
  const listings = bookMyShowPageListings(read.html, context.city.name, context.retrievedAt);
  if (listings.length === 0) {
    const blocked = /attention required|cloudflare|access denied/i.test(read.html);
    return { ok: false, message: blocked ? `BookMyShow blocked the ${kind} page. Open the app so Scout can read it through your phone.` : `BookMyShow showed no ${kind}.`, listings: [] };
  }
  context.cache.set(key, listings);
  return { ok: true, listings };
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
