import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { postSarvam, SARVAM_CHAT_MODEL, SARVAM_CHAT_URL, wholeSentences } from "../src/server/sarvamChat.ts";
import { listingCacheTtlMs, ListingCache } from "../src/server/listingCache.ts";
import { runChat } from "../src/server/chatRun.ts";
import { ChatMemoryStore } from "../src/server/chatMemory.ts";
import { bookMyShowTool } from "../src/server/tools/bookmyshow.ts";
import { cityById } from "../src/shared/cities.ts";
import type { ChatEvent } from "../src/shared/chatEvents.ts";
import { speechCue } from "../src/shared/speech.ts";
import { dateRange } from "../src/shared/when.ts";

const now = Date.parse("2026-10-25T00:00:00.000Z");

describe("replies cut by the token limit", () => {
  it("drops the unfinished last sentence", () => {
    assert.equal(wholeSentences("BookMyShow has 3 movies. I can't see those titles. Luma has"), "BookMyShow has 3 movies. I can't see those titles.");
    assert.equal(wholeSentences("All done."), "All done.");
    assert.equal(wholeSentences("no stop at all"), "no stop at all");
  });

  it("trims a streamed reply that ends on length", async () => {
    const stream = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Ramayana is on. Luma has" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}`,
      "data: [DONE]",
      "",
    ].join("\n");
    const fetchImpl = (async () => new Response(stream, { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const body = await postSarvam({ apiKey: "k", fetchImpl, signal: new AbortController().signal, system: "", tools: [], messages: [{ role: "user", content: "hi" }], onText: () => {} });
    assert.deepEqual(body?.content, [{ type: "text", text: "Ramayana is on." }]);
  });
});

describe("shorter waits", () => {
  it("reads BookMyShow once per city and kind and serves the cache after", async () => {
    const city = cityById("hyderabad");
    assert.ok(city);
    const range = dateRange("today", now, "Asia/Kolkata");
    const cache = new ListingCache(600_000, () => now);
    const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "ItemList", itemListElement: [{ "@type": "ListItem", name: "Late Film", url: "https://in.bookmyshow.com/hyderabad/movies/late-film/ET00000001" }] })}</script>`;
    let reads = 0;
    const load = (readPage: (url: string) => Promise<{ ok: true; html: string } | { ok: false; message: string }>) => bookMyShowTool.load({
      city,
      range,
      kind: "movie",
      timezone: "Asia/Kolkata",
      retrievedAt: "2026-10-25T00:00:00.000Z",
      timeoutMs: 40,
      signal: new AbortController().signal,
      cache,
      fetchImpl: fetch,
      readPage,
    });
    const blocked = await load(async () => ({ ok: true, html: "<title>Attention Required! | Cloudflare</title>" }));
    assert.equal(blocked.ok, false);
    assert.match(blocked.message, /blocked/);
    const first = await load(async (url) => {
      reads += 1;
      assert.equal(url, "https://in.bookmyshow.com/explore/movies-hyderabad");
      return { ok: true, html };
    });
    assert.equal(first.listings[0]?.title, "Late Film");
    assert.equal(first.listings[0]?.kind, "movie");
    const again = await load(async () => {
      reads += 1;
      return { ok: false, message: "should not read" };
    });
    assert.equal(again.listings[0]?.title, "Late Film");
    assert.equal(reads, 1);
  });

  it("emits answer text as Sarvam chunks arrive and drops a tool-round draft", async () => {
    const seen: string[] = [];
    const answer = await postSarvam({
      apiKey: "test-key",
      signal: new AbortController().signal,
      system: "test",
      tools: [],
      messages: [{ role: "user", content: "hi" }],
      onText: (text) => seen.push(text),
      fetchImpl: sarvamStream([
        sarvamChunk({ content: "Hello" }),
        sarvamChunk({ content: " there." }),
        sarvamChunk({}, "stop"),
      ]),
    });
    assert.deepEqual(seen, ["Hello", "Hello there."]);
    assert.equal(answer?.stop_reason, "end_turn");

    const retracted: string[] = [];
    await postSarvam({
      apiKey: "test-key",
      signal: new AbortController().signal,
      system: "test",
      tools: [],
      messages: [{ role: "user", content: "hi" }],
      onText: (text) => retracted.push(text),
      fetchImpl: sarvamStream([
        sarvamChunk({ content: "I'll check." }),
        sarvamChunk({
          tool_calls: [{ index: 0, id: "toolu_1", function: { name: "search_luma", arguments: "{}" } }],
        }),
      ]),
    });
    assert.deepEqual(retracted, ["I'll check.", ""]);
  });

  it("speaks the first finished sentence and does not restart for a later chunk", () => {
    assert.equal(speechCue(false, "Still talking"), null);
    assert.equal(speechCue(false, "Hello there. More is coming"), "Hello there.");
    assert.equal(speechCue(true, "Hello there. More is coming now."), null);
  });

  it("shows event cards before drive minutes are fetched", async () => {
    const events: ChatEvent[] = [];
    await runChat(
      {
        sessionId: "session",
        text: "what's happening in Bengaluru this week",
        timezone: "Asia/Kolkata",
        pincode: "",
        lat: 12.97,
        lon: 77.59,
        timeoutMs: 1000,
        signal: new AbortController().signal,
        now: () => now,
        memory: new ChatMemoryStore(),
        cache: new ListingCache(60_000, () => now),
        mapsApiKey: "maps-key",
        sarvamApiKey: "",
        fetchImpl: (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("api.luma.com")) {
            return new Response(JSON.stringify({
              entries: [{
                ticket_info: { price: null, is_free: true, max_price: null },
                event: {
                  api_id: "evt-1",
                  name: "Roast Tank",
                  url: "roast-tank",
                  start_at: "2026-10-25T05:30:00.000Z",
                  timezone: "Asia/Kolkata",
                  geo_address_info: { city: "Bengaluru", address: "Indiranagar" },
                  coordinate: { latitude: 12.97, longitude: 77.64 },
                },
              }],
            }), { status: 200 });
          }
          if (url.includes("distancematrix")) {
            assert.equal(events.some((event) => event.type === "card"), true);
            assert.equal(events.some((event) => event.type === "drive"), false);
            return new Response(JSON.stringify({ rows: [{ elements: [{ status: "OK", duration: { value: 2100 } }] }] }), { status: 200 });
          }
          return new Response("missing", { status: 404 });
        }) as typeof fetch,
      },
      (event) => events.push(event),
    );
    const card = events.find((event) => event.type === "card");
    const drive = events.find((event) => event.type === "drive");
    assert.equal(card?.type === "card" && card.listing.driveMinutes, null);
    assert.equal(drive?.type === "drive" && drive.minutes, 35);
    assert.ok(events.findIndex((event) => event.type === "card") < events.findIndex((event) => event.type === "drive"));
  });

  it("keeps successful listings for 10 minutes by default", () => {
    assert.equal(listingCacheTtlMs(undefined), 600_000);
    assert.equal(listingCacheTtlMs("60000"), 60_000);
  });

});

function sarvamChunk(delta: Record<string, unknown>, finish?: string): unknown {
  return { choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] };
}

function sarvamStream(events: unknown[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), SARVAM_CHAT_URL);
    const body = JSON.parse(String(init?.body)) as { model?: string };
    assert.equal(body.model, SARVAM_CHAT_MODEL);
    return new Response(streamBody(events), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

function streamBody(events: unknown[]): ReadableStream<Uint8Array> {
  const encoded = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(encoded));
      controller.close();
    },
  });
}
