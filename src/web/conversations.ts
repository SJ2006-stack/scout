import type { Listing } from "../shared/event.ts";
import type { AgentId } from "./agents.ts";
import { newSessionId } from "./backend.ts";

const AGENT_IDS: readonly AgentId[] = ["main", "event", "travel", "food", "shop", "home"];

const STORAGE_KEY = "scout-conversations-v1";

export type Turn =
  | { kind: "user"; text: string }
  | { kind: "text"; text: string }
  | { kind: "note"; text: string }
  | { kind: "card"; listing: Listing };

export type Conversation = {
  id: string;
  sessionId: string;
  agent: AgentId;
  title: string;
  turns: Turn[];
  activity: string[];
  updatedAt: number;
};

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
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isConversation);
  } catch {
    return [];
  }
}

export function saveConversations(conversations: Conversation[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations.slice(0, 30)));
}

function isConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<Conversation>;
  return typeof row.id === "string"
    && typeof row.sessionId === "string"
    && typeof row.agent === "string"
    && AGENT_IDS.includes(row.agent as AgentId)
    && Array.isArray(row.turns)
    && Array.isArray(row.activity);
}
