import { blinkitHandoff } from "../shared/blinkitHandoff.ts";
import type { SearchEvent } from "../shared/events.ts";
import { LIVE_SOURCE_UNAVAILABLE } from "../shared/liveCheck.ts";
import type { DeliveryArea, FailureCode, ProductOffer } from "../shared/offer.ts";
import { isUsefulOffer } from "../shared/offer.ts";
import { parseQuery } from "../shared/parseQuery.ts";
import { cacheKey, type PriceCache } from "./cache.ts";
import type { Connector } from "./connectors/types.ts";
import { prepareOffers } from "./match.ts";

const CONCURRENCY = 4;

export type SearchRun = {
  text: string;
  area: DeliveryArea;
  connectors: Connector[];
  cache: PriceCache;
  timeoutMs: number;
  signal: AbortSignal;
  now: () => number;
};

export async function runSearch(run: SearchRun, emit: (event: SearchEvent) => void): Promise<void> {
  const started = run.now();
  let firstUseful: number | null = null;
  let offerCount = 0;
  const noteOffer = (offer: ProductOffer): void => {
    if (!isUsefulOffer(offer)) return;
    if (firstUseful == null) firstUseful = run.now() - started;
    offerCount += 1;
    emit({ type: "offer", offer });
  };

  const place = /^\d{6}$/.test(run.area.pincode)
    ? `Searching near pincode ${run.area.pincode}`
    : run.area.label;
  emit({
    type: "status",
    message: `${place}. This is an approximate area, not a street address.`,
  });

  if (run.connectors.length === 0) {
    const stamp = new Date(run.now()).toISOString();
    emit({
      type: "connector",
      connectorId: "live",
      startedAt: stamp,
      firstOfferAt: null,
      completedAt: stamp,
      timedOut: false,
      cacheHit: false,
      ok: false,
      failure: { code: "unavailable", message: LIVE_SOURCE_UNAVAILABLE },
    });
    emitHandoff(run.text, emit);
    emit({ type: "done", firstUsefulOfferMs: null, totalMs: run.now() - started, offerCount: 0 });
    return;
  }

  const parsed = parseQuery(run.text);
  await runPool(run.connectors, CONCURRENCY, async (connector) => {
    const connectorStarted = run.now();
    const startedAt = new Date(connectorStarted).toISOString();
    if (run.signal.aborted) {
      emit(connectorEvent(connector.id, startedAt, null, run.now(), false, false, "cancelled", "Search stopped."));
      return;
    }
    const key = cacheKey({
      source: connector.id,
      keywords: parsed.keywords,
      quantity: parsed.quantity,
      pincode: run.area.pincode,
      lat: run.area.lat,
      lon: run.area.lon,
    });
    const cached = run.cache.get(key);
    if (cached) {
      let firstOfferAt: string | null = null;
      for (const offer of cached) {
        if (run.signal.aborted) {
          emit(connectorEvent(connector.id, startedAt, firstOfferAt, run.now(), false, true, "cancelled", "Search stopped."));
          return;
        }
        if (firstOfferAt == null) firstOfferAt = new Date(run.now()).toISOString();
        noteOffer(offer);
      }
      emit(connectorEvent(connector.id, startedAt, firstOfferAt, run.now(), false, true, null, null));
      return;
    }

    const outcome = await runConnector(connector, { ...parsed, area: run.area }, run.timeoutMs, run.signal);
    if (run.signal.aborted || outcome.kind === "cancelled") {
      emit(connectorEvent(connector.id, startedAt, null, run.now(), false, false, "cancelled", "Search stopped."));
      return;
    }
    if (outcome.kind === "timeout") {
      emit(connectorEvent(connector.id, startedAt, null, run.now(), true, false, "timeout", `${connector.id} timed out.`));
      return;
    }
    if (!outcome.result.ok) {
      emit(
        connectorEvent(
          connector.id,
          startedAt,
          null,
          run.now(),
          false,
          false,
          outcome.result.failure.code,
          outcome.result.failure.message,
        ),
      );
      return;
    }
    const offers = prepareOffers(outcome.result.offers).filter(isUsefulOffer).map((offer) => ({
      ...offer,
      provenance: "live" as const,
      source: connector.id,
    }));
    if (offers.length === 0) {
      emit(
        connectorEvent(
          connector.id,
          startedAt,
          null,
          run.now(),
          false,
          false,
          "malformed",
          `${connector.id} returned no usable offers.`,
        ),
      );
      return;
    }
    run.cache.set(key, offers);
    let firstOfferAt: string | null = null;
    for (const offer of offers) {
      if (run.signal.aborted) {
        emit(connectorEvent(connector.id, startedAt, firstOfferAt, run.now(), false, false, "cancelled", "Search stopped."));
        return;
      }
      if (firstOfferAt == null) firstOfferAt = new Date(run.now()).toISOString();
      noteOffer(offer);
    }
    emit(connectorEvent(connector.id, startedAt, firstOfferAt, run.now(), false, false, null, null));
  });

  if (!run.signal.aborted) emitHandoff(run.text, emit);
  emit({
    type: "done",
    firstUsefulOfferMs: firstUseful,
    totalMs: run.now() - started,
    offerCount,
  });
}

function emitHandoff(query: string, emit: (event: SearchEvent) => void): void {
  const handoff = blinkitHandoff(query);
  if (!handoff) return;
  emit({ type: "handoff", handoff });
}

function connectorEvent(
  connectorId: string,
  startedAt: string,
  firstOfferAt: string | null,
  completedMs: number,
  timedOut: boolean,
  cacheHit: boolean,
  code: FailureCode | null,
  message: string | null,
): SearchEvent {
  const ok = code == null;
  return {
    type: "connector",
    connectorId,
    startedAt,
    firstOfferAt,
    completedAt: new Date(completedMs).toISOString(),
    timedOut,
    cacheHit,
    ok,
    failure: code == null || message == null ? null : { code, message },
  };
}

async function runConnector(
  connector: Connector,
  request: Parameters<Connector["search"]>[0],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<
  | { kind: "ok"; result: Awaited<ReturnType<Connector["search"]>> }
  | { kind: "timeout" }
  | { kind: "cancelled" }
> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const linked = AbortSignal.any([signal, timeout.signal]);
  try {
    const result = await connector.search(request, linked);
    if (signal.aborted) return { kind: "cancelled" };
    return { kind: "ok", result };
  } catch (error) {
    if (signal.aborted) return { kind: "cancelled" };
    if (timeout.signal.aborted) return { kind: "timeout" };
    const message = error instanceof Error ? error.message : "Connector failed.";
    return { kind: "ok", result: { ok: false, failure: { code: "unavailable", message } } };
  } finally {
    clearTimeout(timer);
  }
}

async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Math.min(Math.max(limit, 1), items.length);
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const current = next;
        next += 1;
        const item = items[current];
        if (!item) return;
        await worker(item);
      }
    }),
  );
}
