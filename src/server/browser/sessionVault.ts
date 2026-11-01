import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type { ProfileState } from "../../shared/browser.ts";

export type SiteSessionView = {
  domain: string;
  profileRef: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  lastValidatedAt: number | null;
  revokedAt: number | null;
  state: "verified" | "unverified" | "expired" | "revoked";
};

type SiteRecord = {
  ownerId: string;
  domain: string;
  profileRef: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  lastValidatedAt: number | null;
  revokedAt: number | null;
};

type VaultIndex = { version: 2; sites: SiteRecord[] };

/** A verified record exactly as stored: the encrypted file plus its dates. */
export type SealedSite = { domain: string; updatedAt: number; expiresAt: number; lastValidatedAt: number; blob: Buffer };

export type RestoreResult = "restored" | "kept" | "revoked" | "rejected";

export type VaultChange = { ownerId: string; domain: string; kind: "put" | "drop"; at: number };

type StorageState = { cookies: Array<Record<string, unknown>>; origins: Array<Record<string, unknown>> };

const MAGIC = Buffer.from("SCV2");
const MAX_STATE_BYTES = 1_000_000;
const OWNER = /^[a-f0-9]{32}$/;
const DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/**
 * Encrypted browser sign-ins, one record per user and site. Each file is
 * AES-256-GCM with the owner and domain bound as associated data, so a file
 * copied to another user or site does not decrypt.
 */
export class SessionVault {
  private readonly dir: string;
  private readonly key: Buffer;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly listeners = new Set<(change: VaultChange) => void>();

  constructor(dir: string, key: Buffer, ttlMs: number, now: () => number) {
    this.dir = dir;
    this.key = key;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** Saves the part of a browser storage state that belongs to one site. */
  save(ownerId: string, domain: string, state: unknown, validated: boolean): void {
    const owner = checkedOwner(ownerId);
    const site = checkedDomain(domain);
    const scoped = scopeState(state, site);
    const payload = JSON.stringify(scoped);
    if (Buffer.byteLength(payload) > MAX_STATE_BYTES) throw new Error("The saved sign-in is too large.");
    const profileRef = refFor(owner, site);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(aad(owner, site));
    const body = Buffer.concat([MAGIC, iv, Buffer.alloc(16), cipher.update(payload, "utf8"), cipher.final()]);
    cipher.getAuthTag().copy(body, MAGIC.length + 12);
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${profileRef}.bin`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, file);
    const now = this.now();
    this.mutate((index) => {
      const record = index.sites.find((item) => item.ownerId === owner && item.domain === site);
      if (record) {
        record.updatedAt = now;
        record.expiresAt = now + this.ttlMs;
        record.revokedAt = null;
        if (validated) record.lastValidatedAt = now;
        return;
      }
      index.sites.push({ ownerId: owner, domain: site, profileRef, createdAt: now, updatedAt: now, expiresAt: now + this.ttlMs, lastValidatedAt: validated ? now : null, revokedAt: null });
    });
    this.emit({ ownerId: owner, domain: site, kind: "put", at: now });
  }

  /** Called after every save, validation, and revoke, so copies elsewhere can follow. */
  onChange(listener: (change: VaultChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The sealed file for one verified, unexpired, unrevoked site. */
  sealed(ownerId: string, domain: string): SealedSite | null {
    const record = this.record(checkedOwner(ownerId), checkedDomain(domain));
    if (!record || record.revokedAt != null || record.lastValidatedAt == null || this.now() >= record.expiresAt) return null;
    const file = join(this.dir, `${record.profileRef}.bin`);
    if (!existsSync(file)) return null;
    return { domain: record.domain, updatedAt: record.updatedAt, expiresAt: record.expiresAt, lastValidatedAt: record.lastValidatedAt, blob: readFileSync(file) };
  }

  sealedAll(ownerId: string): SealedSite[] {
    const owner = checkedOwner(ownerId);
    return this.read().sites
      .filter((item) => item.ownerId === owner)
      .map((item) => this.sealed(owner, item.domain))
      .filter((item): item is SealedSite => item != null);
  }

  /**
   * Takes back a sealed copy, as after this disk was lost. It must open with this
   * key for this user and site, be newer than what is here, and postdate any revoke.
   */
  restore(ownerId: string, site: SealedSite): RestoreResult {
    const owner = checkedOwner(ownerId);
    const domain = registrable(site.domain);
    if (domain !== site.domain || !DOMAIN.test(domain)) return "rejected";
    const now = this.now();
    if (now >= site.expiresAt || site.updatedAt > now + 60_000 || site.lastValidatedAt > site.updatedAt + 60_000) return "rejected";
    const record = this.record(owner, domain);
    if (record?.revokedAt != null && record.revokedAt >= site.updatedAt) return "revoked";
    if (record && record.revokedAt == null && record.updatedAt >= site.updatedAt && existsSync(join(this.dir, `${record.profileRef}.bin`))) return "kept";
    if (!this.open(site.blob, owner, domain)) return "rejected";
    const profileRef = refFor(owner, domain);
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${profileRef}.bin`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, site.blob, { mode: 0o600 });
    renameSync(tmp, file);
    this.mutate((index) => {
      const rest = index.sites.filter((item) => !(item.ownerId === owner && item.domain === domain));
      rest.push({
        ownerId: owner,
        domain,
        profileRef,
        createdAt: record?.createdAt ?? site.updatedAt,
        updatedAt: site.updatedAt,
        expiresAt: site.expiresAt,
        lastValidatedAt: site.lastValidatedAt,
        revokedAt: null,
      });
      index.sites = rest;
    });
    return "restored";
  }

