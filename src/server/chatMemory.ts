import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EventKind } from "../shared/event.ts";
import type { WhenWindow } from "../shared/when.ts";

export type ChatLine = {
  role: "user" | "assistant";
  text: string;
};

export type FoundEvent = { title: string; url: string };

export type ChatMemory = {
  cityId: string | null;
  lat: number | null;
  lon: number | null;
  budget: number | null;
  date: WhenWindow;
  kind: EventKind | null;
  timezone: string;
  lines: ChatLine[];
  found: FoundEvent[];
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
    found: [],
  };
}

export class ChatMemoryStore {
  private readonly rows = new Map<string, ChatMemory>();
  private readonly db: DatabaseSync | null;

  constructor(path?: string) {
    if (!path) {
      this.db = null;
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("CREATE TABLE IF NOT EXISTS chat_memory (id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  }

  get(id: string): ChatMemory {
    const cached = this.rows.get(id);
    if (cached) return cached;
    const stored = this.load(id);
    if (stored) this.rows.set(id, stored);
    return stored ?? emptyMemory();
  }

  save(id: string, memory: ChatMemory): void {
    this.rows.set(id, memory);
    this.db?.prepare(
      "INSERT INTO chat_memory (id, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
    ).run(id, JSON.stringify(memory), Date.now());
  }

  private load(id: string): ChatMemory | null {
    if (!this.db) return null;
    const row = this.db.prepare("SELECT body FROM chat_memory WHERE id = ?").get(id) as { body?: unknown } | undefined;
    if (typeof row?.body !== "string") return null;
    try {
      return { ...emptyMemory(), ...(JSON.parse(row.body) as Partial<ChatMemory>) };
    } catch {
      return null;
    }
  }
}
