import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO_REQUEST } from "../src/shared/demoRequest.ts";
import { isSafeProductUrl } from "../src/shared/offer.ts";
import { PriceCache } from "../src/server/cache.ts";
import { readOfferPayload } from "../src/server/connectors/normalize.ts";
import type { Connector } from "../src/server/connectors/types.ts";
import { buildDemoEvents } from "../src/server/demo/script.ts";
import { confirmedArea, parseSse, sampleOffer, withApi } from "./helpers.ts";

describe("launch readiness", () => {
  it("streams the prepared demo and only https links", async () => {
    await withApi({ demoStepMs: 0 }, async (base) => {
      const response = await fetch(`${base}/api/demo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
      const events = parseSse(await response.text());
      const offers = events.flatMap((event) => (event.type === "offer" ? [event.offer] : []));
      assert.equal(offers.length, 2);
      for (const offer of offers) {
        assert.equal(offer.provenance, "demo");
        assert.equal(isSafeProductUrl(offer.productUrl), true);
      }
      assert.equal(events.some((event) => event.type === "connector" && event.ok === false), true);
      assert.equal(events.at(-1)?.type, "done");
      assert.equal(events.some((event) => event.type === "offer" && event.offer.provenance !== "demo"), false);
    });
  });

  it("still delivers offers when one connector times out", async () => {
    const connectors: Connector[] = [
      { id: "open", search: async () => ({ ok: true, offers: [sampleOffer()] }) },
      {
        id: "slow",
        search: (_request, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      },
    ];
    await withApi({ liveConnectors: connectors, timeoutMs: 40 }, async (base) => {
      const response = await postSearch(base, confirmedArea());
      assert.equal(response.status, 200);
      const events = parseSse(await response.text());
      const offers = events.flatMap((event) => (event.type === "offer" ? [event.offer] : []));
      assert.equal(offers.length, 1);
      assert.equal(offers[0]?.provenance, "live");
      assert.equal(offers[0]?.productUrl.startsWith("https://"), true);
      const slow = events.find((event) => event.type === "connector" && event.connectorId === "slow");
      assert.equal(slow?.type === "connector" && slow.timedOut, true);
      assert.equal(events.some((event) => event.type === "offer" && event.offer.provenance === "demo"), false);
    });
  });

  it("stops a demo stream when the request is aborted", async () => {
    await withApi({ demoStepMs: 300 }, async (base) => {
      const controller = new AbortController();
      const response = await fetch(`${base}/api/demo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      assert.ok(reader);
      const first = await reader.read();
      assert.equal(first.done, false);
      const text = new TextDecoder().decode(first.value);
      assert.match(text, /event: status/);
      assert.ok(parseSse(text).length < buildDemoEvents().length);
      controller.abort();
      await assert.rejects(() => reader.read());
    });
  });

  it("turns malformed JSON into a typed failure and does not cache it", async () => {
    let calls = 0;
    const connectors: Connector[] = [
      {
        id: "broken",
        search: async () => {
          calls += 1;
          return readOfferPayload("{\"data\":", "broken", "2026-01-01T00:00:00.000Z");
        },
      },
    ];
    const cache = new PriceCache(60_000, () => 0);
    await withApi({ liveConnectors: connectors, cache, now: () => 0 }, async (base) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await postSearch(base, confirmedArea());
        const events = parseSse(await response.text());
        assert.equal(events.some((event) => event.type === "offer"), false);
        const failure = events.find((event) => event.type === "connector");
        assert.equal(failure?.type === "connector" && failure.failure?.code, "malformed");
        assert.equal(failure?.type === "connector" && failure.cacheHit, false);
      }
      assert.equal(calls, 2);
    });
  });

  it("accepts a confirmed browser point without a pincode", async () => {
    await withApi({}, async (base) => {
      const response = await postSearch(base, {
        pincode: "",
        lat: 28.666,
        lon: 77.216,
        label: "Searching around 28.67, 77.22",
        confirmed: true,
        approximate: true,
      });
      assert.equal(response.status, 200);
      const events = parseSse(await response.text());
      assert.match(JSON.stringify(events), /around 28\.67, 77\.22/);
      assert.match(JSON.stringify(events), /not a street address/);
      assert.equal(events.some((event) => event.type === "offer"), false);
    });
  });

  it("rejects an unconfirmed area and a non-json body", async () => {
    await withApi({}, async (base) => {
      const unconfirmed = await postSearch(base, { ...confirmedArea(), confirmed: false, approximate: false });
      assert.equal(unconfirmed.status, 400);
      const malformed = await fetch(`${base}/api/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      assert.equal(malformed.status, 400);
      const live = await postSearch(base, confirmedArea());
      const events = parseSse(await live.text());
      assert.equal(events.some((event) => event.type === "offer" && event.offer.provenance === "demo"), false);
      assert.match(JSON.stringify(events), /did not invent prices/);
    });
  });
});

function postSearch(base: string, area: ReturnType<typeof confirmedArea>): Promise<Response> {
  return fetch(`${base}/api/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: DEMO_REQUEST, area }),
  });
}
