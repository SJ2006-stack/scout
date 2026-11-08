import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE = "scout_session";
/** Browsers cap a cookie near 400 days. Each signed-in visit refreshes it. */
const SESSION_MAX_AGE = 60 * 60 * 24 * 400;

export function sessionId(request: IncomingMessage, response: ServerResponse): string {
  const existing = currentSessionId(request);
  if (existing) return existing;
  const header = request.headers["x-scout-session"];
  const presented = typeof header === "string" ? header : "";
  if (/^[a-f0-9]{32}$/.test(presented)) return presented;
  const id = randomBytes(16).toString("hex");
  setSessionCookie(response, id);
  return id;
}

export function currentSessionId(request: IncomingMessage): string | null {
  const existing = readCookie(request.headers.cookie, COOKIE);
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
  return null;
}

export function setSessionCookie(response: ServerResponse, id: string): void {
  response.setHeader("set-cookie", `${COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`);
}

export function clearSessionCookie(response: ServerResponse): void {
  response.setHeader("set-cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/** Browser-worker owner. Only the HttpOnly cookie counts. A client-supplied session id does not. */
export function browserOwner(request: IncomingMessage, response: ServerResponse): string {
  const existing = readCookie(request.headers.cookie, COOKIE);
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
  const id = randomBytes(16).toString("hex");
  response.setHeader("set-cookie", `${COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`);
  return id;
}

function readCookie(header: string | string[] | undefined, name: string): string | null {
  const raw = Array.isArray(header) ? header.join("; ") : (header ?? "");
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}
