import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer as createViteServer } from "vite";
import { handleApi, handleUpgrade } from "./api.ts";
import { startBrowserWarm } from "./browser/worker.ts";
import { appRoot, createDeps, loadLocalEnv } from "./deps.ts";

loadLocalEnv();
const root = appRoot();
const port = Number(process.env.PORT ?? 8787);
const deps = createDeps();
const template = readFileSync(join(root, "index.html"), "utf8");
const server = createServer();
const vite = await createViteServer({
  root,
  appType: "custom",
  server: { middlewareMode: true, hmr: { server } },
});

server.on("request", (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname.startsWith("/api/")) {
    void handleApi(request, response, deps);
    return;
  }
  vite.middlewares(request, response, () => {
    void vite.transformIndexHtml(request.url ?? "/", template).then((html) => {
      if (response.writableEnded) return;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
    });
  });
});

server.on("upgrade", (request, socket, head) => {
  if ((request.url ?? "").startsWith("/api/relay")) handleUpgrade(request, socket, head, deps);
});

const stopBrowser = deps.browser?.startCleanup(30_000);
const stopWatches = deps.watchRunner?.start(60_000);
server.on("close", () => {
  stopBrowser?.();
  stopWatches?.();
  void deps.browser?.stop();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Grocery Scout listening on http://127.0.0.1:${port}`);
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
