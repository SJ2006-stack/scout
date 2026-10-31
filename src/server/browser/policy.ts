import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { isAbsolute, join } from "node:path";
import { profileKeyFromEnv } from "./profileVault.ts";

export type BrowserConfig = {
  enabled: boolean;
  headed: boolean;
  operationTimeoutMs: number;
  sessionTtlMs: number;
  profileTtlMs: number;
  maxSessions: number;
  maxLanes: number;
  stateDir: string;
  profileKey: Buffer | null;
  allowedHosts: readonly string[] | null;
};

const blockedAddresses = new BlockList();
blockedAddresses.addSubnet("0.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("10.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("100.64.0.0", 10, "ipv4");
blockedAddresses.addSubnet("127.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("169.254.0.0", 16, "ipv4");
blockedAddresses.addSubnet("172.16.0.0", 12, "ipv4");
blockedAddresses.addSubnet("192.168.0.0", 16, "ipv4");
blockedAddresses.addSubnet("224.0.0.0", 4, "ipv4");
blockedAddresses.addAddress("::", "ipv6");
blockedAddresses.addAddress("::1", "ipv6");
blockedAddresses.addSubnet("fc00::", 7, "ipv6");
blockedAddresses.addSubnet("fe80::", 10, "ipv6");
blockedAddresses.addSubnet("ff00::", 8, "ipv6");

export function browserConfigFromEnv(env: NodeJS.ProcessEnv, root: string): BrowserConfig {
  const configured = env.BROWSER_STATE_DIR?.trim() ?? "";
  const stateDir = configured.length === 0 ? join(root, ".data", "browser") : isAbsolute(configured) ? configured : join(root, configured);
  return {
    enabled: env.BROWSER_WORKER_ENABLED === "1",
    headed: env.BROWSER_HEADED === "1",
    operationTimeoutMs: boundedNumber(env.BROWSER_OP_TIMEOUT_MS, 90_000, 1_000, 120_000),
    sessionTtlMs: boundedNumber(env.BROWSER_SESSION_TTL_MS, 900_000, 5_000, 3_600_000),
    profileTtlMs: boundedNumber(env.BROWSER_PROFILE_TTL_MS, 7 * 24 * 60 * 60 * 1000, 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000),
    maxSessions: boundedNumber(env.BROWSER_MAX_SESSIONS, 4, 1, 8),
    maxLanes: boundedNumber(env.BROWSER_MAX_LANES, 3, 1, 6),
    stateDir,
    profileKey: profileKeyFromEnv(env.BROWSER_PROFILE_KEY),
    allowedHosts: allowedHostsFromEnv(env.BROWSER_ALLOWED_HOSTS),
  };
}

export function browserRoleError(config: BrowserConfig, role = process.env.SCOUT_ROLE): string | null {
  if (role !== "browser") return null;
  if (!config.enabled) return "The browser worker process requires BROWSER_WORKER_ENABLED=1.";
  if (!config.profileKey) return "The browser worker process requires BROWSER_PROFILE_KEY so saved sign-ins stay encrypted.";
  if (config.allowedHosts == null || config.allowedHosts.length === 0) return "The browser worker process requires BROWSER_ALLOWED_HOSTS.";
  return null;
}

export function checkNavigationUrl(raw: string, allowedHosts: readonly string[] | null = null): { ok: true; url: string } | { ok: false; error: string } {
  const parsed = parseBrowserUrl(raw);
  if (!parsed.ok) return parsed;
  if (parsed.url.protocol !== "https:") return { ok: false, error: "Only https URLs can be opened." };
  const host = hostDecision(parsed.url.hostname, allowedHosts);
  if (!host.ok) return host;
  return { ok: true, url: parsed.url.href };
}

export function allowBrowserRequest(raw: string, allowedHosts: readonly string[] | null = null): boolean {
  if (isPageLocalUrl(raw)) return true;
  const parsed = parseBrowserUrl(raw);
  if (!parsed.ok) return false;
  if (parsed.url.protocol !== "https:" && parsed.url.protocol !== "wss:") return false;
  return hostDecision(parsed.url.hostname, allowedHosts).ok;
}

export function isPageLocalUrl(raw: string): boolean {
  return raw === "about:blank" || raw.startsWith("blob:") || raw.startsWith("data:");
}

export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 0) return true;
  const mapped = version === 6 ? mappedIpv4(address) : null;
  if (mapped) return blockedAddresses.check(mapped, "ipv4");
  return blockedAddresses.check(address, version === 4 ? "ipv4" : "ipv6");
}

type HostLookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<ReadonlyArray<{ address: string }>>;

export async function browserHostIsPublic(hostname: string, resolve: HostLookup = lookup): Promise<boolean> {
  const host = normalizeHost(hostname);
  if (isBlockedHostname(host)) return false;
  if (isIP(host) !== 0) return !isBlockedAddress(host);
  try {
    const records = await resolve(host, { all: true, verbatim: true });
    return records.length > 0 && records.every((record) => !isBlockedAddress(record.address));
  } catch {
    return false;
  }
}

export type HostVerdictCache = Map<string, { ok: boolean; expires: number }>;

export async function rememberedPublicHost(
  hostname: string,
  cache: HostVerdictCache,
  inflight: Map<string, Promise<boolean>>,
  now: number,
  resolve: HostLookup = lookup,
  timeoutMs = 4_000,
): Promise<boolean> {
  const host = normalizeHost(hostname);
  const saved = cache.get(host);
  if (saved && saved.expires > now) return saved.ok;
  let pending = inflight.get(host);
  if (!pending) {
    pending = browserHostIsPublic(host, resolve).then((ok) => {
      cache.set(host, { ok, expires: now + (ok ? 600_000 : 60_000) });
      inflight.delete(host);
      return ok;
    }, () => {
      inflight.delete(host);
      return false;
    });
    inflight.set(host, pending);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolveRace) => {
    timer = setTimeout(() => resolveRace(false), timeoutMs);
  });
  const ok = await Promise.race([pending, expired]);
  if (timer) clearTimeout(timer);
  return ok;
}

function allowedHostsFromEnv(raw: string | undefined): readonly string[] | null {
  const text = raw?.trim() ?? "";
  if (text.length === 0) return null;
  const hosts: string[] = [];
  for (const part of text.split(",")) {
    const host = normalizeHost(part);
    if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..") || isBlockedHostname(host)) {
      throw new Error("BROWSER_ALLOWED_HOSTS has a host that cannot be opened.");
    }
    hosts.push(host);
  }
  return hosts;
}

function parseBrowserUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, error: "That URL is not valid." };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, error: "URLs that include a username or password are not allowed." };
  }
  if (parsed.hostname.length === 0) return { ok: false, error: "Only https URLs can be opened." };
  return { ok: true, url: parsed };
}

function hostDecision(hostname: string, allowedHosts: readonly string[] | null): { ok: true } | { ok: false; error: string } {
  const host = normalizeHost(hostname);
  if (isBlockedHostname(host)) return { ok: false, error: "That host cannot be opened." };
  if (allowedHosts != null && !allowedHosts.some((entry) => host === entry || host.endsWith(`.${entry}`))) {
    return { ok: false, error: "That site is not on the browser allowlist." };
  }
  return { ok: true };
}

function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host.length === 0 || host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "metadata.google.internal" || host.endsWith(".internal") || host.endsWith(".local")) return true;
  return isIP(host) !== 0 && isBlockedAddress(host);
}

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

function mappedIpv4(address: string): string | null {
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped?.[1] ?? null;
}

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
