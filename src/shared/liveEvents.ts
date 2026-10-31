import type { ChatEvent } from "./chatEvents.ts";

/** Events relayed to the open chat while a Bolna voice call is running. */
export type LiveEvent = ChatEvent | { type: "voice-user"; text: string } | { type: "voice-turn-done" };
