import { ocrMediaType, textFromOcrContent } from "../shared/ocr.ts";

const CHAT_URL = "https://api.sarvam.ai/v2/chat/completions";
/**
 * sarvam-105b is text only and rejects an image.
 * gemma4 accepts an inline image on the same Sarvam key and does not reason unless asked.
 */
const VISION_MODEL = "gemma4";
const OCR_TIMEOUT_MS = 20_000;

export type OcrDeps = {
  sarvamApiKey?: string;
  fetchImpl?: typeof fetch;
};

export async function ocrResponse(
  method: string,
  raw: Uint8Array,
  contentType: string,
  deps: OcrDeps,
): Promise<{ status: number; body: unknown }> {
  if (method !== "POST") return { status: 405, body: { error: "Send the image with POST." } };
  const key = deps.sarvamApiKey?.trim() ?? "";
  if (key.length === 0) return { status: 503, body: { error: "Attachments stay unread until SARVAM_API_KEY is set." } };
  const mediaType = ocrMediaType(contentType);
  if (!mediaType) return { status: 415, body: { error: "Use a JPEG, PNG, WebP, or GIF." } };
  if (raw.byteLength === 0) return { status: 400, body: { error: "That image was empty." } };
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(CHAT_URL, {
      method: "POST",
      headers: {
        "api-subscription-key": key,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 2048,
        messages: [
          {
            role: "system",
            content: "Transcribe every word visible in the image. Keep the original language and line breaks. Do not describe the picture. If there is no writing, reply with nothing.",
          },
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:${mediaType};base64,${Buffer.from(raw).toString("base64")}` } },
              { type: "text", text: "Read the writing in this image." },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
    });
  } catch {
    return { status: 502, body: { error: "The image could not be read." } };
  }
  if (!response.ok) return { status: 502, body: { error: "The image could not be read." } };
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: 502, body: { error: "The image could not be read." } };
  }
  const text = textFromVision(payload);
  if (text.length === 0) return { status: 422, body: { error: "No writing was found in that image." } };
  return { status: 200, body: { text } };
}

function textFromVision(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  const choice = Array.isArray(choices) ? choices[0] : null;
  const message = choice && typeof choice === "object" ? (choice as { message?: { content?: unknown } }).message : null;
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  return textFromOcrContent(content);
}
