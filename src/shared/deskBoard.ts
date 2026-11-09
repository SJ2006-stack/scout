import { readCartEstimate, type CartEstimate } from "./cartQuote.ts";
import { readBusResult, readErrandForm, readFlightResult, type BusResult, type ErrandForm, type FlightResult } from "./errands.ts";
import { isCartSnapshot, isQuoteSnapshot, isReceiptSnapshot, type CartSnapshot, type QuoteSnapshot, type ReceiptSnapshot } from "./commerce.ts";
import { isPayLink, type PayLink } from "./payLink.ts";
import { readPlaces, type SavedPlace } from "./places.ts";
import { isPhoneRun, type PhoneRun } from "./phoneRun.ts";
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
  | { kind: "estimate"; estimate: CartEstimate }
  | { kind: "form"; form: ErrandForm; answered: boolean }
  | { kind: "buses"; buses: BusResult }
  | { kind: "flights"; flights: FlightResult }
  | { kind: "places"; places: SavedPlace[] }
  | { kind: "receipt"; receipt: ReceiptSnapshot }
  | { kind: "pay"; pay: PayLink }
  | { kind: "task"; taskId: string; skill: string; title: string }
  | { kind: "phone"; run: PhoneRun }
  | { kind: "card"; listing: Listing }
  | { kind: "more"; listings: Listing[] };

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
  const turn = value as { kind?: unknown; text?: unknown; listing?: unknown; listings?: unknown; cart?: unknown; quote?: unknown; estimate?: unknown; form?: unknown; answered?: unknown; buses?: unknown; receipt?: unknown; pay?: unknown; taskId?: unknown; skill?: unknown; title?: unknown; run?: unknown };
  switch (turn.kind) {
    case "user":
    case "text":
    case "note":
      return typeof turn.text === "string";
    case "thinking":
      return isThinkingTurn(value);
    case "card":
      return typeof turn.listing === "object" && turn.listing != null;
    case "more":
      return Array.isArray(turn.listings) && turn.listings.every((listing) => typeof listing === "object" && listing != null);
    case "cart":
      return isCartSnapshot(turn.cart);
    case "quote":
      return isQuoteSnapshot(turn.quote);
    case "estimate":
      return readCartEstimate(turn.estimate) !== null;
    case "form":
      return readErrandForm(turn.form) !== null && typeof turn.answered === "boolean";
    case "buses":
      return readBusResult(turn.buses) !== null;
    case "flights":
      return readFlightResult((turn as { flights?: unknown }).flights) !== null;
    case "places":
      return readPlaces((turn as { places?: unknown }).places) !== null;
    case "receipt":
      return isReceiptSnapshot(turn.receipt);
    case "pay":
      return isPayLink(turn.pay);
    case "task":
      return typeof turn.taskId === "string" && /^[a-f0-9]{32}$/.test(turn.taskId) && typeof turn.skill === "string" && typeof turn.title === "string";
    case "phone":
      return isPhoneRun(turn.run);
    default:
      return false;
  }
}
