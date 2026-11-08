import { attachOcrText, OCR_BYTES } from "./ocr.ts";

/** Limits the Android app applies when it receives a share. The page checks them again. */
export const DROP_IMAGES = 4;
export const DROP_TEXT_CHARS = 20_000;
const DROP_URLS = 5;
const DROP_ID = /^[a-f0-9]{24}$/;
const DROP_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type DropImage = { id: string; mime: string; bytes: number };

/** Something shared to Scout from another app, waiting for review. Never sent until the person taps Send. */
export type SharedDrop = {
  id: string;
  text: string;
  subject: string | null;
  urls: string[];
  notes: string[];
  images: DropImage[];
};

/** Validates the app's `drop_take` reply. Anything malformed is treated as no share. */
export function readDrop(value: unknown): SharedDrop | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !DROP_ID.test(record.id)) return null;
  const text = typeof record.text === "string" ? record.text.slice(0, DROP_TEXT_CHARS) : "";
  const subject = typeof record.subject === "string" && record.subject.trim().length > 0 ? record.subject.trim().slice(0, 300) : null;
  const urls = strings(record.urls).filter(isWebLink).slice(0, DROP_URLS);
  const notes = strings(record.notes).slice(0, 8);
  const images = (Array.isArray(record.images) ? record.images : [])
    .map(readImage)
    .filter((image): image is DropImage => image != null)
    .slice(0, DROP_IMAGES);
  if (text.trim().length === 0 && subject == null && images.length === 0) return null;
  return { id: record.id, text, subject, urls, notes, images };
}

/** The editable text the preview starts with: the title line, then what was shared. */
export function dropDraft(drop: SharedDrop): string {
  const text = drop.text.trim();
  if (drop.subject == null || text.includes(drop.subject)) return text;
  return text.length === 0 ? drop.subject : `${drop.subject}\n${text}`;
}

/** The message sent after review: the edited text, then the text read from each kept image. */
export function dropMessage(draft: string, reads: string[]): string {
  return reads.reduce((message, read) => attachOcrText(message, read), draft.trim()).trim();
}

/** A short label for a shared link. The link itself is shown, never opened by Scout. */
export function linkLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const label = `${parsed.hostname.replace(/^www\./, "")}${path}`;
    return label.length > 60 ? `${label.slice(0, 59)}…` : label;
  } catch {
    return url.slice(0, 60);
  }
}

function readImage(value: unknown): DropImage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !DROP_ID.test(record.id)) return null;
  if (typeof record.mime !== "string" || !DROP_TYPES.has(record.mime)) return null;
  if (typeof record.bytes !== "number" || !Number.isFinite(record.bytes) || record.bytes <= 0 || record.bytes > OCR_BYTES) return null;
  return { id: record.id, mime: record.mime, bytes: record.bytes };
}

function isWebLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname.length > 0 && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}
