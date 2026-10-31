import type { IncomingMessage, ServerResponse } from "node:http";
import { readDeviceResult } from "../shared/deviceActions.ts";
import type { InboxStore } from "./notify/inbox.ts";
import { isProfileKey, type ProfileStore } from "./profile/profileStore.ts";
import type { WatchRunner } from "./watch/watchRunner.ts";
import { isEventKind, isWatchWhen, type WatchPatch, type WatchStore } from "./watch/watchStore.ts";

export type AssistantDeps = {
  profile?: ProfileStore;
  watches?: WatchStore;
  watchRunner?: WatchRunner;
  inbox?: InboxStore;
  now: () => number;
};

const ID = "([a-f0-9]{24})";
const BODY_LIMIT = 8_000;

export function isAssistantRoute(pathname: string): boolean {
  return /^\/api\/(profile|watches|inbox|devices|actions)(\/|$)/.test(pathname);
}

export async function routeAssistant(request: IncomingMessage, response: ServerResponse, url: URL, userId: string, deps: AssistantDeps): Promise<void> {
  const method = request.method ?? "GET";
  const path = url.pathname;
  const now = deps.now();

  if (path === "/api/profile" || path.startsWith("/api/profile/")) {
    const profile = deps.profile;
    if (!profile) return send(response, 503, { error: "Memory is not enabled." });
    const key = path.slice("/api/profile/".length);
    if (method === "GET" && path === "/api/profile") return send(response, 200, { entries: profile.list(userId) });
    if (method === "DELETE" && path === "/api/profile") {
      profile.clear(userId);
      return send(response, 200, { entries: [] });
    }
    if (method === "DELETE" && isProfileKey(key)) return send(response, 200, { removed: profile.remove(userId, key), entries: profile.list(userId) });
    if (method === "PUT" && path === "/api/profile") {
      const body = await readBody(request);
      if (!body || !isProfileKey(body.key) || typeof body.value !== "string") return send(response, 400, { error: "Send a known key and a value." });
      const saved = profile.set(userId, body.key, body.value, "explicit", now);
      if (!saved.ok) return send(response, 400, { error: saved.error });
      return send(response, 200, { entry: saved.entry, entries: profile.list(userId) });
    }
    return send(response, 404, { error: "Not found" });
  }

  if (path === "/api/watches" || path.startsWith("/api/watches/")) {
    const watches = deps.watches;
    if (!watches) return send(response, 503, { error: "Scout Watch is not enabled." });
    if (method === "GET" && path === "/api/watches") return send(response, 200, { watches: watches.list(userId) });
    if (method === "POST" && path === "/api/watches") {
      const body = await readBody(request);
      const kind = body?.kind == null || body.kind === "any" ? null : isEventKind(body.kind) ? body.kind : undefined;
      if (!body || typeof body.cityId !== "string" || !isWatchWhen(body.when) || kind === undefined) return send(response, 400, { error: "Send cityId, when, kind, and budget." });
      const budget = typeof body.budget === "number" && body.budget > 0 ? Math.floor(body.budget) : null;
      const created = watches.create(userId, { cityId: body.cityId, when: body.when, kind, budget, query: typeof body.query === "string" ? body.query : "" }, now);
      return created.ok ? send(response, 201, { watch: created.watch }) : send(response, 400, { error: created.error });
    }
    const run = path.match(new RegExp(`^/api/watches/${ID}/run$`));
    if (method === "POST" && run?.[1]) {
      const watch = watches.get(userId, run[1]);
      if (!watch) return send(response, 404, { error: "That watch is gone." });
      if (!deps.watchRunner) return send(response, 503, { error: "Scout Watch is not running." });
      const check = await deps.watchRunner.check(watch);
      return send(response, 200, { check: { ok: check.ok, matched: check.matched, fresh: check.fresh.map((listing) => ({ title: listing.title, url: listing.url })), error: check.error }, watch: watches.get(userId, watch.id) });
    }
    const one = path.match(new RegExp(`^/api/watches/${ID}$`));
    if (one?.[1] && method === "DELETE") return send(response, 200, { removed: watches.remove(userId, one[1]) });
    if (one?.[1] && method === "PATCH") {
      const body = await readBody(request);
      if (!body) return send(response, 400, { error: "Send the fields to change." });
      const patch: WatchPatch = {};
      if (body.status === "active" || body.status === "paused") patch.status = body.status;
      if (isWatchWhen(body.when)) patch.when = body.when;
      if (body.kind === "any" || body.kind === null) patch.kind = null;
      else if (isEventKind(body.kind)) patch.kind = body.kind;
      if (body.budget === null || body.budget === 0) patch.budget = null;
      else if (typeof body.budget === "number") patch.budget = Math.floor(body.budget);
      if (typeof body.intervalMinutes === "number") patch.intervalMinutes = body.intervalMinutes;
      const updated = watches.update(userId, one[1], patch, now);
      return updated.ok ? send(response, 200, { watch: updated.watch }) : send(response, 400, { error: updated.error });
    }
    return send(response, 404, { error: "Not found" });
  }

  if (path === "/api/inbox" || path.startsWith("/api/inbox/")) {
    const inbox = deps.inbox;
    if (!inbox) return send(response, 503, { error: "The inbox is not enabled." });
    if (method === "GET" && path === "/api/inbox") return send(response, 200, { items: inbox.list(userId) });
    const read = path.match(new RegExp(`^/api/inbox/${ID}/read$`));
    if (method === "POST" && read?.[1]) return send(response, 200, { read: inbox.markRead(userId, read[1], now) });
    return send(response, 404, { error: "Not found" });
  }

  if (method === "POST" && path === "/api/devices") {
    const inbox = deps.inbox;
    if (!inbox) return send(response, 503, { error: "Device registration is not enabled." });
    const body = await readBody(request);
    if (!body || typeof body.deviceId !== "string" || typeof body.pushToken !== "string") return send(response, 400, { error: "Send deviceId and pushToken." });
    const saved = inbox.saveDevice(userId, body.deviceId, body.pushToken, typeof body.platform === "string" ? body.platform : "android", now);
    return saved ? send(response, 200, { registered: true }) : send(response, 400, { error: "That device or push token is not valid." });
  }

  if (method === "POST" && path === "/api/actions/result") {
    const body = await readBody(request);
    const result = readDeviceResult(body);
    if (!result) return send(response, 400, { error: "Send an action id and status." });
    console.log(`phone action ${result.id} ${result.status}`);
    return send(response, 200, { recorded: true });
  }

  send(response, 404, { error: "Not found" });
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) return null;
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
