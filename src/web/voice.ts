import { apiUrl } from "./backend.ts";

export const SPEECH_CLIP_MS = 30_000;

export function recordingMime(): string {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

const READY_AUDIO = /^audio\/(wav|x-wav|mpeg|mp3|mp4|m4a|x-m4a|aac|ogg|flac|x-flac)$/i;

export async function transcribeSpeech(audio: Blob): Promise<string> {
  const clip = await speechFile(audio);
  const response = await fetch(apiUrl("/api/voice/stt"), {
    method: "POST",
    headers: { "content-type": clip.type || "audio/wav" },
    body: clip,
  });
  const body = (await response.json()) as { text?: unknown; error?: unknown };
  if (!response.ok || typeof body.text !== "string") {
    throw new Error(typeof body.error === "string" ? body.error : "Speech could not be read.");
  }
  const text = body.text.trim();
  if (text.length === 0) throw new Error("No speech was heard.");
  return text;
}

async function speechFile(audio: Blob): Promise<Blob> {
  const type = audio.type.split(";")[0]?.trim() ?? "";
  if (READY_AUDIO.test(type)) return audio;
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await audio.arrayBuffer());
    return encodeWav(decoded);
  } catch {
    throw new Error("This recording could not be prepared for transcription.");
  } finally {
    await context.close();
  }
}

function encodeWav(audio: AudioBuffer): Blob {
  const length = audio.length;
  const samples = new Float32Array(length);
  for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
    const data = audio.getChannelData(channel);
    for (let index = 0; index < length; index += 1) samples[index] += data[index] / audio.numberOfChannels;
  }
  const bytes = new ArrayBuffer(44 + length * 2);
  const view = new DataView(bytes);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (let index = 0; index < length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Blob([bytes], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
}

