import { createServer, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { handleApi } from "./api.ts";
import { startBrowserWarm } from "./browser/worker.ts";
import { appRoot, createDeps, loadLocalEnv } from "./deps.ts";
import { healthPayload } from "./health.ts";
import { mainLandingFile } from "./landingPage.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

loadLocalEnv();
const root = appRoot();
const dist = join(root, "dist");
const deps = createDeps();
const port = Number(process.env.PORT ?? process.env.WEBSITES_PORT ?? 8080);

const browserRole = process.env.SCOUT_ROLE === "browser";

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (browserRole && !browserSurface(url.pathname)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  if (url.pathname === "/api/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(healthPayload()));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    void handleApi(request, response, deps);
    return;
  }
  serveFile(url.pathname, request.headers.host, response);
});

const stopBrowser = deps.browser?.startCleanup(30_000);
const stopWatches = browserRole ? undefined : deps.watchRunner?.start(60_000);
server.on("close", () => {
  stopBrowser?.();
  stopWatches?.();
  void deps.browser?.stop();
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Scout listening on ${port}`);
  startBrowserWarm(deps.browser);
});

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  server.close(() => {
    void deps.browser?.stop().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function browserSurface(pathname: string): boolean {
  return pathname === "/api/health" || pathname === "/api/browser" || pathname.startsWith("/api/browser/");
}

function serveFile(pathname: string, hostHeader: string | undefined, response: ServerResponse): void {
  const landing = mainLandingFile(root, hostHeader, pathname);
  if (landing && existsSync(landing)) {
    send(response, landing);
    return;
  }
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = safeFile(requested);
  if (file && existsSync(file) && statSync(file).isFile()) {
    send(response, file);
    return;
  }
  const home = join(dist, "index.html");
  if (existsSync(home)) {
    send(response, home);
    return;
  }
  response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
  response.end("Scout page is not built.");
}

function safeFile(relative: string): string | null {
  const file = normalize(join(dist, relative));
  if (file !== dist && !file.startsWith(dist + sep)) return null;
  return file;
}

function send(response: ServerResponse, file: string): void {
  const body = readFileSync(file);
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  response.writeHead(200, { "content-type": type, "cache-control": extname(file) === ".html" ? "no-cache" : "public, max-age=3600" });
  response.end(body);
}
