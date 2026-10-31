import { HAIKU_MODEL } from "./haikuClient.ts";
import { ocrMediaType, textFromOcrContent } from "../shared/ocr.ts";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const OCR_TIMEOUT_MS = 20_000;

export type OcrDeps = {
  anthropicApiKey?: string;
  fetchImpl?: typeof fetch;
};

export async function ocrResponse(
  method: string,
  raw: Uint8Array,
  contentType: string,
  deps: OcrDeps,
): Promise<{ status: number; body: unknown }> {
  if (method !== "POST") return { status: 405, body: { error: "Send the image with POST." } };
  const key = deps.anthropicApiKey?.trim() ?? "";
  if (key.length === 0) return { status: 503, body: { error: "Attachments stay unread until ANTHROPIC_API_KEY is set." } };
  const mediaType = ocrMediaType(contentType);
  if (!mediaType) return { status: 415, body: { error: "Use a JPEG, PNG, WebP, or GIF." } };
  if (raw.byteLength === 0) return { status: 400, body: { error: "That image was empty." } };
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(MESSAGES_URL, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 2048,
        thinking: { type: "disabled" },
        system: "Transcribe every word visible in the image. Keep the original language and line breaks. Do not describe the picture. If there is no writing, reply with nothing.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: Buffer.from(raw).toString("base64") },
              },
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
  const content = payload && typeof payload === "object" ? (payload as { content?: unknown }).content : undefined;
  const text = textFromOcrContent(content);
  if (text.length === 0) return { status: 422, body: { error: "No writing was found in that image." } };
  return { status: 200, body: { text } };
}
