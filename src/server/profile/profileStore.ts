import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const PROFILE_KEYS = [
  "name",
  "city",
  "home_area",
  "language",
  "event_kinds",
  "budget_rupees",
  "grocery_brands",
  "diet",
  "services",
  "communication",
  "routine",
] as const;

export type ProfileKey = (typeof PROFILE_KEYS)[number];
export type ProfileSource = "explicit" | "inferred";
export type ProfileEntry = { key: ProfileKey; value: string; source: ProfileSource; updatedAt: number };
export type ProfileWrite = { ok: true; entry: ProfileEntry } | { ok: false; error: string };

const VALUE_LIMIT = 160;
const SECRET_WORDS = /\b(otp|one[- ]time|pin|upi ?pin|password|passcode|passwd|cvv|cvc|card number|secret|token|aadhaar|pan number)\b/i;
const LONG_DIGITS = /\d{9,}/;

export function isProfileKey(value: unknown): value is ProfileKey {
  return typeof value === "string" && (PROFILE_KEYS as readonly string[]).includes(value);
}

export function profileValueError(key: ProfileKey, raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return "A preference needs a value.";
  if (value.length > VALUE_LIMIT) return `Keep a preference under ${VALUE_LIMIT} characters.`;
  if (SECRET_WORDS.test(value)) return "Scout does not keep codes, PINs, or passwords in memory.";
  if (LONG_DIGITS.test(value.replace(/[\s-]/g, ""))) return "Scout does not keep long numbers like card or account numbers in memory.";
  if (key === "budget_rupees" && !/^\d{1,6}$/.test(value)) return "A budget is a whole rupee amount.";
  return null;
}

export class ProfileStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 3000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS profile_entries (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      source TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, key)
    )`);
  }

  list(userId: string): ProfileEntry[] {
    const rows = this.db.prepare(
      "SELECT key, value, source, updated_at FROM profile_entries WHERE user_id = ? ORDER BY key",
    ).all(userId) as { key: string; value: string; source: string; updated_at: number }[];
    return rows.flatMap((row) => {
      if (!isProfileKey(row.key) || (row.source !== "explicit" && row.source !== "inferred")) return [];
      return [{ key: row.key, value: row.value, source: row.source, updatedAt: row.updated_at }];
    });
  }

  get(userId: string, key: ProfileKey): ProfileEntry | null {
    return this.list(userId).find((entry) => entry.key === key) ?? null;
  }

  set(userId: string, key: ProfileKey, raw: string, source: ProfileSource, now: number): ProfileWrite {
    const error = profileValueError(key, raw);
    if (error) return { ok: false, error };
    const existing = this.get(userId, key);
    if (source === "inferred" && existing?.source === "explicit") return { ok: true, entry: existing };
    const value = raw.trim();
    this.db.prepare(
      "INSERT INTO profile_entries (user_id, key, value, source, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at",
    ).run(userId, key, value, source, now);
    return { ok: true, entry: { key, value, source, updatedAt: now } };
  }

  remove(userId: string, key: ProfileKey): boolean {
    return Number(this.db.prepare("DELETE FROM profile_entries WHERE user_id = ? AND key = ?").run(userId, key).changes) > 0;
  }

  clear(userId: string): void {
    this.db.prepare("DELETE FROM profile_entries WHERE user_id = ?").run(userId);
  }
}

export function profilePrompt(entries: readonly ProfileEntry[]): string {
  if (entries.length === 0) return "No saved preferences yet. When they state a lasting preference, call remember_preference.";
  const explicit = entries.filter((entry) => entry.source === "explicit").map((entry) => `${entry.key}=${entry.value}`);
  const inferred = entries.filter((entry) => entry.source === "inferred").map((entry) => `${entry.key}=${entry.value}`);
  const parts = [];
  if (explicit.length > 0) parts.push(`Preferences they set: ${explicit.join("; ")}. Use these instead of asking again.`);
  if (inferred.length > 0) parts.push(`Guesses from earlier chats: ${inferred.join("; ")}. Use them as defaults and say so briefly.`);
  parts.push("When they state a lasting preference, call remember_preference. When they ask you to forget one, call forget_preference.");
  return parts.join(" ");
}
