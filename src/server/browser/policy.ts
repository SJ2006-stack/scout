import { isAbsolute, join } from "node:path";

export type BrowserConfig = {
  enabled: boolean;
  allowHosts: string[];
  operationTimeoutMs: number;
  sessionTtlMs: number;
  maxSessions: number;
  stateDir: string;
};

export function browserConfigFromEnv(env: NodeJS.ProcessEnv, root: string): BrowserConfig {
  const configured = env.BROWSER_STATE_DIR?.trim() ?? "";
  const stateDir = configured.length === 0 ? join(root, ".data", "browser") : isAbsolute(configured) ? configured : join(root, configured);
  return {
    enabled: env.BROWSER_WORKER_ENABLED === "1",
    allowHosts: parseAllowHosts(env.BROWSER_ALLOW_HOSTS),
    operationTimeoutMs: boundedNumber(env.BROWSER_OP_TIMEOUT_MS, 15_000, 1_000, 120_000),
    sessionTtlMs: boundedNumber(env.BROWSER_SESSION_TTL_MS, 900_000, 5_000, 3_600_000),
    maxSessions: boundedNumber(env.BROWSER_MAX_SESSIONS, 4, 1, 8),
    stateDir,
  };
}

export function parseAllowHosts(raw: string | undefined): string[] {
  const hosts: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const entry = part.trim().toLowerCase().replace(/\.$/, "");
    if (!usableHost(entry)) continue;
    if (!hosts.includes(entry)) hosts.push(entry);
  }
  return hosts;
}

export function checkNavigationUrl(raw: string, allowHosts: readonly string[]): { ok: true; url: string } | { ok: false; error: string } {
  const text = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, error: "That URL is not valid." };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, error: "URLs that include a username or password are not allowed." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Only https URLs on the allowlist can be opened." };
  }
  if (!hostAllowed(parsed.hostname, allowHosts)) {
    return { ok: false, error: "That site is not on the browser allowlist." };
  }
  return { ok: true, url: parsed.href };
}

export function hostAllowed(hostname: string, allowHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return false;
  return allowHosts.some((entry) => {
    if (host === entry) return true;
    if (isIp(entry)) return false;
    return host.endsWith(`.${entry}`);
  });
}

function usableHost(entry: string): boolean {
  if (entry.length === 0 || entry.includes("/") || entry.includes("@") || entry.includes(":")) return false;
  return entry === "localhost" || entry.includes(".");
}

function isIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
