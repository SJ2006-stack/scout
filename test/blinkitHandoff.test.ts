import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blinkitHandoff } from "../src/shared/blinkitHandoff.ts";
import type { SearchEvent } from "../src/shared/events.ts";
import { LIVE_SOURCE_UNAVAILABLE } from "../src/shared/liveCheck.ts";
import { deliveryAreaForSearch } from "../src/shared/searchArea.ts";
import { PriceCache } from "../src/server/cache.ts";
import { runSearch } from "../src/server/search.ts";
import { confirmedArea, parseSse, withApi } from "./helpers.ts";

describe("Blinkit search handoff", () => {
  it("builds a public search link and does not attach a price", () => {
    const handoff = blinkitHandoff("  Amul   Taaza milk ");
    assert.ok(handoff);
    const url = new URL(handoff.url);
    assert.equal(url.origin, "https://blinkit.com");
    assert.equal(url.pathname, "/s/");
    assert.equal(url.searchParams.get("q"), "Amul Taaza milk");
    assert.equal([...url.searchParams.keys()].join(","), "q");
    assert.equal("price" in handoff, false);
  });

  it("rejects an empty query", () => {
    assert.equal(blinkitHandoff("   "), null);
  });

  it("streams the link with zero offers when no price connector is connected", async () => {
    const events: SearchEvent[] = [];
    await runSearch(
      {
        text: "milk 1 litre",
        area: confirmedArea(),
        connectors: [],
        cache: new PriceCache(60_000, () => 0),
        timeoutMs: 50,
        signal: new AbortController().signal,
        now: () => 0,
      },
      (event) => events.push(event),
    );
    assert.equal(events.some((event) => event.type === "offer"), false);
    const handoff = events.find((event) => event.type === "handoff");
    assert.equal(handoff?.type === "handoff" && new URL(handoff.handoff.url).searchParams.get("q"), "milk 1 litre");
    const failure = events.find((event) => event.type === "connector");
    assert.equal(failure?.type === "connector" && failure.failure?.message, LIVE_SOURCE_UNAVAILABLE);
    const done = events.at(-1);
    assert.equal(done?.type, "done");
    assert.equal(done?.type === "done" && done.offerCount, 0);
  });

  it("returns the same link from the search route", async () => {
    await withApi({}, async (base) => {
      const response = await fetch(`${base}/api/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "bread", area: confirmedArea() }),
      });
      const events = parseSse(await response.text());
      const handoff = events.find((event) => event.type === "handoff");
      assert.equal(handoff?.type === "handoff" && handoff.handoff.url, "https://blinkit.com/s/?q=bread");
      assert.equal(events.some((event) => event.type === "offer"), false);
    });
  });

  it("accepts a typed pincode without coordinates", () => {
    const area = deliveryAreaForSearch({ pincode: "560001", lat: null, lon: null });
    assert.equal(area?.label, "Searching near pincode 560001");
    assert.equal(area?.confirmed, true);
    assert.equal(area?.approximate, true);
    assert.equal(deliveryAreaForSearch({ pincode: "12", lat: null, lon: null }), null);
  });
});
