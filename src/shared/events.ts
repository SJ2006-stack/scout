import type { BlinkitHandoff } from "./blinkitHandoff.ts";
import type { ConnectorFailure, ProductOffer } from "./offer.ts";

export type StatusEvent = {
  type: "status";
  message: string;
};

export type OfferEvent = {
  type: "offer";
  offer: ProductOffer;
};

export type ConnectorEvent = {
  type: "connector";
  connectorId: string;
  startedAt: string;
  firstOfferAt: string | null;
  completedAt: string;
  timedOut: boolean;
  cacheHit: boolean;
  ok: boolean;
  failure: ConnectorFailure | null;
};

export type HandoffEvent = {
  type: "handoff";
  handoff: BlinkitHandoff;
};

export type DoneEvent = {
  type: "done";
  firstUsefulOfferMs: number | null;
  totalMs: number;
  offerCount: number;
};

export type SearchEvent = StatusEvent | OfferEvent | ConnectorEvent | HandoffEvent | DoneEvent;

export function eventSignature(event: SearchEvent): string {
  switch (event.type) {
    case "status":
      return `status:${event.message}`;
    case "offer":
      return `offer:${event.offer.id}:${event.offer.provenance}:${event.offer.price}`;
    case "connector":
      return `connector:${event.connectorId}:${event.ok}:${event.failure?.code ?? ""}:${event.cacheHit}:${event.timedOut}`;
    case "handoff":
      return `handoff:${event.handoff.platform}:${event.handoff.url}`;
    case "done":
      return `done:${event.offerCount}`;
    default: {
      const neverEvent: never = event;
      return neverEvent;
    }
  }
}
