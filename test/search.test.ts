import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO_REQUEST } from "../src/shared/demoRequest.ts";
import type { SearchEvent } from "../src/shared/events.ts";
import { LIVE_SOURCE_UNAVAILABLE } from "../src/shared/liveCheck.ts";
import { PriceCache } from "../src/server/cache.ts";
import { readOfferPayload } from "../src/server/connectors/normalize.ts";
import type { Connector } from "../src/server/connectors/types.ts";
import { runSearch, type SearchRun } from "../src/server/search.ts";
import { confirmedArea, sampleOffer } from "./helpers.ts";

async function collect(run: SearchRun): Promise<SearchEvent[]> {
  const events: SearchEvent[] = [];
  await runSearch(run, (event) => events.push(event));
  return events;
}

function baseRun(overrides: Partial<SearchRun> = {}): SearchRun {
  return {
    text: DEMO_REQUEST,
    area: confirmedArea(),
    connectors: [],
    cache: new PriceCache(60_000, () => 0),
    timeoutMs: 50,
    signal: new AbortController().signal,
    now: () => 0,
    ...overrides,
  };
}

describe("runSearch", () => {
  it("reports the live source unavailable instead of inventing prices", async () => {
    const events = await collect(baseRun());
    assert.equal(events.some((event) => event.type === "offer"), false);
    const failure = events.find((event) => event.type === "connector");
    assert.equal(failure?.type === "connector" && failure.failure?.message, LIVE_SOURCE_UNAVAILABLE);
    const done = events.find((event) => event.type === "done");
    assert.equal(done?.type === "done" && done.offerCount, 0);
    assert.equal(done?.type === "done" && done.firstUsefulOfferMs, null);
  });

  it("keeps offers when another connector times out", async () => {
    const events = await collect(
      baseRun({
        connectors: [
          {
            id: "open",
            search: async () => ({ ok: true, offers: [sampleOffer()] }),
          },
          {
            id: "slow",
            search: (_request, signal) =>
              new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
          },
        ],
      }),
    );
    const offers = events.flatMap((event) => (event.type === "offer" ? [event.offer] : []));
    assert.equal(offers.length, 1);
    assert.equal(offers[0]?.provenance, "live");
    assert.equal(offers[0]?.source, "open");
    assert.equal(offers[0]?.discountAmount, 33);
    assert.equal(offers[0]?.productUrl.startsWith("https://"), true);
    const slow = events.find((event) => event.type === "connector" && event.connectorId === "slow");
    assert.equal(slow?.type === "connector" && slow.timedOut, true);
    assert.equal(slow?.type === "connector" && slow.failure?.code, "timeout");
    const done = events.find((event) => event.type === "done");
    assert.equal(done?.type === "done" && done.offerCount, 1);
    assert.equal(typeof (done?.type === "done" ? done.firstUsefulOfferMs : null), "number");
  });

  it("stops before emitting offers when the search is aborted", async () => {
    const controller = new AbortController();
    const events = await collect(
      baseRun({
        signal: controller.signal,
        connectors: [
          {
            id: "slow",
            search: () =>
              new Promise((resolve) => {
                setTimeout(() => {
                  controller.abort();
                  resolve({ ok: true, offers: [sampleOffer()] });
                }, 20);
              }),
          },
        ],
      }),
    );
    assert.equal(events.some((event) => event.type === "offer"), false);
    const connector = events.find((event) => event.type === "connector");
    assert.equal(connector?.type === "connector" && connector.failure?.code, "cancelled");
  });

  it("does not cache malformed JSON or an unsafe product link", async () => {
    let malformedCalls = 0;
    let unsafeCalls = 0;
    const malformed: Connector = {
      id: "broken",
      search: async () => {
        malformedCalls += 1;
        return readOfferPayload("{", "broken", "2026-01-01T00:00:00.000Z");
      },
    };
    const unsafe: Connector = {
      id: "unsafe",
      search: async () => {
        unsafeCalls += 1;
        return { ok: true, offers: [sampleOffer({ productUrl: "http://example.com/milk", source: "unsafe" })] };
      },
    };
    const cache = new PriceCache(60_000, () => 0);
    await collect(baseRun({ cache, connectors: [malformed, unsafe] }));
    await collect(baseRun({ cache, connectors: [malformed, unsafe], signal: new AbortController().signal }));
    assert.equal(malformedCalls, 2);
    assert.equal(unsafeCalls, 2);
  });

  it("serves a fresh price as live and a repeated price as cached", async () => {
    let now = 0;
    let calls = 0;
    const cache = new PriceCache(60_000, () => now);
    const connectors: Connector[] = [
      {
        id: "store",
        search: async () => {
          calls += 1;
          return { ok: true, offers: [sampleOffer({ provenance: "demo", source: "fixture" })] };
        },
      },
    ];
    const first = await collect(baseRun({ cache, connectors, now: () => now }));
    now = 1_000;
    const second = await collect(baseRun({ cache, connectors, now: () => now, signal: new AbortController().signal }));
    now = 61_000;
    const third = await collect(baseRun({ cache, connectors, now: () => now, signal: new AbortController().signal }));
    const provenance = (events: SearchEvent[]) =>
      events.flatMap((event) => (event.type === "offer" ? [event.offer.provenance] : []));
    assert.deepEqual(provenance(first), ["live"]);
    assert.equal(first.some((event) => event.type === "offer" && event.offer.source === "store"), true);
    assert.deepEqual(provenance(second), ["cached"]);
    assert.equal(
      second.some((event) => event.type === "connector" && event.cacheHit && event.connectorId === "store"),
      true,
    );
    assert.deepEqual(provenance(third), ["live"]);
    assert.equal(calls, 2);
  });
});
