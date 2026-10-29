import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentId } from "../../shared/hosts.ts";
import type { ChatLine } from "../chatMemory.ts";

const USER_ID = /^[a-f0-9]{32}$/;
const LINE_LIMIT = 24;

export class UserMemoryStore {
  constructor(private readonly root: string) {}

  lines(userId: string, agent: AgentId): ChatLine[] {
    const db = this.open(userId);
    try {
      const rows = db.prepare(
        "SELECT role, text FROM turns WHERE agent = ? ORDER BY id DESC LIMIT ?",
      ).all(agent, LINE_LIMIT) as { role: string; text: string }[];
      return rows.reverse().flatMap((row) => {
        if (row.role !== "user" && row.role !== "assistant") return [];
        return [{ role: row.role, text: row.text }];
      });
    } finally {
      db.close();
    }
  }

  append(userId: string, agent: AgentId, role: ChatLine["role"], text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const db = this.open(userId);
    try {
      db.prepare("INSERT INTO turns (agent, role, text, created_at) VALUES (?, ?, ?, ?)").run(
        agent,
        role,
        trimmed,
        Date.now(),
      );
    } finally {
      db.close();
    }
  }

  private open(userId: string): DatabaseSync {
    if (!USER_ID.test(userId)) throw new Error("A user id is 32 hex characters.");
    const dir = join(this.root, userId);
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "memory.sqlite"));
    db.exec(`CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    return db;
  }
}
