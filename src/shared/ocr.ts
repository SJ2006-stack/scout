export const OCR_BYTES = 4_500_000;

const KINDS: Record<string, string> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};

export function ocrMediaType(contentType: string): string | null {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return KINDS[mime] ?? null;
}

export function textFromOcrContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const lines: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") continue;
    const text = record.text.trim();
    if (text.length > 0) lines.push(text);
  }
  return lines.join("\n");
}

export function attachOcrText(draft: string, read: string): string {
  const text = read.trim();
  if (text.length === 0) return draft;
  const base = draft.trimEnd();
  if (base.length === 0) return text;
  return `${base}\n${text}`;
}
