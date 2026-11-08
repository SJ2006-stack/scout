import type { DeviceAction, DeviceResult, DeviceStatus, PhoneAutomation } from "../shared/deviceActions.ts";
import { DEVICE_ACTION_TTL_MS, readAppCartResult, readAppEventResult, readDeviceResult, readPhoneAutomation } from "../shared/deviceActions.ts";
import { applyPhoneResult, phoneRunFromAction, type PhoneRun } from "../shared/phoneRun.ts";
import { apiUrl, backendHeaders } from "./backend.ts";

type NativeWindow = Window & { ScoutNative?: { request?: (json: string) => string } };

const handled = new Set<string>();
const AUTOMATION_TTL_MS = 30_000;
let automation: { at: number; value: PhoneAutomation | null } | null = null;

/** Runs a Scout phone action through the Android bridge and returns the line to show in chat. */
export function runDeviceAction(action: DeviceAction, sessionId?: string): string | null {
  if (handled.has(action.id)) return null;
  handled.add(action.id);
  if (action.expiresAt < Date.now()) return `${action.summary}: this request expired. Ask again.`;
  const request = bridge();
  if (!request) return `${action.summary}. Open the Scout app on your phone to run phone actions.`;
  const result = callBridge(request, action);
  report(result, sessionId);
  return statusLine(action.summary, result.status, result.message);
}

/** Runs app_cart_add or app_event_book and returns the card to show; later results update it through watchDeviceResults. */
export function runAppAction(action: DeviceAction, sessionId?: string): PhoneRun | null {
  const run = phoneRunFromAction(action);
  if (!run || handled.has(action.id)) return null;
  handled.add(action.id);
  if (action.expiresAt < Date.now()) return { ...run, status: "failed", message: "This request expired. Ask again." };
  const request = bridge();
  if (!request) return { ...run, status: "failed", message: "Open the Scout app on your phone to let Scout work in the app." };
  const result = callBridge(request, action);
  report(result, sessionId);
  return applyPhoneResult(run, result);
}

/** Listens for results the phone reports later, such as after the user taps Allow. */
export function watchDeviceResults(onResult: (result: DeviceResult, line: string) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== "string") return;
    let result: DeviceResult | null = null;
    try {
      const parsed = JSON.parse(detail) as { op?: unknown };
      if (parsed.op === "action") result = readDeviceResult(parsed);
    } catch {
      return;
    }
    if (!result) return;
    report(result);
    onResult(result, statusLine("Phone action", result.status, result.message));
  };
  window.addEventListener("scout-native", listener);
  return () => window.removeEventListener("scout-native", listener);
}

/** What the Scout app says it can automate, read through get_capabilities and kept briefly. */
export function phoneAutomation(): PhoneAutomation | null {
  const request = bridge();
  if (!request) return null;
  if (automation && Date.now() - automation.at < AUTOMATION_TTL_MS) return automation.value;
  const action: DeviceAction = {
    name: "get_capabilities",
    args: {},
    id: actionId(),
    summary: "Check what this phone allows",
    confirm: false,
    expiresAt: Date.now() + DEVICE_ACTION_TTL_MS,
  };
  const result = callBridge(request, action);
  const data = result.status === "completed" && result.data && typeof result.data === "object" ? (result.data as { automation?: unknown }) : null;
  automation = { at: Date.now(), value: readPhoneAutomation(data?.automation) };
  return automation.value;
}

/** Android refuses a Java bridge method called off its object, so the request stays bound to ScoutNative. */
function bridge(): ((json: string) => string) | null {
  const native = (window as NativeWindow).ScoutNative;
  const request = native?.request;
  return native && typeof request === "function" ? (json) => request.call(native, json) : null;
}

function callBridge(request: (json: string) => string, action: DeviceAction): DeviceResult {
  try {
    const result = readDeviceResult(JSON.parse(request(JSON.stringify({ op: "action", action }))));
    return result ?? { id: action.id, status: "failed", message: "The phone did not answer." };
  } catch {
    return { id: action.id, status: "failed", message: "This version of the Scout app cannot run phone actions yet. Update the app." };
  }
}

function report(result: DeviceResult, sessionId?: string): void {
  const data = readAppCartResult(result.data) ?? readAppEventResult(result.data);
  void fetch(apiUrl("/api/actions/result"), {
    method: "POST",
    headers: backendHeaders({ "content-type": "application/json" }, sessionId),
    body: JSON.stringify({ op: "action", id: result.id, status: result.status, message: result.message, ...(data ? { data } : {}) }),
  }).catch(() => undefined);
}

export function actionId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function statusLine(summary: string, status: DeviceStatus, message: string): string {
  switch (status) {
    case "completed":
      return `Done on your phone: ${message || summary}`;
    case "handoff_started":
      return `Opened on your phone: ${message || summary}`;
    case "needs_approval":
      return `Waiting for you to allow it on the phone: ${summary}`;
    case "needs_permission":
      return `The phone needs a permission first: ${message || summary}`;
    case "failed":
      return `Could not do it on the phone: ${message || summary}`;
    default: {
      const neverStatus: never = status;
      return neverStatus;
    }
  }
}