  /** Revoke time for a site, so a stale copy offered later can be told to drop. */
  revokedAt(ownerId: string, domain: string): number | null {
    return this.record(checkedOwner(ownerId), registrable(domain))?.revokedAt ?? null;
  }

  private emit(change: VaultChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // A failing mirror must not undo a saved sign-in.
      }
    }
  }

  /** Marks a stored sign-in as verified after the site showed a signed-in page. */
  markValidated(ownerId: string, domain: string): void {
    const owner = checkedOwner(ownerId);
    const site = checkedDomain(domain);
    const now = this.now();
    let changed = false;
    this.mutate((index) => {
      const record = index.sites.find((item) => item.ownerId === owner && item.domain === site);
      if (record && record.revokedAt == null && now < record.expiresAt) {
        record.lastValidatedAt = now;
        changed = true;
      }
    });
    if (changed) this.emit({ ownerId: owner, domain: site, kind: "put", at: now });
  }

  /** Returns a site's decrypted state. Only verified, unexpired, unrevoked records load. */
  load(ownerId: string, domain: string): StorageState | null {
    const owner = checkedOwner(ownerId);
    const site = checkedDomain(domain);
    const record = this.record(owner, site);
    if (!record || record.revokedAt != null || record.lastValidatedAt == null) return null;
    if (this.now() >= record.expiresAt) {
      rmSync(join(this.dir, `${record.profileRef}.bin`), { force: true });
      return null;
    }
    return this.decrypt(record);
  }

  /** Merges the verified states for several sites into one browser context. */
  loadFor(ownerId: string, domains: readonly string[]): StorageState | null {
    const merged: StorageState = { cookies: [], origins: [] };
    let any = false;
    for (const domain of new Set(domains.map(registrable))) {
      if (!DOMAIN.test(domain)) continue;
      const state = this.load(ownerId, domain);
      if (!state) continue;
      any = true;
      merged.cookies.push(...state.cookies);
      merged.origins.push(...state.origins);
    }
    return any ? merged : null;
  }

  list(ownerId: string): SiteSessionView[] {
    const owner = checkedOwner(ownerId);
    return this.read().sites.filter((item) => item.ownerId === owner).map((record) => this.view(record));
  }

  revoke(ownerId: string, domain?: string): void {
    const owner = checkedOwner(ownerId);
    const site = domain == null ? null : checkedDomain(domain);
    const now = this.now();
    const dropped: string[] = [];
    this.mutate((index) => {
      for (const record of index.sites) {
        if (record.ownerId !== owner || (site != null && record.domain !== site)) continue;
        rmSync(join(this.dir, `${record.profileRef}.bin`), { force: true });
        record.revokedAt = now;
        record.updatedAt = now;
        record.lastValidatedAt = null;
        dropped.push(record.domain);
      }
    });
    for (const domain of dropped) this.emit({ ownerId: owner, domain, kind: "drop", at: now });
  }

  /** Overall status for the web app badge: saved when any site is verified. */
  status(ownerId: string): { state: ProfileState; expiresAt: number | null } {
    const views = this.list(ownerId);
    const verified = views.filter((item) => item.state === "verified");
    if (verified.length > 0) return { state: "saved", expiresAt: Math.max(...verified.map((item) => item.expiresAt)) };
    if (views.length === 0) return { state: "absent", expiresAt: null };
    if (views.every((item) => item.state === "revoked")) return { state: "revoked", expiresAt: null };
    return { state: "expired", expiresAt: Math.max(...views.map((item) => item.expiresAt)) };
  }

  expireDue(): void {
    const now = this.now();
    for (const record of this.read().sites) {
      if (record.revokedAt == null && now >= record.expiresAt) rmSync(join(this.dir, `${record.profileRef}.bin`), { force: true });
    }
  }

  private decrypt(record: SiteRecord): StorageState | null {
    const file = join(this.dir, `${record.profileRef}.bin`);
    if (!existsSync(file)) return null;
    return this.open(readFileSync(file), record.ownerId, record.domain);
  }

  private open(body: Buffer, owner: string, domain: string): StorageState | null {
    try {
      if (body.length < MAGIC.length + 28 || !body.subarray(0, 4).equals(MAGIC)) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.key, body.subarray(4, 16));
      decipher.setAAD(aad(owner, domain));
      decipher.setAuthTag(body.subarray(16, 32));
      const json = Buffer.concat([decipher.update(body.subarray(32)), decipher.final()]).toString("utf8");
      return asState(JSON.parse(json) as unknown);
    } catch {
      return null;
    }
  }

  private view(record: SiteRecord): SiteSessionView {
    const now = this.now();
    const state = record.revokedAt != null
      ? "revoked"
      : now >= record.expiresAt || !existsSync(join(this.dir, `${record.profileRef}.bin`))
        ? "expired"
        : record.lastValidatedAt != null ? "verified" : "unverified";
    return {
      domain: record.domain,
      profileRef: record.profileRef,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt,
      lastValidatedAt: record.lastValidatedAt,
      revokedAt: record.revokedAt,
      state,
    };
  }

  private record(owner: string, domain: string): SiteRecord | null {
    return this.read().sites.find((item) => item.ownerId === owner && item.domain === domain) ?? null;
  }

  private read(): VaultIndex {
    const file = join(this.dir, "sites.json");
    if (!existsSync(file)) return { version: 2, sites: [] };
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || (parsed as VaultIndex).version !== 2 || !Array.isArray((parsed as VaultIndex).sites)) {
        return { version: 2, sites: [] };
      }
      return parsed as VaultIndex;
    } catch {
      return { version: 2, sites: [] };
    }
  }

  private mutate(fn: (index: VaultIndex) => void): void {
    const index = this.read();
    fn(index);
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, "sites.json");
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(index), { mode: 0o600 });
    renameSync(tmp, file);
  }
}

