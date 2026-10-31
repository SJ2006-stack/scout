import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cityById } from "../../shared/cities.ts";
import type { EventKind } from "../../shared/event.ts";

export type WatchWhen = "today" | "tomorrow" | "weekend" | "week";
export type WatchStatus = "active" | "paused";

export type EventWatch = {
  id: string;
  userId: string;
  cityId: string;
  kind: EventKind | null;
  when: WatchWhen;
  budget: number | null;
  query: string;
  status: WatchStatus;
  intervalMinutes: number;
  nextRunAt: number;
  lastCheckedAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  hits: number;
  createdAt: number;
};

export type WatchDraft = { cityId: string; kind: EventKind | null; when: WatchWhen; budget: number | null; query: string; intervalMinutes?: number };
export type WatchPatch = Partial<Pick<EventWatch, "status" | "budget" | "kind" | "when" | "intervalMinutes">>;

export const WATCH_MIN_INTERVAL = 30;
export const WATCH_DEFAULT_INTERVAL = 120;
const WATCH_MAX_INTERVAL = 24 * 60;
const WATCH_PER_USER = 10;
const LEASE_MS = 10 * 60_000;
const KINDS: readonly EventKind[] = ["movie", "concert", "comedy", "theatre", "workshop", "other"];

type Row = {
  id: string;
  user_id: string;
  city_id: string;
  kind: string | null;
  when_word: string;
  budget: number | null;
  query: string;
  status: string;
  interval_minutes: number;
  next_run_at: number;
  last_checked_at: number | null;
  last_ok_at: number | null;
  last_error: string | null;
  hits: number;
  created_at: number;
};

export function isWatchWhen(value: unknown): value is WatchWhen {
  return value === "today" || value === "tomorrow" || value === "weekend" || value === "week";
}

export function isEventKind(value: unknown): value is EventKind {
  return typeof value === "string" && KINDS.some((kind) => kind === value);
}

export function watchDraftError(draft: WatchDraft): string | null {
  if (!cityById(draft.cityId)) return "Watches cover Bengaluru, Mumbai, Delhi, and Hyderabad.";
  if (!isWatchWhen(draft.when)) return "A watch looks at today, tomorrow, the weekend, or the week.";
  if (draft.kind != null && !isEventKind(draft.kind)) return "That event type is not one Scout can watch.";
  if (draft.budget != null && (!Number.isInteger(draft.budget) || draft.budget < 0 || draft.budget > 1_000_000)) return "A budget is a whole rupee amount.";
  return null;
}

