import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE = "scout_session";

export function sessionId(request: IncomingMessage, response: ServerResponse): string {
  const header = request.headers["x-scout-session"];
  const presented = typeof header === "string" ? header : "";
  if (/^[a-f0-9]{32}$/.test(presented)) return presented;
  const existing = readCookie(request.headers.cookie, COOKIE);
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
  const id = randomBytes(16).toString("hex");
  response.setHeader("set-cookie", `${COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
  return id;
}

/** Browser-worker owner. Only the HttpOnly cookie counts. A client-supplied session id does not. */
export function browserOwner(request: IncomingMessage, response: ServerResponse): string {
  const existing = readCookie(request.headers.cookie, COOKIE);
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
  const id = randomBytes(16).toString("hex");
  response.setHeader("set-cookie", `${COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
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
