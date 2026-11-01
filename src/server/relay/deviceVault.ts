import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFrame, decodeVault, encodeVault, RelayKind } from "../../shared/relay.ts";

/** A sealed sign-in as the phone keeps it. The phone cannot open the blob. */
export type SealedCopy = { domain: string; updatedAt: number; expiresAt: number; lastValidatedAt: number; blob: Uint8Array };

export type DeviceVault = {
  list(): SealedCopy[];
  put(copy: SealedCopy): void;
  drop(domain: string, at: number): void;
};

const DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/** In-memory copy store, for tests. */
export function memoryDeviceVault(): DeviceVault & { copies: Map<string, SealedCopy> } {
  const copies = new Map<string, SealedCopy>();
  return {
    copies,
    list: () => [...copies.values()],
    put: (copy) => {
      const held = copies.get(copy.domain);
      if (!held || held.updatedAt < copy.updatedAt) copies.set(copy.domain, copy);
    },
    drop: (domain, at) => {
      const held = copies.get(domain);
      if (held && held.updatedAt <= at) copies.delete(domain);
    },
  };
}

/** One file per site, written atomically, in a folder only this user can read. */
export function fileDeviceVault(dir: string, now: () => number = Date.now): DeviceVault {
  const path = (domain: string) => join(dir, `${domain}.seal`);
  const read = (file: string): SealedCopy | null => {
    try {
      const frame = decodeFrame(readFileSync(join(dir, file)));
      const message = frame?.kind === RelayKind.vault ? decodeVault(frame.payload) : null;
      return message && message.op !== "drop" ? { ...message } : null;
    } catch {
      return null;
    }
  };
  return {
    list: () => {
      let files: string[] = [];
      try {
        files = readdirSync(dir).filter((file) => file.endsWith(".seal"));
      } catch {
        return [];
      }
      return files.map(read).filter((copy): copy is SealedCopy => copy != null && copy.expiresAt > now());
    },
    put: (copy) => {
      if (!DOMAIN.test(copy.domain)) return;
      const held = read(`${copy.domain}.seal`);
      if (held && held.updatedAt >= copy.updatedAt) return;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${path(copy.domain)}.${process.pid}.tmp`;
      writeFileSync(tmp, encodeVault({ op: "put", ...copy }), { mode: 0o600 });
      renameSync(tmp, path(copy.domain));
    },
    drop: (domain, at) => {
      if (!DOMAIN.test(domain)) return;
      const held = read(`${domain}.seal`);
      if (held && held.updatedAt <= at) rmSync(path(domain), { force: true });
    },
  };
}
