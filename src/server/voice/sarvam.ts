const STT_URL = "https://api.vachana.ai/stt/v3";
const STT_MODEL = "prisma-v3.0";
// transliterate writes the whole clip in Latin letters, including Hindi words.
const STT_FORMAT = "transliterate";
const STT_LANGUAGE = "indic-auto";

export type VoiceDeps = {
  gnaniApiKey?: string;
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
  return null;
}

async function transcribe(
  raw: Uint8Array,
  contentType: string,
  deps: VoiceDeps,
): Promise<{ status: number; body: unknown }> {
  const key = deps.gnaniApiKey?.trim() ?? "";
  if (key.length === 0) return { status: 503, body: { error: "Voice is off until GNANI_API_KEY is set." } };
  if (raw.byteLength === 0) return { status: 400, body: { error: "The recording was empty." } };
  const mime = contentType.split(";")[0]?.trim() || "audio/webm";
  const form = new FormData();
  form.set("audio_file", new Blob([new Uint8Array(raw)], { type: mime }), fileName(mime));
  form.set("model", STT_MODEL);
  form.set("format", STT_FORMAT);
  form.set("language_code", STT_LANGUAGE);
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(STT_URL, {
      method: "POST",
      headers: { "X-API-Key-ID": key },
      body: form,
    });
  } catch {
    return { status: 502, body: { error: "Gnani could not be reached." } };
  }
  const payload = await readPayload(response);
  if (!response.ok) return { status: 502, body: { error: gnaniError(response.status) } };
  const text = transcriptOf(payload);
  if (text.length === 0) return { status: 422, body: { error: "No speech was heard." } };
  return { status: 200, body: { text } };
}

function fileName(mime: string): string {
  if (mime.includes("wav")) return "speech.wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "speech.mp3";
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "speech.m4a";
  if (mime.includes("ogg")) return "speech.ogg";
  if (mime.includes("flac")) return "speech.flac";
  return "speech.webm";
}

function transcriptOf(payload: unknown): string {
  if (typeof payload !== "object" || payload == null) return "";
  if ("transcript" in payload && typeof payload.transcript === "string") return payload.transcript.trim();
  if ("text" in payload && typeof payload.text === "string") return payload.text.trim();
  return "";
}

function gnaniError(status: number): string {
  if (status === 401 || status === 403) return "The Gnani key was refused.";
  return "Gnani could not complete that.";
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}
