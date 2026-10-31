export type NativeSpeech =
  | { kind: "recording" }
  | { kind: "text"; text: string }
  | { kind: "error"; message: string };

type NativeWindow = Window & {
  ScoutNative?: { request?: (json: string) => string };
};

export function requestNativeMicrophone(): boolean {
  const request = (window as NativeWindow).ScoutNative?.request;
  if (typeof request !== "function") return false;
  try {
    const parsed = JSON.parse(request(JSON.stringify({ op: "microphone" }))) as { accepted?: unknown };
    return parsed.accepted === true;
  } catch {
    return false;
  }
}

export function readNativeSpeech(detail: string): NativeSpeech | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as { op?: unknown; granted?: unknown; recording?: unknown; text?: unknown; error?: unknown };
  if (row.op !== "microphone") return null;
  if (typeof row.text === "string" && row.text.trim().length > 0) return { kind: "text", text: row.text.trim() };
  if (row.granted === false || typeof row.error === "string") {
    const message = typeof row.error === "string" && row.error.trim().length > 0
      ? row.error.trim()
      : "Microphone permission is needed to talk.";
    return { kind: "error", message };
  }
  if (row.recording === true) return { kind: "recording" };
  return null;
}
