import { useEffect, useState } from "react";
import { SCREEN_BYTES } from "../shared/screenReading.ts";

type NativeWindow = Window & {
  ScoutNative?: { request?: (json: string) => string };
};

export type ScreenShotMeta = {
  id: string;
  mime: "image/jpeg";
  bytes: number;
  width: number;
  height: number;
  frames: number;
};

const SHOT_ID = /^[a-f0-9]{24}$/;

function ask(body: Record<string, string>): Record<string, unknown> | null {
  const native = (window as NativeWindow).ScoutNative;
  if (typeof native?.request !== "function") return null;
  try {
    const parsed = JSON.parse(native.request(JSON.stringify(body))) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** True when this WebView build can start a screen session. Older builds refuse the op. */
export function screenCaptureAvailable(): boolean {
  const reply = ask({ op: "screen_state" });
  return reply?.accepted === true;
}

export function readScreenShot(value: unknown): ScreenShotMeta | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !SHOT_ID.test(record.id)) return null;
  if (record.mime !== "image/jpeg") return null;
  if (typeof record.bytes !== "number" || !Number.isFinite(record.bytes) || record.bytes <= 0 || record.bytes > SCREEN_BYTES) return null;
  if (typeof record.width !== "number" || typeof record.height !== "number") return null;
  if (record.width < 1 || record.height < 1) return null;
  const frames = typeof record.frames === "number" && Number.isInteger(record.frames) && record.frames >= 1 && record.frames <= 6 ? record.frames : 1;
  return { id: record.id, mime: "image/jpeg", bytes: record.bytes, width: record.width, height: record.height, frames };
}

export function screenState(): { state: string; reason: string | null; message: string | null; shot: ScreenShotMeta | null } | null {
  const reply = ask({ op: "screen_state" });
  if (reply?.accepted !== true) return null;
  return {
    state: typeof reply.state === "string" ? reply.state : "idle",
    reason: typeof reply.reason === "string" ? reply.reason : null,
    message: typeof reply.message === "string" ? reply.message : null,
    shot: readScreenShot(reply.shot),
  };
}

export function startScreenCapture(): boolean {
  return ask({ op: "screen_start" })?.accepted === true;
}

export function stopScreenCapture(): void {
  ask({ op: "screen_stop" });
}

export function captureScreenFrame(): boolean {
  return ask({ op: "screen_frame" })?.accepted === true;
}

export function takeScreenShot(): ScreenShotMeta | null {
  const reply = ask({ op: "screen_take" });
  return reply?.accepted === true ? readScreenShot(reply.shot) : null;
}

export function screenShotFile(shot: ScreenShotMeta): File | null {
  const reply = ask({ op: "screen_file", id: shot.id });
  if (reply?.accepted !== true || typeof reply.data !== "string" || reply.mime !== "image/jpeg") return null;
  try {
    const raw = atob(reply.data);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    if (bytes.byteLength === 0 || bytes.byteLength > SCREEN_BYTES) return null;
    return new File([bytes], `screen-${shot.id.slice(0, 6)}.jpg`, { type: "image/jpeg" });
  } catch {
    return null;
  }
}

export function fillOpenScreen(input: { name: string; email: string; phone: string; note: string; submit: boolean }): { filled: number; submitted: boolean; message: string } | null {
  const reply = ask({
    op: "screen_fill",
    name: input.name.slice(0, 80),
    email: input.email.slice(0, 80),
    phone: input.phone.slice(0, 20),
    note: input.note.slice(0, 500),
    submit: input.submit ? "yes" : "no",
  });
  if (!reply) return null;
  return {
    filled: typeof reply.filled === "number" ? reply.filled : 0,
    submitted: reply.submitted === true,
    message: typeof reply.message === "string" ? reply.message : "",
  };
}

export function finishScreenShot(shot: ScreenShotMeta): void {
  ask({ op: "screen_done", id: shot.id });
}

function readNotice(detail: unknown): { state: string; reason: string | null; message: string | null } | null {
  if (typeof detail !== "string") return null;
  try {
    const parsed = JSON.parse(detail) as { op?: unknown; state?: unknown; reason?: unknown; message?: unknown };
    if (parsed.op !== "screen" || typeof parsed.state !== "string") return null;
    return {
      state: parsed.state,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
      message: typeof parsed.message === "string" ? parsed.message : null,
    };
  } catch {
    return null;
  }
}

