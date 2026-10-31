import { stripEmoji } from "../../shared/emoji.ts";
import { spokenLanguage } from "../../shared/spoken.ts";

const STT_URL = "https://api.sarvam.ai/speech-to-text";
const TTS_URL = "https://api.sarvam.ai/text-to-speech";
const STT_MODEL = "saaras:v4";
const TTS_MODEL = "bulbul:v3";
const TTS_SPEAKER = "shubh";
const MAX_SPEECH = 2_500;

export type VoiceDeps = {
  sarvamApiKey?: string;
  fetchImpl?: typeof fetch;
};

export async function voiceResponse(
  method: string,
  pathname: string,
  raw: Uint8Array,
  contentType: string,
  deps: VoiceDeps,
): Promise<{ status: number; body: unknown } | null> {
  if (pathname === "/api/voice/stt") {
    if (method !== "POST") return { status: 405, body: { error: "Send the recording with POST." } };
    return transcribe(raw, contentType, deps);
  }
  if (pathname === "/api/voice/tts") {
    if (method !== "POST") return { status: 405, body: { error: "Send the reply with POST." } };
    return speak(raw, deps);
  }
  return null;
}

async function transcribe(
  raw: Uint8Array,
  contentType: string,
  deps: VoiceDeps,
): Promise<{ status: number; body: unknown }> {
  const key = deps.sarvamApiKey?.trim() ?? "";
  if (key.length === 0) return { status: 503, body: { error: "Voice is off until SARVAM_API_KEY is set." } };
  if (raw.byteLength === 0) return { status: 400, body: { error: "The recording was empty." } };
  const mime = contentType.split(";")[0]?.trim() || "audio/webm";
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(raw)], { type: mime }), fileName(mime));
  form.set("model", STT_MODEL);
  form.set("mode", "transcribe");
  form.set("language_code", "unknown");
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(STT_URL, {
      method: "POST",
      headers: { "api-subscription-key": key },
      body: form,
    });
  } catch {
    return { status: 502, body: { error: "Sarvam could not be reached." } };
  }
  const payload = await readPayload(response);
  if (!response.ok) return { status: 502, body: { error: sarvamError(response.status) } };
  const text = transcriptOf(payload);
  if (text.length === 0) return { status: 422, body: { error: "No speech was heard." } };
  return { status: 200, body: { text } };
}

async function speak(raw: Uint8Array, deps: VoiceDeps): Promise<{ status: number; body: unknown }> {
  const key = deps.sarvamApiKey?.trim() ?? "";
  if (key.length === 0) return { status: 503, body: { error: "Voice is off until SARVAM_API_KEY is set." } };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(raw)) as unknown;
  } catch {
    return { status: 400, body: { error: "Request was not valid JSON." } };
  }
  const text = stripEmoji(textOf(value));
  if (text.length === 0) return { status: 400, body: { error: "There is nothing to say." } };
  const clipped = text.slice(0, MAX_SPEECH);
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(TTS_URL, {
      method: "POST",
      headers: { "api-subscription-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        text: clipped,
        language_code: spokenLanguage(clipped),
        model: TTS_MODEL,
        speaker: TTS_SPEAKER,
      }),
    });
  } catch {
    return { status: 502, body: { error: "Sarvam could not be reached." } };
  }
  const payload = await readPayload(response);
  if (!response.ok) return { status: 502, body: { error: sarvamError(response.status) } };
  const audio = audioOf(payload);
  if (audio.length === 0) return { status: 502, body: { error: "Sarvam returned no audio." } };
  return { status: 200, body: { audio, mediaType: "audio/wav" } };
}

function fileName(mime: string): string {
  if (mime.includes("mp4")) return "speech.mp4";
  if (mime.includes("wav")) return "speech.wav";
  if (mime.includes("mpeg")) return "speech.mp3";
  return "speech.webm";
}

function textOf(value: unknown): string {
  if (typeof value !== "object" || value == null || !("text" in value)) return "";
  return typeof value.text === "string" ? value.text.trim() : "";
}

function transcriptOf(payload: unknown): string {
  if (typeof payload !== "object" || payload == null) return "";
  if ("transcript" in payload && typeof payload.transcript === "string") return payload.transcript.trim();
  if ("text" in payload && typeof payload.text === "string") return payload.text.trim();
  return "";
}

function audioOf(payload: unknown): string {
  if (typeof payload !== "object" || payload == null || !("audios" in payload)) return "";
  const audios = payload.audios;
  if (!Array.isArray(audios) || typeof audios[0] !== "string") return "";
  return audios[0];
}

function sarvamError(status: number): string {
  if (status === 401 || status === 403) return "The Sarvam key was refused.";
  return "Sarvam could not complete that.";
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}
