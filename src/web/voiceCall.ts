import { useCallback, useEffect, useRef, useState } from "react";
import { BolnaWebCall } from "@bolna/web-call";
import type { AgentId } from "../shared/hosts.ts";
import type { LiveEvent } from "../shared/liveEvents.ts";
import { apiUrl, backendHeaders } from "./backend.ts";
import { readSse } from "./sse.ts";

export type VoiceCallState = "idle" | "connecting" | "ringing" | "active" | "ended";

type Options = {
  agent: AgentId;
  sessionId?: string;
  onLive: (event: LiveEvent) => void;
  onToast: (message: string) => void;
};

const ERRORS: Record<string, string> = {
  microphone_denied: "Allow the microphone to talk to Scout.",
  at_capacity: "All voice lines are busy. Try again in a minute.",
  autoplay_blocked: "Tap the call button again so the browser can play audio.",
  connect_failed: "The voice call could not connect. Check the network and try again.",
  call_rejected: "Bolna declined the call. Try again.",
  mint_failed: "Scout could not start a voice call.",
};

export function useVoiceCall({ agent, sessionId, onLive, onToast }: Options): { state: VoiceCallState; level: number; toggle: () => void } {
  const [state, setState] = useState<VoiceCallState>("idle");
  const [level, setLevel] = useState(0);
  const callRef = useRef<BolnaWebCall | null>(null);
  const liveRef = useRef<AbortController | null>(null);
  const handlers = useRef({ onLive, onToast });
  handlers.current = { onLive, onToast };

  const stopLive = useCallback(() => {
    liveRef.current?.abort();
    liveRef.current = null;
  }, []);

  const listen = useCallback(() => {
    stopLive();
    const controller = new AbortController();
    liveRef.current = controller;
    void fetch(apiUrl("/api/voice/live"), { headers: backendHeaders({}, sessionId), signal: controller.signal })
      .then((response) => (response.ok ? readSse<LiveEvent>(response, (event) => handlers.current.onLive(event)) : undefined))
      .catch(() => undefined);
  }, [sessionId, stopLive]);

  const toggle = useCallback(() => {
    const current = callRef.current;
    if (current && state !== "idle" && state !== "ended") {
      void current.stop();
      return;
    }
    const call = new BolnaWebCall({
      getSession: async () => {
        const response = await fetch(apiUrl("/api/voice/bolna/session"), {
          method: "POST",
          headers: backendHeaders({ "content-type": "application/json" }, sessionId),
          body: JSON.stringify({ agent }),
        });
        const body = (await response.json()) as { error?: unknown };
        if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Scout could not start a voice call.");
        return body as never;
      },
    });
    call.on("state-change", (next) => {
      setState(next);
      if (next === "ended") {
        setLevel(0);
        stopLive();
      }
    });
    call.on("volume-level", setLevel);
    call.on("error", (error) => handlers.current.onToast(ERRORS[error.code] ?? error.message));
    callRef.current = call;
    listen();
    void call.start().catch(() => stopLive());
  }, [agent, listen, sessionId, state, stopLive]);

  useEffect(
    () => () => {
      void callRef.current?.stop();
      stopLive();
    },
    [stopLive],
  );

  return { state, level, toggle };
}
