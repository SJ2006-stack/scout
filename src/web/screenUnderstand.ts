import { apiUrl } from "./backend.ts";
import { readScreenReading, SCREEN_BYTES, type ScreenReading } from "../shared/screenReading.ts";

const KINDS: Record<string, string> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
};

/** Sends one screenshot the user chose to share. Nothing is stored on the server. */
export async function understandScreen(file: File): Promise<ScreenReading> {
  const type = KINDS[file.type];
  if (!type) throw new Error("Send the screenshot as JPEG, PNG, or WebP.");
  if (file.size === 0) throw new Error("That screenshot was empty.");
  if (file.size > SCREEN_BYTES) throw new Error("That screenshot is too large.");
  const response = await fetch(apiUrl("/api/screen/understand"), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": type },
    body: file,
  });
  const body = (await response.json()) as { reading?: unknown; error?: unknown };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : "Scout could not read the screen right now.");
  }
  const reading = readScreenReading(body.reading);
  if (!reading) throw new Error("Scout could not make sense of that screen.");
  return reading;
}