export type ScreenProgress = "asking" | "starting" | "waiting" | "capturing";

export type ScreenUi =
  | { phase: "closed" }
  | { phase: "explain" }
  | { phase: "progress"; state: ScreenProgress }
  | { phase: "preview"; shot: ScreenShotMeta; file: File; url: string }
  | { phase: "error"; message: string };

function endMessage(reason: string | null, message: string | null): string | null {
  if (message) return message;
  switch (reason) {
    case "denied":
      return "Screen capture was not allowed.";
    case "notifications":
      return "Scout needs notification permission so you can stop capture from the notice.";
    case "stopped":
      return null;
    case "system":
      return "Android stopped the screen capture.";
    case "expired":
      return "Screen capture timed out. Start again when you want Scout to see the screen.";
    case "failed":
      return "Scout could not capture the screen. Try again.";
    case "signed_out":
      return null;
    default:
      return "Screen capture ended.";
  }
}

function asProgress(state: string): ScreenProgress | null {
  return state === "asking" || state === "starting" || state === "waiting" || state === "capturing" ? state : null;
}

function previewOf(shot: ScreenShotMeta): Extract<ScreenUi, { phase: "preview" }> | null {
  const file = screenShotFile(shot);
  if (!file) return null;
  return { phase: "preview", shot, file, url: URL.createObjectURL(file) };
}

function dropPreview(view: ScreenUi): void {
  if (view.phase === "preview") URL.revokeObjectURL(view.url);
}

/**
 * The in-chat screen-capture card. Opens only after the person taps Understand my screen.
 * A frame already waiting in the app is shown as a preview, never uploaded by itself.
 */
export function useScreenCapture(ready: boolean): {
  available: boolean;
  view: ScreenUi;
  open: () => void;
  close: () => void;
  start: () => void;
  stop: () => void;
  capture: () => void;
  discard: () => void;
} {
  const [available, setAvailable] = useState(false);
  const [view, setView] = useState<ScreenUi>({ phase: "closed" });

  useEffect(() => {
    if (!ready) {
      setAvailable(false);
      setView((current) => {
        dropPreview(current);
        return { phase: "closed" };
      });
      return;
    }
    setAvailable(screenCaptureAvailable());
    const pending = takeScreenShot();
    if (pending) {
      const preview = previewOf(pending);
      if (preview) setView(preview);
    } else {
      const live = screenState();
      const progress = live ? asProgress(live.state) : null;
      if (progress) setView({ phase: "progress", state: progress });
    }
    const onNative = (event: Event): void => {
      const notice = readNotice((event as CustomEvent<unknown>).detail);
      if (!notice) return;
      const progress = asProgress(notice.state);
      if (progress) {
        setView((current) => {
          dropPreview(current);
          return { phase: "progress", state: progress };
        });
        return;
      }
      if (notice.state === "captured") {
        const shot = takeScreenShot();
        const preview = shot ? previewOf(shot) : null;
        setView((current) => {
          dropPreview(current);
          return preview ?? { phase: "error", message: "Scout captured the screen but could not load the picture." };
        });
        return;
      }
      if (notice.state === "ended") {
        const text = endMessage(notice.reason, notice.message);
        setView((current) => {
          dropPreview(current);
          return text ? { phase: "error", message: text } : { phase: "closed" };
        });
      }
    };
    window.addEventListener("scout-native", onNative);
    return () => window.removeEventListener("scout-native", onNative);
  }, [ready]);

  return {
    available,
    view,
    open: () => setView({ phase: "explain" }),
    close: () => {
      setView((current) => {
        dropPreview(current);
        return { phase: "closed" };
      });
    },
    start: () => {
      if (!startScreenCapture()) setView({ phase: "error", message: "Scout could not start screen capture. Try again." });
    },
    stop: () => stopScreenCapture(),
    capture: () => {
      if (!captureScreenFrame()) setView({ phase: "error", message: "Capture is only available while Scout is watching the screen." });
    },
    discard: () => {
      setView((current) => {
        if (current.phase === "preview") finishScreenShot(current.shot);
        dropPreview(current);
        return { phase: "closed" };
      });
    },
  };
}
