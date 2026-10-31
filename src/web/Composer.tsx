import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Mic, Phone, PhoneOff, Plus, Square, Volume2, VolumeX } from "lucide-react";
import { readNativeSpeech, requestNativeMicrophone } from "../shared/nativeSpeech.ts";
import { attachOcrText } from "../shared/ocr.ts";
import { readAttachment } from "./ocr.ts";
import { recordingMime, transcribeSpeech } from "./voice.ts";
import type { VoiceCallState } from "./voiceCall.ts";

const MAX_HEIGHT = 140;

type ComposerProps = {
  value: string;
  busy: boolean;
  placeholder: string;
  voiceReplies: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onDictate: (text: string) => void;
  onVoiceReplies: (enabled: boolean) => void;
  onStop: () => void;
  onToast: (message: string) => void;
  call?: { state: VoiceCallState; level: number; onToggle: () => void };
};

export function Composer({
  value,
  busy,
  placeholder,
  voiceReplies,
  onChange,
  onSend,
  onDictate,
  onVoiceReplies,
  onStop,
  onToast,
  call,
}: ComposerProps) {
  const onCall = call != null && call.state !== "idle" && call.state !== "ended";
  const empty = value.trim().length === 0;
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [reading, setReading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  useEffect(() => () => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }, []);

  useEffect(() => {
    const onNative = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (typeof detail !== "string") return;
      const speech = readNativeSpeech(detail);
      if (speech == null) return;
      switch (speech.kind) {
        case "recording":
          setListening(true);
          return;
        case "text":
          setListening(false);
          onDictate(speech.text);
          return;
        case "error":
          setListening(false);
          onToast(speech.message);
          return;
        default: {
          const neverSpeech: never = speech;
          return neverSpeech;
        }
      }
    };
    window.addEventListener("scout-native", onNative);
    return () => window.removeEventListener("scout-native", onNative);
  }, [onDictate, onToast]);

  async function toggleMic(): Promise<void> {
    if (listening) {
      if (recorder.current) recorder.current.stop();
      else requestNativeMicrophone();
      return;
    }
    if (busy) {
      onToast("Wait for the current reply.");
      return;
    }
    if (requestNativeMicrophone()) return;
    await recordClip();
  }

  async function recordClip(): Promise<void> {
    const mime = recordingMime();
    if (mime.length === 0) {
      onToast("This browser cannot record audio.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      onToast("Microphone permission is needed to talk.");
      return;
    }
    const media = new MediaRecorder(stream, { mimeType: mime });
    chunks.current = [];
    media.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.current.push(event.data);
    };
    media.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      setListening(false);
      const audio = new Blob(chunks.current, { type: mime });
      recorder.current = null;
      setTranscribing(true);
      void transcribeSpeech(audio)
        .then((text) => onDictate(text))
        .catch((error: unknown) => {
          onToast(error instanceof Error ? error.message : "Speech could not be read.");
        })
        .finally(() => setTranscribing(false));
    };
    recorder.current = media;
    media.start();
    setListening(true);
  }

  async function attach(file: File): Promise<void> {
    if (busy || reading) {
      onToast("Wait for the current reply.");
      return;
    }
    setReading(true);
    try {
      onChange(attachOcrText(value, await readAttachment(file)));
    } catch (error: unknown) {
      onToast(error instanceof Error ? error.message : "That image could not be read.");
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!busy && !empty) onSend();
  }

  const hint = onCall
    ? call.state === "active"
      ? "On a voice call with Scout. Just talk."
      : "Connecting the voice call…"
    : listening
    ? "Listening… tap the mic when you're done"
    : transcribing
      ? "Turning your voice into text…"
      : reading
        ? "Reading your image…"
        : placeholder;

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && !empty) onSend();
      }}
    >
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void attach(file);
        }}
      />
      <div className={listening ? "composer-field is-listening" : "composer-field"}>
        <button
          className="icon-button composer-plus"
          type="button"
          aria-label={reading ? "Reading attachment" : "Add an image"}
          title="Add an image and Scout reads the text in it"
          disabled={reading}
          onClick={() => fileRef.current?.click()}
        >
          <Plus size={20} />
        </button>
        <textarea
          ref={areaRef}
          name="message"
          rows={1}
          value={value}
          placeholder={hint}
          aria-label="Message"
          autoComplete="off"
          enterKeyHint="send"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          className={voiceReplies ? "icon-button speak on" : "icon-button speak"}
          type="button"
          aria-label={voiceReplies ? "Spoken replies on" : "Spoken replies off"}
          aria-pressed={voiceReplies}
          title={voiceReplies ? "Scout reads replies aloud. Tap to turn off." : "Tap to have Scout read replies aloud."}
          onClick={() => onVoiceReplies(!voiceReplies)}
        >
          {voiceReplies ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
        <button
          className={listening ? "icon-button mic listening" : "icon-button mic"}
          type="button"
          aria-label={listening ? "Stop listening" : "Talk to Scout"}
          title={listening ? "Stop listening" : "Talk to Scout"}
          disabled={transcribing}
          onClick={() => void toggleMic()}
        >
          <Mic size={18} />
        </button>
        {call ? (
          <button
            className={onCall ? "icon-button call live" : "icon-button call"}
            type="button"
            aria-label={onCall ? "End voice call" : "Start a voice call"}
            aria-pressed={onCall}
            title={onCall ? "End the voice call" : "Talk with Scout in Hindi, English, or both"}
            style={onCall ? { boxShadow: `0 0 0 ${2 + Math.round(call.level * 8)}px rgba(34, 197, 94, 0.35)` } : undefined}
            onClick={call.onToggle}
          >
            {onCall ? <PhoneOff size={18} /> : <Phone size={18} />}
          </button>
        ) : null}
        {busy ? (
          <button className="send" type="button" aria-label="Stop" title="Stop" onClick={onStop}>
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button className="send" type="submit" aria-label="Send" title="Send" disabled={empty}>
            <ArrowUp size={18} />
          </button>
        )}
      </div>
    </form>
  );
}
