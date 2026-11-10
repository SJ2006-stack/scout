import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { vaultMarkdownError } from "../../shared/vault.ts";

export type VaultPage = { markdown: string; updatedAt: number };
export type VaultWrite = { ok: true; page: VaultPage } | { ok: false; error: string };

/** One markdown Vault per person. The signed-in user writes it. Scout only reads it. */
export class VaultStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 3000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS user_vault (
      user_id TEXT PRIMARY KEY,
      markdown TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }

  read(userId: string): VaultPage | null {
    const row = this.db.prepare("SELECT markdown, updated_at FROM user_vault WHERE user_id = ?").get(userId) as { markdown: string; updated_at: number } | undefined;
    if (!row || row.markdown.length === 0) return null;
    return { markdown: row.markdown, updatedAt: row.updated_at };
  }

  write(userId: string, raw: string, now: number): VaultWrite {
    const error = vaultMarkdownError(raw);
    if (error) return { ok: false, error };
    const markdown = raw.trim();
    if (markdown.length === 0) {
      this.db.prepare("DELETE FROM user_vault WHERE user_id = ?").run(userId);
      return { ok: true, page: { markdown: "", updatedAt: now } };
    }
    this.db.prepare(
      "INSERT INTO user_vault (user_id, markdown, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET markdown = excluded.markdown, updated_at = excluded.updated_at",
    ).run(userId, markdown, now);
    return { ok: true, page: { markdown, updatedAt: now } };
  }
}
