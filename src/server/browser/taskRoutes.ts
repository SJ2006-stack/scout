import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, sendJson } from "./http.ts";
import type { SessionVault } from "./sessionVault.ts";
import { SKILLS } from "./skills.ts";
import type { DeliveryPoint, StartResult, TaskRunner } from "./taskRunner.ts";

const ID = "([a-f0-9]{32})";
const DEVICE = /^[A-Za-z0-9._:-]{4,128}$/;

const REJECTIONS = {
  unknown: [404, "Scout is not waiting for that code."],
  owner: [404, "Scout is not waiting for that code."],
  token: [404, "Scout is not waiting for that code."],
  device: [403, "This phone is not paired with Scout for that sign-in."],
  expired: [410, "That code arrived too late. Start the sign-in again."],
  used: [409, "That code was already used."],
  cancelled: [410, "That sign-in was cancelled."],
  format: [400, "Send the numeric code from the message."],
} as const;

/**
 * Routes under /api/browser/scout. Returns false when the path is not one of them.
 */
export async function routeScoutTasks(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  ownerId: string,
  runner: TaskRunner | undefined,
  vault: SessionVault | null | undefined,
): Promise<boolean> {
  if (!path.startsWith("/api/browser/scout/")) return false;
  if (!runner) {
    sendJson(response, 503, { error: "Scout website tasks are not enabled on this server." });
    return true;
  }
  const method = request.method ?? "GET";
  if (method === "GET" && path === "/api/browser/scout/skills") {
    sendJson(response, 200, {
      skills: Object.values(SKILLS).map((skill) => ({ id: skill.id, name: skill.name, kind: skill.kind, login: skill.login.methods, requiredFor: skill.login.requiredFor })),
    });
    return true;
  }
  if (method === "GET" && path === "/api/browser/scout/sessions") {
    sendJson(response, 200, { sites: vault?.list(ownerId) ?? [] });
    return true;
  }
  if (method === "POST" && path === "/api/browser/scout/sessions/revoke") {
    const body = await readJson(request);
    const domain = body.ok && body.value && typeof body.value === "object" ? (body.value as Record<string, unknown>).domain : undefined;
    if (domain !== undefined && typeof domain !== "string") {
      sendJson(response, 400, { error: "Send the site to forget." });
      return true;
    }
    try {
      vault?.revoke(ownerId, domain);
    } catch {
      sendJson(response, 400, { error: "That site cannot hold a saved sign-in." });
      return true;
    }
    sendJson(response, 200, { sites: vault?.list(ownerId) ?? [] });
    return true;
  }
  if (method === "POST" && path === "/api/browser/scout/tasks") {
    const body = await readJson(request);
    if (!body.ok || !body.value || typeof body.value !== "object") {
      sendJson(response, 400, { error: "Send the task to run." });
      return true;
    }
    const input = body.value as Record<string, unknown>;
    const skill = typeof input.skill === "string" ? input.skill : "";
    if (input.action === "sign_in") return started(response, runner.signIn(ownerId, skill));
    if (input.action === "shop") {
      const query = typeof input.query === "string" ? input.query : "";
      const quantity = typeof input.quantity === "number" ? input.quantity : 1;
      return started(response, runner.shop(ownerId, skill, query, quantity, deliveryPoint(input)));
    }
    sendJson(response, 400, { error: "Choose sign_in or shop." });
    return true;
  }
  const task = path.match(new RegExp(`^/api/browser/scout/tasks/${ID}(/cancel)?$`));
  if (task) {
    const id = task[1] ?? "";
    if (method === "GET" && !task[2]) {
      const view = runner.view(ownerId, id);
      sendJson(response, view ? 200 : 404, view ? { task: view } : { error: "That task was not found." });
      return true;
    }
    if (method === "POST" && task[2]) {
      sendJson(response, runner.cancel(ownerId, id) ? 200 : 404, runner.view(ownerId, id) ? { task: runner.view(ownerId, id) } : { error: "That task was not found." });
      return true;
    }
  }
  const checkout = path.match(new RegExp(`^/api/browser/scout/checkouts/${ID}/(approve|confirm)$`));
  if (checkout && method === "POST") {
    const id = checkout[1] ?? "";
    if (checkout[2] === "confirm") return started(response, runner.confirm(ownerId, id));
    const body = await readJson(request);
    const input = body.ok && body.value && typeof body.value === "object" ? (body.value as Record<string, unknown>) : {};
    const fingerprint = typeof input.fingerprint === "string" ? input.fingerprint : "";
    const key = typeof input.idempotencyKey === "string" ? input.idempotencyKey : "";
    if (!/^[a-f0-9]{32}$/.test(fingerprint) || !/^[A-Za-z0-9_-]{8,80}$/.test(key)) {
      sendJson(response, 400, { error: "Approve the cart shown on screen." });
      return true;
    }
    return started(response, runner.approve(ownerId, id, fingerprint, key));
  }
  const challenge = path.match(new RegExp(`^/api/browser/scout/challenges/${ID}/code$`));
  if (challenge && method === "POST") {
    const body = await readJson(request);
    const input = body.ok && body.value && typeof body.value === "object" ? (body.value as Record<string, unknown>) : {};
    submitted(response, runner.submitCode({
      userId: ownerId,
      deviceId: null,
      manual: true,
      challengeId: challenge[1] ?? "",
      token: typeof input.token === "string" ? input.token : "",
      code: typeof input.code === "string" ? input.code.trim() : "",
    }));
    return true;
  }
  sendJson(response, 404, { error: "Not found" });
  return true;
}

/** A code relayed by the companion app for a challenge it was told about. */
export function relayChallengeCode(
  runner: TaskRunner,
  ownerId: string,
  challengeId: string,
  value: unknown,
): { status: number; body: unknown } {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const deviceId = typeof input.deviceId === "string" && DEVICE.test(input.deviceId) ? input.deviceId : null;
  const result = runner.submitCode({
    userId: ownerId,
    deviceId,
    manual: false,
    challengeId,
    token: typeof input.token === "string" ? input.token : "",
    code: typeof input.code === "string" ? input.code.trim() : "",
  });
  if (result.ok) return { status: 200, body: { accepted: true } };
  const [status, error] = REJECTIONS[result.reason];
  return { status, body: { error } };
}

function started(response: ServerResponse, result: StartResult): true {
  if (result.ok) sendJson(response, 202, { task: result.task });
  else sendJson(response, result.status, { error: result.error });
  return true;
}

function submitted(response: ServerResponse, result: ReturnType<TaskRunner["submitCode"]>): void {
  if (result.ok) {
    sendJson(response, 200, { accepted: true });
    return;
  }
  const [status, error] = REJECTIONS[result.reason];
  sendJson(response, status, { error });
}

function deliveryPoint(input: Record<string, unknown>): DeliveryPoint {
  const area = typeof input.area === "string" ? input.area.trim().slice(0, 80) : "";
  const latitude = typeof input.latitude === "number" ? input.latitude : NaN;
  const longitude = typeof input.longitude === "number" ? input.longitude : NaN;
  const located = Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
  return { area: area.length >= 3 ? area : null, ...(located ? { geolocation: { latitude, longitude } } : {}) };
}
