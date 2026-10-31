import type { ChatEvent } from "../../shared/chatEvents.ts";

export type LiveEvent = ChatEvent | { type: "voice-user"; text: string } | { type: "voice-turn-done" };
type Listener = (event: LiveEvent) => void;

const LISTENER_LIMIT = 4;

export class LiveRelay {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(userId: string, listener: Listener): () => void {
    const set = this.listeners.get(userId) ?? new Set<Listener>();
    if (set.size >= LISTENER_LIMIT) {
      const oldest = set.values().next().value;
      if (oldest) set.delete(oldest);
    }
    set.add(listener);
    this.listeners.set(userId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(userId);
    };
  }

  publish(userId: string, event: LiveEvent): number {
    const set = this.listeners.get(userId);
    if (!set) return 0;
    for (const listener of set) listener(event);
    return set.size;
  }
}