/** Drops "www." and similar leading labels so blinkit.com and www.blinkit.com share one record. */
export function registrable(hostOrDomain: string): string {
  const host = hostOrDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (isIP(host) !== 0) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  if (/^(?:co|com|net|org|gov|ac)\.[a-z]{2}$/.test(lastTwo)) return parts.slice(-3).join(".");
  return lastTwo;
}

export function scopeState(state: unknown, domain: string): StorageState {
  const parsed = asState(state) ?? { cookies: [], origins: [] };
  const site = registrable(domain);
  const belongs = (host: string) => {
    const clean = host.replace(/^\./, "").toLowerCase();
    return clean === site || clean.endsWith(`.${site}`);
  };
  return {
    cookies: parsed.cookies.filter((cookie) => typeof cookie.domain === "string" && belongs(cookie.domain)),
    origins: parsed.origins.filter((origin) => {
      if (typeof origin.origin !== "string") return false;
      try {
        return belongs(new URL(origin.origin).hostname);
      } catch {
        return false;
      }
    }),
  };
}

function asState(value: unknown): StorageState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { cookies?: unknown; origins?: unknown };
  const cookies = Array.isArray(record.cookies) ? record.cookies.filter(isObject) : [];
  const origins = Array.isArray(record.origins) ? record.origins.filter(isObject) : [];
  return { cookies, origins };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

function aad(owner: string, domain: string): Buffer {
  return Buffer.from(`${owner}\0${domain}`);
}

function refFor(owner: string, domain: string): string {
  return createHash("sha256").update(`${owner}\0${domain}`).digest("hex").slice(0, 32);
}

function checkedOwner(ownerId: string): string {
  if (!OWNER.test(ownerId)) throw new Error("That browser profile was not found.");
  return ownerId;
}

function checkedDomain(domain: string): string {
  const site = registrable(domain);
  if (!DOMAIN.test(site)) throw new Error("That site cannot hold a saved sign-in.");
  return site;
}
