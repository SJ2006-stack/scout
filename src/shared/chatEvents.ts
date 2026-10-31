import type { CartSnapshot, QuoteSnapshot, ReceiptSnapshot } from "./commerce.ts";
import type { DeviceAction } from "./deviceActions.ts";
import type { EventKind, Listing } from "./event.ts";
import type { PayLink } from "./payLink.ts";

export type ChatStatusEvent = {
  type: "status";
  message: string;
};

export type ChatQuestionEvent = {
  type: "question";
  message: string;
};

export type ChatCardEvent = {
  type: "card";
  listing: Listing;
};

export type ChatSourceEvent = {
  type: "source";
  source: string;
  ok: boolean;
  message: string;
};

export type ChatDoneEvent = {
  type: "done";
  count: number;
};

export type ChatDriveEvent = {
  type: "drive";
  url: string;
  minutes: number;
};

export type ChatNoteEvent = {
  type: "note";
  message: string;
};

export type ChatCartEvent = {
  type: "cart";
  cart: CartSnapshot;
};

export type ChatQuoteEvent = {
  type: "quote";
  quote: QuoteSnapshot;
};

export type ChatReceiptEvent = {
  type: "receipt";
  receipt: ReceiptSnapshot;
};

export type ChatPayEvent = {
  type: "pay";
  pay: PayLink;
};

/** A live website task. The client polls the task for its state. */
export type ChatTaskEvent = {
  type: "task";
  taskId: string;
  skill: string;
  title: string;
};

export type ChatDeviceEvent = {
  type: "device";
  action: DeviceAction;
};

export type WatchCard = {
  id: string;
  cityId: string;
  kind: EventKind | null;
  when: string;
  budget: number | null;
  intervalMinutes: number;
};

export type ChatWatchEvent = {
  type: "watch";
  watch: WatchCard;
};

export type ChatEvent =
  | ChatDeviceEvent
  | ChatWatchEvent
  | ChatStatusEvent
  | ChatQuestionEvent
  | ChatCardEvent
  | ChatSourceEvent
  | ChatDriveEvent
  | ChatDoneEvent
  | ChatNoteEvent
  | ChatCartEvent
  | ChatQuoteEvent
  | ChatReceiptEvent
  | ChatPayEvent
  | ChatTaskEvent;
