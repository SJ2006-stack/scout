import { isCartSnapshot, isQuoteSnapshot, isReceiptSnapshot, type CartSnapshot, type QuoteSnapshot, type ReceiptSnapshot } from "../shared/commerce.ts";
import type { Listing } from "../shared/event.ts";
import type { AgentId } from "./agents.ts";
import { newSessionId } from "./backend.ts";

const AGENT_IDS: readonly AgentId[] = ["main", "event", "travel", "food", "shop", "home", "appointments"];

const STORAGE_KEY = "scout-conversations-v1";

export type Turn =
  | { kind: "user"; text: string }
  | { kind: "text"; text: string }
  | { kind: "note"; text: string }
  | { kind: "card"; listing: Listing }
  | { kind: "cart"; cart: CartSnapshot }
  | { kind: "quote"; quote: QuoteSnapshot }
  | { kind: "receipt"; receipt: ReceiptSnapshot };

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
    return conversationsFromStorage(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

export function conversationsFromStorage(parsed: unknown): Conversation[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isConversation);
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
    && row.turns.every(isTurn)
    && Array.isArray(row.activity);
}

function isTurn(value: unknown): value is Turn {
  if (!value || typeof value !== "object") return false;
  const turn = value as { kind?: unknown; text?: unknown; listing?: unknown; cart?: unknown; quote?: unknown; receipt?: unknown };
  switch (turn.kind) {
    case "user":
    case "text":
    case "note":
      return typeof turn.text === "string";
    case "card":
      return typeof turn.listing === "object" && turn.listing != null;
    case "cart":
      return isCartSnapshot(turn.cart);
    case "quote":
      return isQuoteSnapshot(turn.quote);
    case "receipt":
      return isReceiptSnapshot(turn.receipt);
    default:
      return false;
  }
}
