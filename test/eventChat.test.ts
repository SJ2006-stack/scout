import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dateRange } from "../src/shared/when.ts";
import { districtEvents, districtMovies } from "../src/server/events/district.ts";
import { lumaEvents } from "../src/server/events/luma.ts";
import { ChatMemoryStore } from "../src/server/chatMemory.ts";
import { runChat } from "../src/server/chatRun.ts";
import { HAIKU_MODEL } from "../src/server/haikuChat.ts";
import { ListingCache } from "../src/server/listingCache.ts";
import { driveMinutes } from "../src/server/travel.ts";
import { cityById, type City } from "../src/shared/cities.ts";
import type { ChatEvent } from "../src/shared/chatEvents.ts";
import { parseSse, withApi } from "./helpers.ts";

const city: City = {
  id: "bengaluru",
  name: "Bengaluru",
  lumaSlug: "bengaluru",
  bookMyShowCity: "Bengaluru",
  aliases: ["bengaluru", "bangalore"],
  pincodePrefix: "560",
};

const eventsHtml = `<script type="application/ld+json">${JSON.stringify({
  "@type": "ItemList",
  itemListElement: [
    eventItem("Comedy Expensive", "https://www.district.in/events/comedy-expensive", "800"),
    eventItem("Free Comedy", "https://www.district.in/events/free-comedy", "0"),
    eventItem("Comedy Mystery", "https://www.district.in/events/comedy-mystery", null),
    eventItem("Delhi Only", "https://www.district.in/events/delhi-only", "100", "Delhi"),
    eventItem("Bad Link", "http://www.district.in/events/bad", "100"),
    eventItem("Free Comedy Copy", "https://www.district.in/events/free-comedy", "0"),
  ],
})}</script>`;

const moviesHtml = `<script type="application/ld+json">${JSON.stringify({
  "@type": "ItemList",
  itemListElement: [
    { "@type": "ListItem", name: "Udta Teer", url: "https://www.district.in/movies/udta-teer-movie-tickets-in-gurgaon-MV219550" },
    { "@type": "ListItem", name: "Udta Teer", url: "https://www.district.in/movies/udta-teer-movie-tickets-MV219550" },
    { "@type": "ListItem", name: "No Link" },
  ],
})}</script>`;

const lumaBody = JSON.stringify({
  entries: [
    {
      ticket_info: { price: null, is_free: true, max_price: null },
      event: {
        api_id: "evt-1",
        name: "Roast Tank",
        url: "roast-tank",
        start_at: "2026-10-25T05:30:00.000Z",
        timezone: "Asia/Kolkata",
        cover_url: "https://images.lumacdn.com/roast.jpg",
        geo_address_info: { city: "Bengaluru", address: "Indiranagar" },
        coordinate: { latitude: 12.97, longitude: 77.64 },
      },
    },
    {
      ticket_info: { price: 900, is_free: false },
      event: {
        name: "Paid Comedy",
        url: "https://evil.example/paid",
        start_at: "2026-10-25T08:00:00.000Z",
      },
    },
  ],
});

function eventItem(name: string, url: string, price: string | null, locality = "Bengaluru") {
  return {
    "@type": "ListItem",
    item: {
      "@type": "Event",
      name,
      url,
      startDate: "2026-10-25T14:30:00.000Z",
      offers: price == null ? undefined : { price, priceCurrency: "INR" },
      location: {
        name: "Hall",
        address: { addressLocality: locality },
        geo: { latitude: 12.97, longitude: 77.59 },
      },
    },
  };
}

function eventListing(title: string, url: string, amountMinor: number) {
  return {
    id: title.replaceAll(" ", ""),
    kind: "events",
    title,
    detail_url: url,
    genres: ["comedy"],
    category: "Stand up Comedy",
    advertised_price: { amount_minor: amountMinor, currency: "INR", label: `₹${amountMinor / 100}` },
    venues: [{ name: "Comedy Square: Bengaluru", showtimes: [{ starts_at: "2026-10-25T21:00:00+05:30", prices: [] }] }],
  };
}

