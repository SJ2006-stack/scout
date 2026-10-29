import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer as createViteServer } from "vite";
import { handleApi } from "./api.ts";
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

const stopBrowser = deps.browser?.startCleanup(30_000);
server.on("close", () => {
  stopBrowser?.();
  void deps.browser?.stop();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Grocery Scout listening on http://127.0.0.1:${port}`);
});