export class WatchStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 3000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS event_watches (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      city_id TEXT NOT NULL,
      kind TEXT,
      when_word TEXT NOT NULL,
      budget INTEGER,
      query TEXT NOT NULL,
      status TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      next_run_at INTEGER NOT NULL,
      last_checked_at INTEGER,
      last_ok_at INTEGER,
      last_error TEXT,
      hits INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS event_watches_due ON event_watches (status, next_run_at)");
    this.db.exec(`CREATE TABLE IF NOT EXISTS event_watch_seen (
      watch_id TEXT NOT NULL,
      url TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      PRIMARY KEY (watch_id, url)
    )`);
  }

  create(userId: string, draft: WatchDraft, now: number): { ok: true; watch: EventWatch } | { ok: false; error: string } {
    const error = watchDraftError(draft);
    if (error) return { ok: false, error };
    if (this.list(userId).length >= WATCH_PER_USER) return { ok: false, error: `Keep up to ${WATCH_PER_USER} watches. Delete one first.` };
    const id = randomBytes(12).toString("hex");
    const interval = clampInterval(draft.intervalMinutes ?? WATCH_DEFAULT_INTERVAL);
    this.db.prepare(
      "INSERT INTO event_watches (id, user_id, city_id, kind, when_word, budget, query, status, interval_minutes, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)",
    ).run(id, userId, draft.cityId, draft.kind, draft.when, draft.budget, draft.query.trim().slice(0, 200), interval, now, now);
    const watch = this.get(userId, id);
    return watch ? { ok: true, watch } : { ok: false, error: "The watch could not be saved." };
  }

  get(userId: string, id: string): EventWatch | null {
    const row = this.db.prepare("SELECT * FROM event_watches WHERE user_id = ? AND id = ?").get(userId, id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  list(userId: string): EventWatch[] {
    const rows = this.db.prepare("SELECT * FROM event_watches WHERE user_id = ? ORDER BY created_at DESC").all(userId) as Row[];
    return rows.map(fromRow);
  }

  update(userId: string, id: string, patch: WatchPatch, now: number): { ok: true; watch: EventWatch } | { ok: false; error: string } {
    const current = this.get(userId, id);
    if (!current) return { ok: false, error: "That watch is gone." };
    const next = { ...current, ...patch };
    const error = watchDraftError({ cityId: next.cityId, kind: next.kind, when: next.when, budget: next.budget, query: next.query });
    if (error) return { ok: false, error };
    if (next.status !== "active" && next.status !== "paused") return { ok: false, error: "A watch is active or paused." };
    const resumed = current.status === "paused" && next.status === "active";
    this.db.prepare(
      "UPDATE event_watches SET kind = ?, when_word = ?, budget = ?, status = ?, interval_minutes = ?, next_run_at = ? WHERE user_id = ? AND id = ?",
    ).run(next.kind, next.when, next.budget, next.status, clampInterval(next.intervalMinutes), resumed ? now : current.nextRunAt, userId, id);
    const watch = this.get(userId, id);
    return watch ? { ok: true, watch } : { ok: false, error: "That watch is gone." };
  }

  remove(userId: string, id: string): boolean {
    const removed = Number(this.db.prepare("DELETE FROM event_watches WHERE user_id = ? AND id = ?").run(userId, id).changes) > 0;
    if (removed) this.db.prepare("DELETE FROM event_watch_seen WHERE watch_id = ?").run(id);
    return removed;
  }

  claimDue(now: number, limit: number): EventWatch[] {
    const rows = this.db.prepare(
      "SELECT * FROM event_watches WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at LIMIT ?",
    ).all(now, limit) as Row[];
    const claimed: EventWatch[] = [];
    for (const row of rows) {
      const leased = this.db.prepare(
        "UPDATE event_watches SET next_run_at = ? WHERE id = ? AND next_run_at = ? AND status = 'active'",
      ).run(now + LEASE_MS, row.id, row.next_run_at);
      if (Number(leased.changes) === 1) claimed.push(fromRow(row));
    }
    return claimed;
  }

  finish(id: string, now: number, outcome: { ok: true; newHits: number } | { ok: false; error: string }): void {
    const row = this.db.prepare("SELECT interval_minutes FROM event_watches WHERE id = ?").get(id) as { interval_minutes?: number } | undefined;
    if (!row?.interval_minutes) return;
    const next = now + row.interval_minutes * 60_000;
    if (outcome.ok) {
      this.db.prepare(
        "UPDATE event_watches SET next_run_at = ?, last_checked_at = ?, last_ok_at = ?, last_error = NULL, hits = hits + ? WHERE id = ?",
      ).run(next, now, now, outcome.newHits, id);
      return;
    }
    this.db.prepare("UPDATE event_watches SET next_run_at = ?, last_checked_at = ?, last_error = ? WHERE id = ?").run(next, now, outcome.error.slice(0, 200), id);
  }

  unseen(watchId: string, urls: readonly string[], now: number): string[] {
    const fresh: string[] = [];
    const insert = this.db.prepare("INSERT OR IGNORE INTO event_watch_seen (watch_id, url, seen_at) VALUES (?, ?, ?)");
    for (const url of urls) {
      if (Number(insert.run(watchId, url, now).changes) === 1) fresh.push(url);
    }
    return fresh;
  }
}

function clampInterval(minutes: number): number {
  if (!Number.isFinite(minutes)) return WATCH_DEFAULT_INTERVAL;
  return Math.min(WATCH_MAX_INTERVAL, Math.max(WATCH_MIN_INTERVAL, Math.round(minutes)));
}

function fromRow(row: Row): EventWatch {
  return {
    id: row.id,
    userId: row.user_id,
    cityId: row.city_id,
    kind: isEventKind(row.kind) ? row.kind : null,
    when: isWatchWhen(row.when_word) ? row.when_word : "weekend",
    budget: row.budget,
    query: row.query,
    status: row.status === "paused" ? "paused" : "active",
    intervalMinutes: row.interval_minutes,
    nextRunAt: row.next_run_at,
    lastCheckedAt: row.last_checked_at,
    lastOkAt: row.last_ok_at,
    lastError: row.last_error,
    hits: row.hits,
    createdAt: row.created_at,
  };
}
