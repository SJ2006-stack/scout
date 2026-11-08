import { useEffect, useState } from "react";
import { readDrop, type DropImage, type SharedDrop } from "../shared/scoutDrop.ts";

type NativeWindow = Window & {
  ScoutNative?: { request?: (json: string) => string };
};

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

/** The share waiting in the Android app for the signed-in account, if any. */
export function takeSharedDrop(): SharedDrop | null {
  const reply = ask({ op: "drop_take" });
  return reply?.accepted === true ? readDrop(reply.drop) : null;
}

/** One shared image as a File, read from the app's private copy. Stays on the phone until sent. */
export function sharedImageFile(drop: SharedDrop, image: DropImage): File | null {
  const reply = ask({ op: "drop_file", id: drop.id, image: image.id });
  if (reply?.accepted !== true || typeof reply.data !== "string" || reply.mime !== image.mime) return null;
  try {
    const raw = atob(reply.data);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    const extension = image.mime === "image/png" ? "png" : image.mime === "image/webp" ? "webp" : "jpg";
    return new File([bytes], `shared-${image.id.slice(0, 6)}.${extension}`, { type: image.mime });
  } catch {
    return null;
  }
}

/** Tells the app to delete its copy once the share was sent or dismissed. */
export function finishSharedDrop(drop: SharedDrop): void {
  ask({ op: "drop_done", id: drop.id });
}

function isDropNudge(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  try {
    return (JSON.parse(detail) as { op?: unknown }).op === "drop";
  } catch {
    return false;
  }
}

/**
 * Pulls a pending share once the signed-in chat is showing, and again when the app says a new
 * one arrived. Content is kept only in memory here, never in localStorage.
 */
export function useSharedDrop(ready: boolean): [SharedDrop | null, (drop: SharedDrop | null) => void] {
  const [drop, setDrop] = useState<SharedDrop | null>(null);
  useEffect(() => {
    if (!ready) {
      setDrop(null);
      return;
    }
    const pull = (): void => {
      const next = takeSharedDrop();
      if (next) setDrop((current) => (current?.id === next.id ? current : next));
    };
    const onNative = (event: Event): void => {
      if (isDropNudge((event as CustomEvent<unknown>).detail)) pull();
    };
    window.addEventListener("scout-native", onNative);
    pull();
    return () => window.removeEventListener("scout-native", onNative);
  }, [ready]);
  return [drop, setDrop];
}
