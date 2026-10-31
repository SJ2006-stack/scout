import { apiUrl } from "./backend.ts";
import { OCR_BYTES, ocrMediaType } from "../shared/ocr.ts";

export async function readAttachment(file: File): Promise<string> {
  const type = ocrMediaType(file.type);
  if (!type) throw new Error("Use a JPEG, PNG, WebP, or GIF.");
  if (file.size === 0) throw new Error("That image was empty.");
  if (file.size > OCR_BYTES) throw new Error("That image is too large.");
  const response = await fetch(apiUrl("/api/ocr"), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": type },
    body: file,
  });
  const body = (await response.json()) as { text?: unknown; error?: unknown };
  if (!response.ok || typeof body.text !== "string") {
    throw new Error(typeof body.error === "string" ? body.error : "That image could not be read.");
  }
  const text = body.text.trim();
  if (text.length === 0) throw new Error("No writing was found in that image.");
  return text;
}
