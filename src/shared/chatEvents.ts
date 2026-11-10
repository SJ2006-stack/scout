import type { CartEstimate } from "./cartQuote.ts";
import type { CartSnapshot, QuoteSnapshot, ReceiptSnapshot } from "./commerce.ts";
import type { DeviceAction } from "./deviceActions.ts";
import type { ErrandQueue } from "./errandQueue.ts";
import type { BusResult, ErrandForm, FlightResult } from "./errands.ts";
import type { EventKind, Listing } from "./event.ts";
import type { PayLink } from "./payLink.ts";
import type { SavedPlace } from "./places.ts";

export type ChatStatusEvent = {
  type: "status";
  message: string;
};

/** The prompt and tools a scout is working with. `fed` is false when the sites were read directly and the model was not called. */
export type ChatBriefEvent = {
  type: "brief";
  scout: string;
  fed: boolean;
  prompt: string;
  tools: { name: string; description: string }[];
};

export type ChatQuestionEvent = {
  type: "question";
  message: string;
};

export type ChatCardEvent = {
  type: "card";
  listing: Listing;
};

/** Listings that matched but did not get a card. The page shows them behind a "Show more" button. */
export type ChatMoreEvent = {
  type: "more";
  listings: Listing[];
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

/** Estimated cart totals per store right after the shelf compare, before any cart is filled. */
export type ChatEstimateEvent = {
  type: "estimate";
  estimate: CartEstimate;
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

/** Main Scout's questions for every errand in one message, answered together before anything runs. */
export type ChatFormEvent = {
  type: "form";
  form: ErrandForm;
};

export type ChatBusesEvent = {
  type: "buses";
  buses: BusResult;
};

export type ChatFlightsEvent = {
  type: "flights";
  flights: FlightResult;
};

/** App pages a task opened, kept so they can be opened again. */
export type ChatPlacesEvent = {
  type: "places";
  places: SavedPlace[];
};

/** The task list for one message. Later events replace the same card as each task starts and finishes. */
export type ChatQueueEvent = {
  type: "queue";
  queue: ErrandQueue;
};

export type ChatEvent =
  | ChatBriefEvent
  | ChatFormEvent
  | ChatBusesEvent
  | ChatFlightsEvent
  | ChatPlacesEvent
  | ChatQueueEvent
  | ChatDeviceEvent
  | ChatWatchEvent
  | ChatStatusEvent
  | ChatQuestionEvent
  | ChatCardEvent
  | ChatMoreEvent
  | ChatSourceEvent
  | ChatDriveEvent
  | ChatDoneEvent
  | ChatNoteEvent
  | ChatCartEvent
  | ChatQuoteEvent
  | ChatEstimateEvent
  | ChatReceiptEvent
  | ChatPayEvent
  | ChatTaskEvent;
