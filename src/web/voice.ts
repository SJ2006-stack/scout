import { apiUrl } from "./backend.ts";

const VOICE_REPLIES = "scout-voice-replies";

export function voiceRepliesEnabled(): boolean {
  try {
    return localStorage.getItem(VOICE_REPLIES) === "1";
  } catch {
    return false;
  }
}

export function rememberVoiceReplies(enabled: boolean): void {
  localStorage.setItem(VOICE_REPLIES, enabled ? "1" : "0");
}

export function recordingMime(): string {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

export async function transcribeSpeech(audio: Blob): Promise<string> {
  const response = await fetch(apiUrl("/api/voice/stt"), {
    method: "POST",
    headers: { "content-type": audio.type || "audio/webm" },
    body: audio,
  });
  const body = (await response.json()) as { text?: unknown; error?: unknown };
  if (!response.ok || typeof body.text !== "string") {
    throw new Error(typeof body.error === "string" ? body.error : "Speech could not be read.");
  }
  const text = body.text.trim();
  if (text.length === 0) throw new Error("No speech was heard.");
  return text;
}

let playing: HTMLAudioElement | null = null;

export function stopSpeech(): void {
  playing?.pause();
  playing = null;
}

export async function speakReply(text: string, stillCurrent: () => boolean = () => true): Promise<void> {
  const loaded = await loadSpeech(text);
  if (!stillCurrent()) {
    URL.revokeObjectURL(loaded.url);
    return;
  }
  stopSpeech();
  playing = loaded.audio;
  await loaded.audio.play();
  if (!stillCurrent()) stopSpeech();
}

async function loadSpeech(text: string): Promise<{ audio: HTMLAudioElement; url: string }> {
  const response = await fetch(apiUrl("/api/voice/tts"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = (await response.json()) as { audio?: unknown; mediaType?: unknown; error?: unknown };
  if (!response.ok || typeof body.audio !== "string") {
    throw new Error(typeof body.error === "string" ? body.error : "Scout could not speak that.");
  }
  const mediaType = typeof body.mediaType === "string" ? body.mediaType : "audio/wav";
  const bytes = Uint8Array.from(atob(body.audio), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
  const audio = new Audio(url);
  audio.onended = () => {
    URL.revokeObjectURL(url);
    if (playing === audio) playing = null;
  };
  return { audio, url };
}

