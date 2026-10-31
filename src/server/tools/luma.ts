import type { Listing } from "../../shared/event.ts";
import { listingsFromHtml } from "../events/htmlListings.ts";
import { plainGet } from "../events/http.ts";
import { lumaEvents } from "../events/luma.ts";
import type { EventTool, ToolContext, ToolResult } from "./types.ts";

export const lumaTool: EventTool = {
  name: "Luma",
  load(context) {
    return loadLuma(context);
  },
};

async function loadLuma(context: ToolContext): Promise<ToolResult> {
  const key = `luma|${context.city.id}`;
  const cached = context.cache.get(key);
  if (cached) return ready("Cached Luma listings.", cached);
  const url = `https://api.luma.com/discover/get-paginated-events?slug=${encodeURIComponent(context.city.lumaSlug)}&pagination_limit=20`;
  const response = await plainGet(url, "application/json", context.timeoutMs, context.signal, context.fetchImpl);
  if (!response.ok) return loadLumaPage(context, `Luma is unavailable. ${response.message}`);
  let payload: unknown;
  try {
    payload = JSON.parse(response.body) as unknown;
  } catch {
    return failed("Luma returned an unreadable list.");
  }
  const listings = lumaEvents(payload, context.retrievedAt);
  context.cache.set(key, listings);
  return ready("Luma listings loaded.", listings);
}

async function loadLumaPage(context: ToolContext, failure: string): Promise<ToolResult> {
  if (!context.readPage) return failed(failure);
  const url = `https://luma.com/${encodeURIComponent(context.city.lumaSlug)}`;
  const read = await context.readPage(url);
  if (!read.ok) return failed(read.message);
  const listings = listingsFromHtml(read.html, "Luma", context.city.name, context.retrievedAt);
  if (listings.length === 0) return failed(failure);
  context.cache.set(`luma|${context.city.id}`, listings);
  return ready("Luma listings loaded.", listings);
}

function ready(message: string, listings: Listing[]): ToolResult {
  return { name: "Luma", ok: true, message, listings, warnings: [] };
}

function failed(message: string): ToolResult {
  return { name: "Luma", ok: false, message, listings: [], warnings: [] };
}
