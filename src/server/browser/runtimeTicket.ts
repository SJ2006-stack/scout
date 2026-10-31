import { createHmac, timingSafeEqual } from "node:crypto";

const VERSION = "v1";
const WINDOW_MS = 60_000;

export type BrowserRuntimeConfig = {
  url: string;
  key: string | null;
};

export function browserRuntimeFromEnv(env: NodeJS.ProcessEnv): BrowserRuntimeConfig | undefined {
  const url = env.BROWSER_RUNTIME_URL?.trim() ?? "";
  const keyRaw = env.BROWSER_RUNTIME_KEY?.trim() ?? "";
  if (url.length === 0 && keyRaw.length === 0) return undefined;
  return { url, key: keyRaw.length >= 32 ? keyRaw : null };
}

export function signRuntimeTicket(input: {
  ownerId: string;
  method: string;
  pathname: string;
  now: number;
  key: string;
}): string | null {
  if (!/^[a-f0-9]{32}$/.test(input.ownerId)) return null;
  if (input.key.length < 32) return null;
  const exp = input.now + WINDOW_MS;
  const mac = macHex(input.key, signedText(VERSION, input.ownerId, exp, input.method, input.pathname));
  return `${VERSION}.${input.ownerId}.${exp}.${mac}`;
}

export function verifyRuntimeTicket(
  ticket: string,
  input: { method: string; pathname: string; now: number; key: string },
): { ok: true; ownerId: string } | { ok: false } {
  if (input.key.length < 32) return { ok: false };
  const parts = ticket.split(".");
  if (parts.length !== 4) return { ok: false };
  const version = parts[0] ?? "";
  const ownerId = parts[1] ?? "";
  const expText = parts[2] ?? "";
  const mac = parts[3] ?? "";
  if (version !== VERSION) return { ok: false };
  if (!/^[a-f0-9]{32}$/.test(ownerId)) return { ok: false };
  if (!/^[0-9]{1,15}$/.test(expText)) return { ok: false };
  if (!/^[a-f0-9]{64}$/.test(mac)) return { ok: false };
  const exp = Number(expText);
  if (!Number.isSafeInteger(exp) || input.now >= exp || exp - input.now > WINDOW_MS) return { ok: false };
  const expected = macHex(input.key, signedText(version, ownerId, exp, input.method, input.pathname));
  const presented = Buffer.from(mac, "hex");
  const actual = Buffer.from(expected, "hex");
  if (presented.length !== actual.length || presented.length === 0) return { ok: false };
  if (!timingSafeEqual(presented, actual)) return { ok: false };
  return { ok: true, ownerId };
}

function signedText(version: string, ownerId: string, exp: number, method: string, pathname: string): string {
  return `${version}.${ownerId}.${exp}.${method.toUpperCase()}.${pathname}`;
}

function macHex(key: string, text: string): string {
  return createHmac("sha256", key).update(text).digest("hex");
}
