import type { ConnectorFailure, DeliveryArea, ProductOffer } from "../../shared/offer.ts";
import type { ParsedQuery } from "../../shared/parseQuery.ts";

export type ConnectorResult =
  | { ok: true; offers: ProductOffer[] }
  | { ok: false; failure: ConnectorFailure };

export type SearchRequest = ParsedQuery & {
  area: DeliveryArea;
};

export type Connector = {
  id: string;
  search: (request: SearchRequest, signal: AbortSignal) => Promise<ConnectorResult>;
};
