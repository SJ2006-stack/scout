import type { IncomingMessage, ServerResponse } from "node:http";
import { writeEvents } from "../sseWriter.ts";
import { browserOwner } from "../session.ts";
import type { BrowserWorker } from "./worker.ts";

type BrowserDeps = {
  browser?: BrowserWorker;
};

export async function routeBrowser(request: IncomingMessage, response: ServerResponse, url: URL, deps: BrowserDeps): Promise<void> {
  const worker = deps.browser;
  if (!worker) {
    sendJson(response, 503, { error: "Browser worker is not enabled on this server." });
    return;
  }
  const ownerId = browserOwner(request, response);
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/browser/sessions") {
    await reply(response, await worker.list(ownerId));
    return;
  }
  if (request.method === "POST" && path === "/api/browser/sessions") {
    const body = await readJson(request);
    if (!body.ok) {
      sendJson(response, 400, { error: body.error });
      return;
    }
    const parsed = parseCreate(body.value);
    if (!parsed.ok) {
      sendJson(response, parsed.status, { error: parsed.error });
      return;
    }
    await reply(response, await worker.create(ownerId, parsed.url, parsed.taskId));
    return;
  }
  const taskEvents = path.match(/^\/api\/browser\/tasks\/([a-f0-9]{32})\/events$/);
  if (taskEvents) {
    if (request.method !== "GET") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    await reply(response, await worker.eventsFor(ownerId, taskEvents[1] ?? ""));
    return;
  }
  const sessionPath = path.match(/^\/api\/browser\/sessions\/([a-f0-9]{32})(?:\/(navigate|snapshot|click|fill|pause|resume|close))?$/);
  if (!sessionPath) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  const sessionId = sessionPath[1] ?? "";
  const action = sessionAction(sessionPath[2]);
  if (request.method === "GET" && action == null) {
    await reply(response, await worker.status(ownerId, sessionId));
    return;
  }
  if (request.method === "GET" && action === "snapshot") {
    await reply(response, await worker.snapshot(ownerId, sessionId));
    return;
  }
  if (request.method !== "POST" || action == null) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  switch (action) {
    case "pause":
      await reply(response, await worker.pause(ownerId, sessionId));
      return;
    case "resume":
      await reply(response, await worker.resume(ownerId, sessionId));
      return;
    case "close":
      await reply(response, await worker.close(ownerId, sessionId));
      return;
    case "navigate": {
      const body = await readJson(request);
      if (!body.ok) {
        sendJson(response, 400, { error: body.error });
        return;
      }
      const parsed = parseUrl(body.value);
      if (!parsed.ok) {
        sendJson(response, 400, { error: parsed.error });
        return;
      }
      await reply(response, await worker.navigate(ownerId, sessionId, parsed.url));
      return;
    }
    case "click": {
      const body = await readJson(request);
      if (!body.ok) {
        sendJson(response, 400, { error: body.error });
        return;
      }
      const ref = parseRef(body.value);
      if (!ref.ok) {
        sendJson(response, 400, { error: ref.error });
        return;
      }
      await reply(response, await worker.click(ownerId, sessionId, ref.ref));
      return;
    }
    case "fill": {
      const body = await readJson(request);
      if (!body.ok) {
        sendJson(response, 400, { error: body.error });
        return;
      }
      const parsed = parseFill(body.value);
      if (!parsed.ok) {
        sendJson(response, 400, { error: parsed.error });
        return;
      }
      await reply(response, await worker.fill(ownerId, sessionId, parsed.ref, parsed.value));
      return;
    }
    case "snapshot":
      sendJson(response, 404, { error: "Not found" });
      return;
    default: {
      const neverAction: never = action;
      sendJson(response, 404, { error: "Not found" });
      return neverAction;
    }
  }
}

type SessionAction = "navigate" | "snapshot" | "click" | "fill" | "pause" | "resume" | "close";

function sessionAction(value: string | undefined): SessionAction | null {
  switch (value) {
    case "navigate":
    case "snapshot":
    case "click":
    case "fill":
    case "pause":
    case "resume":
    case "close":
      return value;
    default:
      return null;
  }
}

function parseCreate(value: unknown): { ok: true; url: string; taskId: string | null } | { ok: false; status: number; error: string } {
  const url = parseUrl(value);
  if (!url.ok) return { ok: false, status: 400, error: url.error };
  if (!value || typeof value !== "object") return { ok: true, url: url.url, taskId: null };
  const taskId = (value as Record<string, unknown>).taskId;
  if (taskId == null) return { ok: true, url: url.url, taskId: null };
  if (typeof taskId !== "string" || !/^[a-f0-9]{32}$/.test(taskId)) return { ok: false, status: 404, error: "That task was not found." };
  return { ok: true, url: url.url, taskId };
}

function parseUrl(value: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "Send a URL." };
  const url = (value as Record<string, unknown>).url;
  if (typeof url !== "string" || url.trim().length === 0) return { ok: false, error: "Send a URL." };
  return { ok: true, url };
}

function parseRef(value: unknown): { ok: true; ref: string } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "Choose an element from the page snapshot." };
  const ref = (value as Record<string, unknown>).ref;
  if (typeof ref !== "string" || !/^e[1-9][0-9]{0,3}$/.test(ref)) return { ok: false, error: "Choose an element from the page snapshot." };
  return { ok: true, ref };
}

function parseFill(value: unknown): { ok: true; ref: string; value: string } | { ok: false; error: string } {
  const ref = parseRef(value);
  if (!ref.ok) return ref;
  if (!value || typeof value !== "object") return { ok: false, error: "Choose an element from the page snapshot." };
  const text = (value as Record<string, unknown>).value;
  if (typeof text !== "string") return { ok: false, error: "Send the text to type." };
  if (text.length > 2_000) return { ok: false, error: "That text is too long." };
  return { ok: true, ref: ref.ref, value: text };
}

async function reply(response: ServerResponse, result: Awaited<ReturnType<BrowserWorker["status"]>>): Promise<void> {
  if (result.kind === "json") {
    sendJson(response, result.httpStatus, result.body);
    return;
  }
  await writeEvents(response, async (emit) => {
    for (const event of result.events) emit(event);
  });
}

async function readJson(request: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 20_000) return { ok: false, error: "Request is too large." };
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) return { ok: false, error: "Send a JSON object." };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "Request was not valid JSON." };
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}
