import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const MEDIA = new Set([".mp4", ".webm", ".gif", ".jpg", ".jpeg", ".png", ".webp"]);

/** Parses a single `bytes=a-b` range. Returns null for none or several ranges, and "bad" when it cannot be satisfied. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "bad" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first, last] = match;
  if (first === "" && last === "") return "bad";
  let start: number;
  let end: number;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0) return "bad";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(first);
    end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  }
  if (start >= size || start > end) return "bad";
  return { start, end };
}

/** Streams a file. Video needs Range support: Safari and iOS will not play an mp4 without it. */
export function sendFile(request: IncomingMessage, response: ServerResponse, file: string): void {
  const extension = extname(file).toLowerCase();
  const size = statSync(file).size;
  const headers: Record<string, string | number> = {
    "content-type": TYPES[extension] ?? "application/octet-stream",
    "cache-control": extension === ".html" ? "no-cache" : MEDIA.has(extension) ? "public, max-age=86400" : "public, max-age=3600",
    "accept-ranges": "bytes",
  };
  const range = parseRange(typeof request.headers.range === "string" ? request.headers.range : undefined, size);
  if (range === "bad") {
    response.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
    response.end();
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  if (range) {
    response.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
  } else {
    response.writeHead(200, { ...headers, "content-length": size });
  }
  if (request.method === "HEAD" || size === 0) {
    response.end();
    return;
  }
  const stream = createReadStream(file, { start, end });
  stream.on("error", () => response.destroy());
  response.on("close", () => stream.destroy());
  stream.pipe(response);
}
