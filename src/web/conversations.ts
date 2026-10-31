import { deskConversations, mergeDesk, type DeskConversation, type DeskTurn } from "../shared/deskBoard.ts";
import type { AgentId } from "./agents.ts";
import { newSessionId } from "./backend.ts";

const STORAGE_KEY = "scout-conversations-v1";

export type Turn = DeskTurn;
export type Conversation = DeskConversation;

export function emptyConversation(agent: AgentId, intro: string): Conversation {
  const now = Date.now();
  return {
    id: newSessionId(),
    sessionId: newSessionId(),
    agent,
    title: "New chat",
    turns: [{ kind: "text", text: intro }],
    activity: [],
    updatedAt: now,
  };
}

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return conversationsFromStorage(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

export function conversationsFromStorage(parsed: unknown): Conversation[] {
  return deskConversations(parsed);
}

export function mergeConversations(local: readonly Conversation[], remote: readonly Conversation[]): Conversation[] {
  return mergeDesk(local, remote);
}

export function saveConversations(conversations: Conversation[]): void {
  const stored = conversations.slice(0, 30).map((item) => ({
    ...item,
    turns: item.turns.filter((turn) => turn.kind !== "pay"),
  }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

