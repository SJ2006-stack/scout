import type { DeviceAction, DeviceStatus } from "../shared/deviceActions.ts";
import { readDeviceResult } from "../shared/deviceActions.ts";
import { apiUrl, backendHeaders } from "./backend.ts";

type NativeWindow = Window & { ScoutNative?: { request?: (json: string) => string } };

const handled = new Set<string>();

/** Runs a Scout phone action through the Android bridge and returns the line to show in chat. */
export function runDeviceAction(action: DeviceAction, sessionId?: string): string | null {
  if (handled.has(action.id)) return null;
  handled.add(action.id);
  if (action.expiresAt < Date.now()) return `${action.summary}: this request expired. Ask again.`;
  const request = (window as NativeWindow).ScoutNative?.request;
  if (typeof request !== "function") return `${action.summary}. Open the Scout app on your phone to run phone actions.`;
  let status: DeviceStatus = "failed";
  let message = "The phone did not answer.";
  try {
    const result = readDeviceResult(JSON.parse(request(JSON.stringify({ op: "action", action }))));
    if (result) {
      status = result.status;
      message = result.message;
    }
  } catch {
    message = "This version of the Scout app cannot run phone actions yet. Update the app.";
  }
  void fetch(apiUrl("/api/actions/result"), {
    method: "POST",
    headers: backendHeaders({ "content-type": "application/json" }, sessionId),
    body: JSON.stringify({ op: "action", id: action.id, status, message }),
  }).catch(() => undefined);
  return statusLine(action.summary, status, message);
}

/** Listens for results the phone reports later, such as after the user taps Allow. */
export function watchDeviceResults(onLine: (line: string) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== "string") return;
    let result: ReturnType<typeof readDeviceResult> = null;
    try {
      const parsed = JSON.parse(detail) as { op?: unknown };
      if (parsed.op === "action") result = readDeviceResult(parsed);
    } catch {
      return;
    }
    if (!result) return;
    void fetch(apiUrl("/api/actions/result"), {
      method: "POST",
      headers: backendHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ op: "action", id: result.id, status: result.status, message: result.message }),
    }).catch(() => undefined);
    onLine(statusLine("Phone action", result.status, result.message));
  };
  window.addEventListener("scout-native", listener);
  return () => window.removeEventListener("scout-native", listener);
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
