import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentId } from "../../shared/hosts.ts";

export type InboxItem = {
  id: string;
  agent: AgentId;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  createdAt: number;
  readAt: number | null;
};

export type DeviceRow = { deviceId: string; pushToken: string; platform: string; updatedAt: number };

const INBOX_LIMIT = 50;
const TOKEN = /^[A-Za-z0-9_:\-.]{20,4096}$/;
const DEVICE = /^[A-Za-z0-9_\-.]{1,128}$/;

export class InboxStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 3000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS inbox_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      url TEXT,
      created_at INTEGER NOT NULL,
      read_at INTEGER
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS inbox_user ON inbox_items (user_id, created_at)");
    this.db.exec(`CREATE TABLE IF NOT EXISTS push_devices (
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      push_token TEXT NOT NULL,
      platform TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, device_id)
    )`);
  }

  add(userId: string, item: Omit<InboxItem, "id" | "createdAt" | "readAt">, now: number): InboxItem {
    const id = randomBytes(12).toString("hex");
    this.db.prepare(
      "INSERT INTO inbox_items (id, user_id, agent, kind, title, body, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, userId, item.agent, item.kind, item.title, item.body, item.url, now);
    return { ...item, id, createdAt: now, readAt: null };
  }

  list(userId: string): InboxItem[] {
    const rows = this.db.prepare(
      "SELECT id, agent, kind, title, body, url, created_at, read_at FROM inbox_items WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
    ).all(userId, INBOX_LIMIT) as { id: string; agent: AgentId; kind: string; title: string; body: string; url: string | null; created_at: number; read_at: number | null }[];
    return rows.map((row) => ({
      id: row.id,
      agent: row.agent,
      kind: row.kind,
      title: row.title,
      body: row.body,
      url: row.url,
      createdAt: row.created_at,
      readAt: row.read_at,
    }));
  }

  markRead(userId: string, id: string, now: number): boolean {
    return Number(this.db.prepare("UPDATE inbox_items SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL").run(now, userId, id).changes) > 0;
  }

  saveDevice(userId: string, deviceId: string, pushToken: string, platform: string, now: number): boolean {
    if (!DEVICE.test(deviceId) || !TOKEN.test(pushToken)) return false;
    this.db.prepare(
      "INSERT INTO push_devices (user_id, device_id, push_token, platform, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, device_id) DO UPDATE SET push_token = excluded.push_token, platform = excluded.platform, updated_at = excluded.updated_at",
    ).run(userId, deviceId, pushToken, platform === "android" ? "android" : "web", now);
    return true;
  }

  devices(userId: string): DeviceRow[] {
    const rows = this.db.prepare(
      "SELECT device_id, push_token, platform, updated_at FROM push_devices WHERE user_id = ?",
    ).all(userId) as { device_id: string; push_token: string; platform: string; updated_at: number }[];
    return rows.map((row) => ({ deviceId: row.device_id, pushToken: row.push_token, platform: row.platform, updatedAt: row.updated_at }));
  }

  dropToken(pushToken: string): void {
    this.db.prepare("DELETE FROM push_devices WHERE push_token = ?").run(pushToken);
  }
}
