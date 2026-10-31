import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import type { ProfileState } from "../../shared/browser.ts";
import type { ProfileStatus } from "../browser/profileVault.ts";

const USER_ID = /^[a-f0-9]{32}$/;

export type BrowserLink = {
  id: string;
  taskId: string;
  ownerId: string;
  status: string;
  url: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

export type StoredUser = {
  id: string;
  createdAt: number;
  lastSeenAt: number;
};

export type StoredBrowser = BrowserLink & {
  profileState: ProfileState;
  profileExpiresAt: number | null;
};

export class UserDirectory {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        email TEXT
      );
      CREATE TABLE IF NOT EXISTS browser_profiles (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        state TEXT NOT NULL,
        expires_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS browsers (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS login_codes (
        email TEXT PRIMARY KEY,
        salt TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL
      );
    `);
    try {
      this.db.exec("ALTER TABLE users ADD COLUMN email TEXT");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!message.includes("duplicate column")) throw error;
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email) WHERE email IS NOT NULL");
    addColumn(this.db, "users", "phone", "TEXT");
    addColumn(this.db, "users", "preferred_name", "TEXT");
    addColumn(this.db, "users", "phone_verified_at", "INTEGER");
  }

  touch(userId: string, now: number): void {
    if (!USER_ID.test(userId)) return;
    this.db.prepare(
      `INSERT INTO users (id, created_at, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen_at = MAX(users.last_seen_at, excluded.last_seen_at)`,
    ).run(userId, now, now);
  }

  user(userId: string): StoredUser | null {
    const row = this.db.prepare("SELECT id, created_at, last_seen_at FROM users WHERE id = ?").get(userId) as
      | { id: string; created_at: number; last_seen_at: number }
      | undefined;
    if (!row) return null;
    return { id: row.id, createdAt: row.created_at, lastSeenAt: row.last_seen_at };
  }

  record(sessions: readonly BrowserLink[]): void {
    this.db.exec("BEGIN");
    try {
      for (const session of sessions) this.upsertBrowser(session);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setProfile(userId: string, status: ProfileStatus, now: number): void {
    if (!USER_ID.test(userId)) return;
    this.touch(userId, now);
    this.db.prepare(
      `INSERT INTO browser_profiles (user_id, state, expires_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    ).run(userId, status.state, status.expiresAt, now);
  }

  browsersFor(userId: string): StoredBrowser[] {
    const rows = this.db.prepare(
      `SELECT browsers.session_id, browsers.user_id, browsers.task_id, browsers.status, browsers.url, browsers.title,
              browsers.created_at, browsers.updated_at, browsers.expires_at,
              browser_profiles.state, browser_profiles.expires_at AS profile_expires_at
       FROM browsers
       LEFT JOIN browser_profiles ON browser_profiles.user_id = browsers.user_id
       WHERE browsers.user_id = ?
       ORDER BY browsers.created_at DESC`,
    ).all(userId) as {
      session_id: string;
      user_id: string;
      task_id: string;
      status: string;
      url: string;
      title: string;
      created_at: number;
      updated_at: number;
      expires_at: number;
      state: string | null;
      profile_expires_at: number | null;
    }[];
    return rows.map((row) => ({
      id: row.session_id,
      taskId: row.task_id,
      ownerId: row.user_id,
      status: row.status,
      url: row.url,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      profileState: profileState(row.state),
      profileExpiresAt: row.profile_expires_at,
    }));
  }

  account(userId: string): { id: string; email: string; phone: string | null; name: string | null } | null {
    if (!USER_ID.test(userId)) return null;
    const row = this.db.prepare("SELECT id, email, phone, preferred_name FROM users WHERE id = ?").get(userId) as
      | { id: string; email: string | null; phone: string | null; preferred_name: string | null }
      | undefined;
    if (!row || row.email == null || row.email.length === 0) return null;
    return {
      id: row.id,
      email: row.email,
      phone: row.phone != null && row.phone.length > 0 ? row.phone : null,
      name: row.preferred_name != null && row.preferred_name.length > 0 ? row.preferred_name : null,
    };
  }

  setPhone(userId: string, phone: string, now: number): boolean {
    if (!USER_ID.test(userId)) return false;
    const result = this.db.prepare(
      "UPDATE users SET phone = ?, phone_verified_at = CASE WHEN phone = ? THEN phone_verified_at ELSE NULL END, last_seen_at = ? WHERE id = ? AND email IS NOT NULL",
    ).run(phone, phone, now, userId);
    return result.changes > 0;
  }

  /** Removes the stored number. Website sign-ins that need a phone stop until a new one is added. */
  clearPhone(userId: string, now: number): boolean {
    if (!USER_ID.test(userId)) return false;
    return this.db.prepare("UPDATE users SET phone = NULL, phone_verified_at = NULL, last_seen_at = ? WHERE id = ?").run(now, userId).changes > 0;
  }

  /** Set when a website accepted an SMS code sent to the stored number. */
  markPhoneVerified(userId: string, now: number): void {
    if (!USER_ID.test(userId)) return;
    this.db.prepare("UPDATE users SET phone_verified_at = ? WHERE id = ? AND phone IS NOT NULL").run(now, userId);
  }

  phoneProfile(userId: string): { masked: string | null; verifiedAt: number | null } {
    if (!USER_ID.test(userId)) return { masked: null, verifiedAt: null };
    const row = this.db.prepare("SELECT phone, phone_verified_at FROM users WHERE id = ?").get(userId) as { phone: string | null; phone_verified_at: number | null } | undefined;
    return { masked: row?.phone ? maskPhone(row.phone) : null, verifiedAt: row?.phone_verified_at ?? null };
  }

  setName(userId: string, name: string, now: number): boolean {
    if (!USER_ID.test(userId)) return false;
    const result = this.db.prepare(
      "UPDATE users SET preferred_name = ?, last_seen_at = ? WHERE id = ? AND email IS NOT NULL AND phone IS NOT NULL",
    ).run(name, now, userId);
    return result.changes > 0;
  }

  ensureEmailUser(email: string, now: number): { id: string; email: string } {
    const existing = this.db.prepare("SELECT id, email FROM users WHERE email = ?").get(email) as { id: string; email: string } | undefined;
    if (existing) {
      this.touch(existing.id, now);
      return existing;
    }
    const id = randomUserId();
    this.db.prepare("INSERT INTO users (id, created_at, last_seen_at, email) VALUES (?, ?, ?, ?)").run(id, now, now, email);
    return { id, email };
  }

  saveCode(email: string, salt: string, codeHash: string, expiresAt: number): void {
    this.db.prepare(
      `INSERT INTO login_codes (email, salt, code_hash, expires_at, attempts) VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(email) DO UPDATE SET salt = excluded.salt, code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
    ).run(email, salt, codeHash, expiresAt);
  }

  codeFor(email: string): { salt: string; codeHash: string; expiresAt: number; attempts: number } | null {
    const row = this.db.prepare("SELECT salt, code_hash, expires_at, attempts FROM login_codes WHERE email = ?").get(email) as
      | { salt: string; code_hash: string; expires_at: number; attempts: number }
      | undefined;
    if (!row) return null;
    return { salt: row.salt, codeHash: row.code_hash, expiresAt: row.expires_at, attempts: row.attempts };
  }

  bumpCode(email: string): void {
    this.db.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?").run(email);
  }

  clearCode(email: string): void {
    this.db.prepare("DELETE FROM login_codes WHERE email = ?").run(email);
  }

  private upsertBrowser(session: BrowserLink): void {
    if (!USER_ID.test(session.ownerId) || !USER_ID.test(session.id) || !USER_ID.test(session.taskId)) return;
    this.touch(session.ownerId, session.updatedAt);
    this.db.prepare(
      `INSERT INTO browsers (
         session_id, user_id, task_id, status, url, title, created_at, updated_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         status = excluded.status,
         url = excluded.url,
         title = excluded.title,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
    ).run(
      session.id,
      session.ownerId,
      session.taskId,
      session.status,
      session.url,
      session.title,
      session.createdAt,
      session.updatedAt,
      session.expiresAt,
    );
  }
}

export function scoutDbPath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SCOUT_DB_PATH?.trim() ?? "";
  if (configured.length > 0) return configured;
  if ((env.WEBSITE_SITE_NAME ?? "").trim().length > 0) return "/home/data/scout.sqlite";
  return join(root, ".data", "scout.sqlite");
}

function randomUserId(): string {
  return randomBytes(16).toString("hex");
}

function addColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("duplicate column")) throw error;
  }
}

function profileState(value: string | null): ProfileState {
  switch (value) {
    case "saved":
    case "expired":
    case "revoked":
    case "absent":
      return value;
    default:
      return "absent";
  }
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length < 4 ? "••••" : `••••••${digits.slice(-4)}`;
}
