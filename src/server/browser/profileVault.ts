import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileState } from "../../shared/browser.ts";

export type { ProfileState };

export type ProfileStatus = {
  state: ProfileState;
  expiresAt: number | null;
};

type ProfileRecord = {
  ownerId: string;
  updatedAt: number;
  expiresAt: number;
  revokedAt: number | null;
};

type ProfileIndex = {
  version: 1;
  profiles: ProfileRecord[];
};

const MAGIC = Buffer.from("SCP1");
const MAX_STATE_BYTES = 1_000_000;

export class ProfileVault {
  private readonly dir: string;
  private readonly key: Buffer;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(dir: string, key: Buffer, ttlMs: number, now: () => number) {
    this.dir = dir;
    this.key = key;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  save(ownerId: string, state: unknown): void {
    const id = ownerIdOf(ownerId);
    const payload = JSON.stringify(state);
    if (Buffer.byteLength(payload) > MAX_STATE_BYTES) throw new Error("The saved sign-in is too large.");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const body = Buffer.concat([MAGIC, iv, tag, ciphertext]);
    mkdirSync(this.dir, { recursive: true });
    const file = this.file(id);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, file);
    const now = this.now();
    this.mutate((index) => {
      const record = index.profiles.find((item) => item.ownerId === id);
      const next = { ownerId: id, updatedAt: now, expiresAt: now + this.ttlMs, revokedAt: null };
      if (record) {
        record.updatedAt = next.updatedAt;
        record.expiresAt = next.expiresAt;
        record.revokedAt = null;
      } else {
        index.profiles.push(next);
      }
    });
  }

  load(ownerId: string): unknown | null {
    const id = ownerIdOf(ownerId);
    const record = this.record(id);
    if (!record || record.revokedAt != null) return null;
    if (this.now() >= record.expiresAt) {
      this.deleteCipher(id);
      return null;
    }
    const file = this.file(id);
    if (!existsSync(file)) return null;
    try {
      const body = readFileSync(file);
      if (body.length < MAGIC.length + 12 + 16 || !body.subarray(0, 4).equals(MAGIC)) return null;
      const iv = body.subarray(4, 16);
      const tag = body.subarray(16, 32);
      const ciphertext = body.subarray(32);
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAAD(Buffer.from(id));
      decipher.setAuthTag(tag);
      const json = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      return JSON.parse(json) as unknown;
    } catch {
      return null;
    }
  }

  revoke(ownerId: string): void {
    const id = ownerIdOf(ownerId);
    this.deleteCipher(id);
    const now = this.now();
    this.mutate((index) => {
      const record = index.profiles.find((item) => item.ownerId === id);
      if (record) {
        record.revokedAt = now;
        record.updatedAt = now;
        return;
      }
      index.profiles.push({ ownerId: id, updatedAt: now, expiresAt: now, revokedAt: now });
    });
  }

  status(ownerId: string): ProfileStatus {
    const id = ownerIdOf(ownerId);
    const record = this.record(id);
    if (!record) return { state: "absent", expiresAt: null };
    if (record.revokedAt != null) return { state: "revoked", expiresAt: record.expiresAt };
    if (this.now() >= record.expiresAt || !existsSync(this.file(id))) return { state: "expired", expiresAt: record.expiresAt };
    return { state: "saved", expiresAt: record.expiresAt };
  }

  expireDue(): void {
    const now = this.now();
    for (const record of this.read().profiles) {
      if (record.revokedAt != null) continue;
      if (now < record.expiresAt) continue;
      this.deleteCipher(record.ownerId);
    }
  }

  private file(ownerId: string): string {
    return join(this.dir, `${ownerId}.bin`);
  }

  private record(ownerId: string): ProfileRecord | null {
    return this.read().profiles.find((item) => item.ownerId === ownerId) ?? null;
  }

  private deleteCipher(ownerId: string): void {
    rmSync(this.file(ownerId), { force: true });
  }

  private read(): ProfileIndex {
    const file = join(this.dir, "index.json");
    if (!existsSync(file)) return { version: 1, profiles: [] };
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!isIndex(parsed)) return { version: 1, profiles: [] };
      return parsed;
    } catch {
      return { version: 1, profiles: [] };
    }
  }

  private mutate(fn: (index: ProfileIndex) => void): void {
    const index = this.read();
    fn(index);
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, "index.json");
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(index));
    renameSync(tmp, file);
  }
}

export function profileKeyFromEnv(raw: string | undefined): Buffer | null {
  const text = raw?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(text)) return null;
  return Buffer.from(text, "hex");
}

function ownerIdOf(ownerId: string): string {
  if (!/^[a-f0-9]{32}$/.test(ownerId)) throw new Error("That browser profile was not found.");
  return ownerId;
}

function isIndex(value: unknown): value is ProfileIndex {
  if (!value || typeof value !== "object") return false;
  const index = value as ProfileIndex;
  return index.version === 1 && Array.isArray(index.profiles);
}
