import type { City } from "../../shared/cities.ts";
import type { EventKind, Listing } from "../../shared/event.ts";
import type { DateRange } from "../../shared/when.ts";
import type { ListingCache } from "../listingCache.ts";

export type ToolName = "Luma" | "District" | "BookMyShow";

export type ToolContext = {
  city: City;
  range: DateRange;
  kind: EventKind | null;
  timezone: string;
  retrievedAt: string;
  timeoutMs: number;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
  cache: ListingCache;
  pomeradoApiKey: string;
};

export type ToolResult = {
  name: ToolName;
  ok: boolean;
  message: string;
  listings: Listing[];
  warnings: string[];
};

export type EventTool = {
  name: ToolName;
  load(context: ToolContext): Promise<ToolResult>;
};