function sources(eventsStatus = 200): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.luma.com")) return new Response(lumaBody, { status: 200 });
    if (url.includes("/events/")) return new Response(eventsHtml, { status: eventsStatus });
    if (url.includes("/movies/")) return new Response(moviesHtml, { status: 200 });
    if (url.includes("distancematrix")) {
      return new Response(JSON.stringify({ rows: [{ elements: [{ status: "ZERO_RESULTS" }] }] }), { status: 200 });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
}

async function turn(
  text: string,
  fetchImpl: typeof fetch,
  memory = new ChatMemoryStore(),
  mapsApiKey = "",
  pomeradoApiKey = "",
  anthropicApiKey = "",
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  await runChat(
    {
      sessionId: "session",
      text,
      timezone: "Asia/Kolkata",
      pincode: "",
      lat: 12.97,
      lon: 77.59,
      timeoutMs: 1000,
      signal: new AbortController().signal,
      now: () => Date.parse("2026-10-25T00:00:00.000Z"),
      memory,
      cache: new ListingCache(60_000, () => Date.parse("2026-10-25T00:00:00.000Z")),
      fetchImpl,
      mapsApiKey,
      pomeradoApiKey,
      anthropicApiKey,
    },
    (event) => events.push(event),
  );
  return events;
}

describe("event listings", () => {
  it("uses Luma's public place slug for Delhi", () => {
    assert.equal(cityById("delhi")?.lumaSlug, "new-delhi");
  });

  it("keeps a free event, an unknown price, and drops a priced event over the budget", async () => {
    const events = await turn("comedy in Bengaluru under 500", sources());
    const titles = events.flatMap((event) => (event.type === "card" ? [event.listing.title] : []));
    assert.equal(titles.includes("Comedy Expensive"), false);
    assert.equal(titles.includes("Free Comedy"), true);
    assert.equal(titles.includes("Comedy Mystery"), true);
    assert.equal(titles.includes("Delhi Only"), false);
    assert.equal(titles.includes("Bad Link"), false);
    assert.equal(titles.filter((title) => title === "Free Comedy").length, 1);
    const mystery = events.find((event) => event.type === "card" && event.listing.title === "Comedy Mystery");
    assert.equal(mystery?.type === "card" && mystery.listing.price.provenance, "unknown");
    assert.equal(mystery?.type === "card" && mystery.listing.price.min, null);
    const free = events.find((event) => event.type === "card" && event.listing.title === "Free Comedy");
    assert.equal(free?.type === "card" && free.listing.price.provenance, "free");
    assert.equal(events.some((event) => event.type === "card" && event.listing.driveMinutes != null), false);
  });

  it("asks for a city and emits no cards", async () => {
    const events = await turn("what's happening this week", sources());
    assert.equal(events.some((event) => event.type === "card"), false);
    assert.equal(events.some((event) => event.type === "question"), true);
  });

  it("still returns Luma when District events fail", async () => {
    const events = await turn("what's happening in Bengaluru this week", sources(503));
    const cards = events.flatMap((event) => (event.type === "card" ? [event.listing] : []));
    assert.equal(cards.some((card) => card.platform === "Luma" && card.url === "https://luma.com/roast-tank"), true);
    assert.equal(cards.some((card) => card.url.startsWith("https://www.district.in/events/")), false);
    assert.equal(events.some((event) => event.type === "source" && event.source === "District" && event.ok === false), true);
    assert.equal(cards.some((card) => card.kind === "movie" && card.url.endsWith("MV219550")), true);
  });

  it("calls the BookMyShow tool and keeps a comedy under the budget", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.pomerado.ai")) {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as unknown);
        return new Response(JSON.stringify({
          id: "job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          status: "succeeded",
          result: {
            applied_city: "Bengaluru",
            listings: [
              eventListing("Cheap Standup", "https://in.bookmyshow.com/events/cheap-standup/ET1", 19900),
              eventListing("Pricey Standup", "https://in.bookmyshow.com/events/pricey-standup/ET2", 80000),
              eventListing("Bad Link Comedy", "http://in.bookmyshow.com/events/bad/ET3", 10000),
            ],
          },
        }), { status: 202 });
      }
      return sources()(input, init);
    }) as typeof fetch;
    const events = await turn("comedy in Bengaluru under 500", fetchImpl, new ChatMemoryStore(), "", "test-key");
    const titles = events.flatMap((event) => (event.type === "card" ? [event.listing.title] : []));
    assert.equal(titles.includes("Cheap Standup"), true);
    assert.equal(titles.includes("Pricey Standup"), false);
    assert.equal(titles.includes("Bad Link Comedy"), false);
    assert.equal(titles.filter((title) => title === "Cheap Standup").length, 1);
    const cheap = events.find((event) => event.type === "card" && event.listing.title === "Cheap Standup");
    assert.equal(cheap?.type === "card" && cheap.listing.platform, "BookMyShow");
    assert.equal(cheap?.type === "card" && cheap.listing.price.min, 199);
    assert.equal(bodies.length > 0, true);
    const first = bodies[0] as { tool_id?: string; input?: { city?: string; kind?: string } };
    assert.equal(first.tool_id, "tool_1528e3718e37c1b0489614053d3b4080");
    assert.equal(first.input?.city, "Bengaluru");
    assert.equal(first.input?.kind, "events");
    assert.equal(bodies.some((body) => (body as { input?: { kind?: string } }).input?.kind === "movies"), false);
  });

  it("drops a movie with no url and prefers the url without a city suffix", () => {
    const movies = districtMovies(moviesHtml, "2026-10-25T00:00:00.000Z");
    assert.equal(movies.length, 1);
    assert.equal(movies[0]?.url, "https://www.district.in/movies/udta-teer-movie-tickets-MV219550");
    assert.equal(movies.some((movie) => movie.title === "No Link"), false);
  });

  it("rejects a non-https District url", () => {
    const listings = districtEvents(eventsHtml, city, "2026-10-25T00:00:00.000Z");
    assert.equal(listings.some((listing) => listing.url.startsWith("http://")), false);
  });

  it("filters today in Asia/Kolkata", () => {
    const range = dateRange("today", Date.parse("2026-10-21T06:30:00.000Z"), "Asia/Kolkata");
    assert.equal(new Date(range.startMs).toISOString(), "2026-10-20T18:30:00.000Z");
    assert.equal(new Date(range.endMs).toISOString(), "2026-10-21T18:30:00.000Z");
    const weekend = dateRange("weekend", Date.parse("2026-10-21T06:30:00.000Z"), "Asia/Kolkata");
    assert.equal(new Date(weekend.startMs).toISOString(), "2026-10-23T18:30:00.000Z");
    assert.equal(new Date(weekend.endMs).toISOString(), "2026-10-25T18:30:00.000Z");
  });

  it("remembers the city for a later budget", async () => {
    const memory = new ChatMemoryStore();
    await turn("what's happening in Bengaluru this week", sources(), memory);
    const events = await turn("under 500", sources(), memory);
    assert.equal(events.some((event) => event.type === "question"), false);
    const status = events.find((event) => event.type === "status" && event.message.startsWith("Looking"));
    assert.match(status?.type === "status" ? status.message : "", /Bengaluru/);
  });

  it("uses a drive time only when the route is valid", async () => {
    const missing = await driveMinutes({ lat: 1, lon: 2 }, { lat: 3, lon: 4 }, "", 1000, new AbortController().signal, sources());
    assert.equal(missing, null);
    const none = await driveMinutes(
      { lat: 1, lon: 2 },
      { lat: 3, lon: 4 },
      "key",
      1000,
      new AbortController().signal,
      sources(),
    );
    assert.equal(none, null);
    const found = await driveMinutes(
      { lat: 1, lon: 2 },
      { lat: 3, lon: 4 },
      "key",
      1000,
      new AbortController().signal,
      (async () => new Response(JSON.stringify({ rows: [{ elements: [{ status: "OK", duration: { value: 2100 } }] }] }), { status: 200 })) as typeof fetch,
    );
    assert.equal(found, 35);
    const parsed = lumaEvents(JSON.parse(lumaBody) as unknown, "2026-10-25T00:00:00.000Z");
    assert.equal(parsed.some((listing) => listing.url.includes("evil.example")), false);
  });

  it("lets Haiku talk and call Luma, District, and BookMyShow", async () => {
    const bodies: Array<{ model?: string; temperature?: unknown; thinking?: { type?: string }; tools?: Array<{ name?: string }>; messages?: unknown[] }> = [];
    const headers: Headers[] = [];
    let haikuCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.anthropic.com/v1/messages") {
        haikuCalls += 1;
        const body = JSON.parse(String(init?.body)) as (typeof bodies)[number];
        bodies.push(body);
        headers.push(new Headers(init?.headers));
        if (haikuCalls === 1) {
          return new Response(JSON.stringify({
            stop_reason: "tool_use",
            content: [
              { type: "text", text: "I'll check Bengaluru for tonight." },
              { type: "tool_use", id: "toolu_luma", name: "search_luma", input: { city: "bengaluru", when: "today", kind: "any", budgetRupees: 0 } },
              { type: "tool_use", id: "toolu_district", name: "search_district", input: { city: "bengaluru", when: "today", kind: "any", budgetRupees: 0 } },
              { type: "tool_use", id: "toolu_bms", name: "search_bookmyshow", input: { city: "bengaluru", when: "today", kind: "any", budgetRupees: 0 } },
            ],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Tonight in Bengaluru I found Roast Tank on Luma." }],
        }), { status: 200 });
      }
      return sources()(input, init);
    }) as typeof fetch;
    const events = await turn("films tonight in the garden city", fetchImpl, new ChatMemoryStore(), "", "", "test-anthropic-key");
    const replies = events.flatMap((event) => (event.type === "question" ? [event.message] : []));
    assert.match(replies.join("\n"), /Roast Tank/);
    assert.equal(events.some((event) => event.type === "card" && event.listing.title === "Roast Tank"), true);
    assert.equal(events.some((event) => event.type === "source" && event.source === "BookMyShow"), true);
    const names = bodies[0]?.tools?.map((tool) => tool.name);
    assert.deepEqual(names, ["search_luma", "search_district", "search_bookmyshow"]);
    assert.equal(bodies[0]?.model, HAIKU_MODEL);
    assert.equal(bodies[0]?.temperature, undefined);
    assert.equal(bodies[0]?.thinking?.type, "disabled");
    assert.equal(headers[0]?.get("x-api-key"), "test-anthropic-key");
    const followUp = JSON.stringify(bodies[1]?.messages);
    assert.match(followUp, /toolu_luma/);
    assert.match(followUp, /toolu_district/);
    assert.match(followUp, /toolu_bms/);
  });

  it("keeps the keyword parser when Haiku does not answer", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://api.anthropic.com/v1/messages") return new Response("no", { status: 500 });
      return sources()(input, init);
    }) as typeof fetch;
    const events = await turn("comedy in Bengaluru under 500", fetchImpl, new ChatMemoryStore(), "", "", "test-anthropic-key");
    const titles = events.flatMap((event) => (event.type === "card" ? [event.listing.title] : []));
    assert.equal(titles.includes("Free Comedy"), true);
  });

  it("asks through the chat route when the city is missing", async () => {
    await withApi({ fetchImpl: sources(), mapsApiKey: "" }, async (base) => {
      const response = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "what's happening this week", timezone: "Asia/Kolkata" }),
      });
      assert.equal(response.status, 200);
      const events = parseSse<ChatEvent>(await response.text());
      assert.equal(events.some((event) => event.type === "card"), false);
      assert.equal(events.some((event) => event.type === "question"), true);
    });
  });

  it("accepts the published page and keeps its session on this Mac", async () => {
    await withApi({ fetchImpl: sources(), mapsApiKey: "" }, async (base) => {
      const headers = {
        origin: "https://event-scout.vercel.app",
        "content-type": "application/json",
        "x-scout-session": "ab".repeat(16),
      };
      const preflight = await fetch(`${base}/api/chat`, {
        method: "OPTIONS",
        headers: { origin: headers.origin, "access-control-request-headers": "content-type, x-scout-session" },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), headers.origin);
      const first = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "Bengaluru this week", timezone: "Asia/Kolkata" }),
      });
      assert.equal(first.headers.get("access-control-allow-origin"), headers.origin);
      assert.match(await first.text(), /Bengaluru/);
      const second = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "under 500", timezone: "Asia/Kolkata" }),
      });
      const followUp = await second.text();
      assert.match(followUp, /Bengaluru/);
      assert.match(followUp, /under ₹500/);
    });
  });
});
