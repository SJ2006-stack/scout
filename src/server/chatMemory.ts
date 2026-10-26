import type { EventKind } from "../shared/event.ts";
import type { DatePhrase } from "../shared/when.ts";

export type ChatLine = {
  role: "user" | "assistant";
  text: string;
};

export type ChatMemory = {
  cityId: string | null;
  lat: number | null;
  lon: number | null;
  budget: number | null;
  date: DatePhrase;
  kind: EventKind | null;
  timezone: string;
  lines: ChatLine[];
};

export function emptyMemory(): ChatMemory {
  return {
    cityId: null,
    lat: null,
    lon: null,
    budget: null,
    date: "week",
    kind: null,
    timezone: "Asia/Kolkata",
    lines: [],
  };
}

export class ChatMemoryStore {
  private readonly rows = new Map<string, ChatMemory>();

  get(id: string): ChatMemory {
    return this.rows.get(id) ?? emptyMemory();
  }

  save(id: string, memory: ChatMemory): void {
    this.rows.set(id, memory);
  }
}
