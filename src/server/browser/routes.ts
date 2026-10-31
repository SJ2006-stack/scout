import type { IncomingMessage, ServerResponse } from "node:http";
import { writeEvents } from "../sseWriter.ts";
import { browserOwner } from "../session.ts";
import type { UserDirectory } from "../db/userDirectory.ts";
import { signRuntimeTicket, verifyRuntimeTicket, type BrowserRuntimeConfig } from "./runtimeTicket.ts";
import type { BrowserWorker } from "./worker.ts";

type BrowserDeps = {
  browser?: BrowserWorker;
  directory?: UserDirectory;
  now?: () => number;
  browserRuntime?: BrowserRuntimeConfig;
};

const RUNTIME_HEADER = "x-scout-runtime";

export function browserRuntimeMaySkipSignIn(request: IncomingMessage, pathname: string, worker: BrowserWorker | undefined): boolean {
  if (!worker) return false;
  if (pathname !== "/api/browser" && !pathname.startsWith("/api/browser/")) return false;
  const header = request.headers[RUNTIME_HEADER];
  return typeof header === "string" && header.length > 0;
}

export async function routeBrowser(request: IncomingMessage, response: ServerResponse, url: URL, deps: BrowserDeps): Promise<void> {
  const worker = deps.browser;
  if (!worker) {
    await proxyBrowser(request, response, url, deps);
    return;
  }
  const owner = runtimeOwner(request, response, url, deps);
  if (!owner.ok) {
    sendJson(response, owner.status, { error: owner.error });
    return;
  }
  const ownerId = owner.ownerId;
  deps.directory?.touch(ownerId, deps.now?.() ?? Date.now());
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/browser/budget") {
    sendJson(response, 200, worker.budget());
    return;
  }
  if (request.method === "GET" && path === "/api/browser/profile") {
    await reply(response, await worker.profile(ownerId));
    return;
  }
  if (request.method === "POST" && path === "/api/browser/profile/revoke") {
    await reply(response, await worker.revokeProfile(ownerId));
    return;
  }
  if (request.method === "GET" && path === "/api/browser/sessions") {
    await reply(response, await worker.list(ownerId));
    return;
  }
  if (request.method === "POST" && path === "/api/browser/phone/open") {
    if (!isLoopback(request)) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
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
    await reply(response, await worker.openFromPhone(parsed.url));
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
  if (request.method === "POST" && path === "/api/browser/code") {
    const body = await readJson(request);
    if (!body.ok) {
      sendJson(response, 400, { error: body.error });
      return;
    }
    const code = body.value && typeof body.value === "object" ? (body.value as Record<string, unknown>).code : "";
    if (typeof code !== "string") {
      sendJson(response, 400, { error: "Send the numeric code from the message." });
      return;
    }
    await reply(response, await worker.submitOwnerCode(ownerId, code));
    return;
  }
  const taskCode = path.match(/^\/api\/browser\/tasks\/([a-f0-9]{32})\/code$/);
  if (taskCode) {
    if (request.method !== "POST") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    const body = await readJson(request);
    if (!body.ok) {
      sendJson(response, 400, { error: body.error });
      return;
    }
    const parsed = parseCode(body.value);
    if (!parsed.ok) {
      sendJson(response, parsed.status, { error: parsed.error });
      return;
    }
    await reply(response, await worker.submitCode(taskCode[1] ?? "", parsed.token, parsed.code));
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
  const sessionPath = path.match(/^\/api\/browser\/sessions\/([a-f0-9]{32})(?:\/(navigate|snapshot|click|fill|pause|resume|close|handoff))?$/);
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
    case "handoff":
      await reply(response, await worker.handoff(ownerId, sessionId));
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

type SessionAction = "navigate" | "snapshot" | "click" | "fill" | "pause" | "resume" | "close" | "handoff";

function sessionAction(value: string | undefined): SessionAction | null {
  switch (value) {
    case "navigate":
    case "snapshot":
    case "click":
    case "fill":
    case "pause":
    case "resume":
    case "close":
    case "handoff":
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

function parseCode(value: unknown): { ok: true; token: string; code: string } | { ok: false; status: number; error: string } {
  if (!value || typeof value !== "object") return { ok: false, status: 400, error: "Send the code for this task." };
  const token = (value as Record<string, unknown>).token;
  const code = (value as Record<string, unknown>).code;
  if (typeof token !== "string" || !/^[a-f0-9]{32}$/.test(token)) {
    return { ok: false, status: 404, error: "That browser task is not waiting for a code." };
  }
  if (typeof code !== "string" || !/^\d{4,8}$/.test(code)) {
    return { ok: false, status: 400, error: "Send the numeric code from the message." };
  }
  return { ok: true, token, code };
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

function runtimeOwner(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: BrowserDeps,
): { ok: true; ownerId: string } | { ok: false; status: number; error: string } {
  const header = request.headers[RUNTIME_HEADER];
  if (header == null || header === "") return { ok: true, ownerId: browserOwner(request, response) };
  if (typeof header !== "string") return { ok: false, status: 401, error: "Browser runtime ticket was rejected." };
  const key = deps.browserRuntime?.key ?? "";
  const verified = verifyRuntimeTicket(header, {
    method: request.method ?? "GET",
    pathname: url.pathname,
    now: deps.now?.() ?? Date.now(),
    key,
  });
  if (!verified.ok) return { ok: false, status: 401, error: "Browser runtime ticket was rejected." };
  return { ok: true, ownerId: verified.ownerId };
}

async function proxyBrowser(request: IncomingMessage, response: ServerResponse, url: URL, deps: BrowserDeps): Promise<void> {
  const runtime = deps.browserRuntime;
  const base = runtime?.url.trim() ?? "";
  if (base.length === 0) {
    sendJson(response, 503, { error: "Browser worker is not enabled on this server." });
    return;
  }
  const key = runtime?.key ?? "";
  if (key.length < 32) {
    sendJson(response, 503, { error: "Browser runtime is not configured." });
    return;
  }
  const target = runtimeTarget(base, url);
  if (!target) {
    sendJson(response, 503, { error: "Browser runtime is not configured." });
    return;
  }
  const ownerId = browserOwner(request, response);
  const method = request.method ?? "GET";
  const ticket = signRuntimeTicket({
    ownerId,
    method,
    pathname: url.pathname,
    now: deps.now?.() ?? Date.now(),
    key,
  });
  if (!ticket) {
    sendJson(response, 503, { error: "Browser runtime is not configured." });
    return;
  }
  const headers = new Headers();
  const contentType = request.headers["content-type"];
  if (typeof contentType === "string" && contentType.length > 0) headers.set("content-type", contentType);
  headers.set(RUNTIME_HEADER, ticket);
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const read = await readRaw(request);
    if (!read.ok) {
      sendJson(response, 400, { error: read.error });
      return;
    }
    body = read.value.length > 0 ? new Uint8Array(read.value) : undefined;
  }
  let upstream: Response;
  try {
    upstream = await fetch(target, { method, headers, body, redirect: "manual" });
  } catch {
    sendJson(response, 503, { error: "The browser runtime could not be reached." });
    return;
  }
  const outHeaders: Record<string, string | number | string[]> = { "cache-control": "no-store" };
  const type = upstream.headers.get("content-type");
  if (type) outHeaders["content-type"] = type;
  const setCookie = response.getHeader("set-cookie");
  if (setCookie !== undefined) outHeaders["set-cookie"] = setCookie;
  response.writeHead(upstream.status, outHeaders);
  const reader = upstream.body?.getReader();
  if (!reader) {
    response.end();
    return;
  }
  try {
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      if (step.value) response.write(Buffer.from(step.value));
    }
  } catch {
    // The upstream body is already being returned. Do not log it.
  } finally {
    if (!response.writableEnded) response.end();
  }
}

function runtimeTarget(base: string, url: URL): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username.length > 0 || parsed.password.length > 0) return null;
  parsed.pathname = url.pathname;
  parsed.search = url.search;
  parsed.hash = "";
  return parsed;
}

async function readRaw(request: IncomingMessage): Promise<{ ok: true; value: Buffer } | { ok: false; error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 20_000) return { ok: false, error: "Request is too large." };
    chunks.push(buffer);
  }
  return { ok: true, value: Buffer.concat(chunks) };
}

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}
