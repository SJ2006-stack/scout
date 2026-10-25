import type { IncomingMessage, ServerResponse } from "node:http";

const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
const VERCEL_ORIGIN = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app$/;

export function applyCors(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : "";
  const allowed = allowedOrigin(origin);
  if (allowed) {
    response.setHeader("access-control-allow-origin", allowed);
    response.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type, x-scout-session, bypass-tunnel-reminder");
    response.setHeader("access-control-max-age", "600");
    response.setHeader("vary", "origin");
  }
  if (request.method !== "OPTIONS") return false;
  response.writeHead(allowed ? 204 : 403);
  response.end();
  return true;
}

function allowedOrigin(origin: string): string | null {
  if (LOCAL_ORIGIN.test(origin) || VERCEL_ORIGIN.test(origin)) return origin;
  const extras = (process.env.CORS_ORIGIN ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return extras.includes(origin) ? origin : null;
}
