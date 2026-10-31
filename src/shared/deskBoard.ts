import { isCartSnapshot, isQuoteSnapshot, isReceiptSnapshot, type CartSnapshot, type QuoteSnapshot, type ReceiptSnapshot } from "./commerce.ts";
import { isPayLink, type PayLink } from "./payLink.ts";
import type { Listing } from "./event.ts";
import { isAgentId, type AgentId } from "./hosts.ts";
import type { BrowserControl } from "./browse.ts";
import { isThinkingTurn, type ThinkingTurn } from "./thinking.ts";

export type DeskTurn =
  | { kind: "user"; text: string }
  | { kind: "text"; text: string }
  | { kind: "note"; text: string }
  | ThinkingTurn
  | { kind: "cart"; cart: CartSnapshot }
  | { kind: "quote"; quote: QuoteSnapshot }
  | { kind: "receipt"; receipt: ReceiptSnapshot }
  | { kind: "pay"; pay: PayLink }
  | { kind: "task"; taskId: string; skill: string; title: string }
  | { kind: "card"; listing: Listing };

export type { ThinkingTurn };

export type DeskConversation = {
  id: string;
  sessionId: string;
  agent: AgentId;
  title: string;
  turns: DeskTurn[];
  activity: string[];
  updatedAt: number;
  browserSessionId?: string;
  browserControls?: BrowserControl[];
};

export function deskConversations(parsed: unknown): DeskConversation[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isDeskConversation).slice(0, 30);
}

export function mergeDesk(local: readonly DeskConversation[], remote: readonly DeskConversation[]): DeskConversation[] {
  const byId = new Map<string, DeskConversation>();
  for (const item of remote) byId.set(item.id, item);
  for (const item of local) {
    const other = byId.get(item.id);
    if (!other || item.updatedAt >= other.updatedAt) byId.set(item.id, item);
  }
  return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 30);
}

function isDeskConversation(value: unknown): value is DeskConversation {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<DeskConversation>;
  if (typeof row.updatedAt !== "number") row.updatedAt = 0;
  if (typeof row.title !== "string") row.title = "New chat";
  return typeof row.id === "string"
    && typeof row.sessionId === "string"
    && isAgentId(row.agent)
    && Array.isArray(row.turns)
    && row.turns.every(isDeskTurn)
    && Array.isArray(row.activity)
    && row.activity.every((line) => typeof line === "string");
}

function isDeskTurn(value: unknown): value is DeskTurn {
  if (!value || typeof value !== "object") return false;
  const turn = value as { kind?: unknown; text?: unknown; listing?: unknown; cart?: unknown; quote?: unknown; receipt?: unknown; pay?: unknown; taskId?: unknown; skill?: unknown; title?: unknown };
  switch (turn.kind) {
    case "user":
    case "text":
    case "note":
      return typeof turn.text === "string";
    case "thinking":
      return isThinkingTurn(value);
    case "card":
      return typeof turn.listing === "object" && turn.listing != null;
    case "cart":
      return isCartSnapshot(turn.cart);
    case "quote":
      return isQuoteSnapshot(turn.quote);
    case "receipt":
      return isReceiptSnapshot(turn.receipt);
    case "pay":
      return isPayLink(turn.pay);
    case "task":
      return typeof turn.taskId === "string" && /^[a-f0-9]{32}$/.test(turn.taskId) && typeof turn.skill === "string" && typeof turn.title === "string";
    default:
      return false;
  }
}
