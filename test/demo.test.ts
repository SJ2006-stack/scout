import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eventSignature } from "../src/shared/events.ts";
import { DEMO_AREA_LABEL, DEMO_REQUEST } from "../src/shared/demoRequest.ts";
import { isSafeProductUrl } from "../src/shared/offer.ts";
import { buildDemoEvents, streamDemo } from "../src/server/demo/script.ts";

describe("demo script", () => {
  it("replays the same labelled sequence twice", async () => {
    const first = buildDemoEvents();
    const second = buildDemoEvents();
    assert.deepEqual(first.map(eventSignature), second.map(eventSignature));
    assert.equal(first[0]?.type === "status" && first[0].message.includes(DEMO_REQUEST), true);
    assert.equal(first.some((event) => event.type === "status" && event.message === DEMO_AREA_LABEL), true);

    const streamed: string[] = [];
    await streamDemo((event) => streamed.push(eventSignature(event)), 0, new AbortController().signal);
    assert.deepEqual(streamed, first.map(eventSignature));
    const again: string[] = [];
    await streamDemo((event) => again.push(eventSignature(event)), 0, new AbortController().signal);
    assert.deepEqual(again, streamed);
  });

  it("labels every demo offer as demo and uses https example links", () => {
    const offers = buildDemoEvents().flatMap((event) => (event.type === "offer" ? [event.offer] : []));
    assert.ok(offers.length >= 2);
    for (const offer of offers) {
      assert.equal(offer.provenance, "demo");
      assert.equal(isSafeProductUrl(offer.productUrl), true);
      assert.equal(new URL(offer.productUrl).hostname, "example.com");
    }
    assert.equal(
      buildDemoEvents().some((event) => event.type === "offer" && event.offer.provenance !== "demo"),
      false,
    );
  });

  it("stops emitting after the replay is aborted", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    await streamDemo(
      (event) => {
        events.push(eventSignature(event));
        controller.abort();
      },
      0,
      controller.signal,
    );
    assert.equal(events.length, 1);
    assert.ok(events.length < buildDemoEvents().length);
  });
});
