export const SCOUT_USER = "user0" as const;
export const PAIR_WINDOW_MS = 110_000;

export type PairTicket = {
  userId: typeof SCOUT_USER;
  code: string;
  issuedAt: number;
  expiresAt: number;
};

export type PairDevice = "phone" | "desk";

export type PairRead =
  | { ok: true; userId: typeof SCOUT_USER; code: string; expiresAt: number; fresh: boolean }
  | { ok: false; message: string };

const CODE = /^[a-f0-9]{32}$/;

export function pairPayload(origin: string, ticket: PairTicket): string {
  const url = new URL("/pair", origin);
  url.searchParams.set("user", ticket.userId);
  url.searchParams.set("code", ticket.code);
  url.searchParams.set("exp", String(ticket.expiresAt));
  return url.toString();
}

export function parsePairTicket(value: unknown): PairTicket | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (body.userId !== SCOUT_USER) return null;
  if (typeof body.code !== "string" || !CODE.test(body.code)) return null;
  const issuedAt = body.issuedAt;
  const expiresAt = body.expiresAt;
  if (typeof issuedAt !== "number" || typeof expiresAt !== "number") return null;
  if (!Number.isInteger(issuedAt) || !Number.isInteger(expiresAt)) return null;
  if (expiresAt - issuedAt !== PAIR_WINDOW_MS) return null;
  return { userId: SCOUT_USER, code: body.code, issuedAt, expiresAt };
}

export function readPairPayload(text: string, now: number): PairRead {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return { ok: false, message: "That code is not a Scout device code." };
  }
  if (!url.pathname.endsWith("/pair")) return { ok: false, message: "That code is not a Scout device code." };
  if (url.searchParams.get("user") !== SCOUT_USER) return { ok: false, message: "Scout is using user0 on every device." };
  const code = url.searchParams.get("code") ?? "";
  const expiresAt = Number(url.searchParams.get("exp"));
  if (!CODE.test(code) || !Number.isInteger(expiresAt)) return { ok: false, message: "That code is not a Scout device code." };
  return { ok: true, userId: SCOUT_USER, code, expiresAt, fresh: expiresAt > now };
}

export function pairScanMessage(read: PairRead): string {
  if (!read.ok) return read.message;
  if (!read.fresh) return "This code has expired. The other device shows a new one every 110 seconds.";
  return "This code is for user0. Sign-in from another device is not connected, so this phone stays user0.";
}

export function pairDevice(userAgent: string): PairDevice {
  const phone = /iPhone|iPod|Windows Phone|webOS|BlackBerry|IEMobile|Opera Mini/i.test(userAgent)
    || (/Android/i.test(userAgent) && /Mobile/i.test(userAgent));
  return phone ? "phone" : "desk";
}
