import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { excludedKinds, parseChatIntent } from "../src/shared/chatIntent.ts";
import { calendarDate, dateRange, dayRange } from "../src/shared/when.ts";
import { districtEvents, districtMovies } from "../src/server/events/district.ts";
import { lumaEvents } from "../src/server/events/luma.ts";
import { ChatMemoryStore } from "../src/server/chatMemory.ts";
import { runChat } from "../src/server/chatRun.ts";
import { SARVAM_CHAT_MODEL, SARVAM_CHAT_URL } from "../src/server/sarvamChat.ts";
import { ListingCache } from "../src/server/listingCache.ts";
import { driveMinutes } from "../src/server/travel.ts";
import { cityById, type City } from "../src/shared/cities.ts";
import type { ChatEvent } from "../src/shared/chatEvents.ts";
import { parseSse, withApi } from "./helpers.ts";
import { sarvamReply } from "./sarvamReply.ts";

const city: City = {
  id: "bengaluru",
  name: "Bengaluru",
  lumaSlug: "bengaluru",
  bookMyShowSlug: "bengaluru",
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
  readPage: ((url: string) => Promise<{ ok: true; html: string } | { ok: false; message: string }>) | undefined = undefined,
  sarvamApiKey = "",
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
      sarvamApiKey,
      ...(readPage ? { readPage } : {}),
    },
    (event) => events.push(event),
  );
  return events;
}

const bookMyShowEventsHtml = `<script type="application/ld+json">${JSON.stringify({
  "@type": "ItemList",
  itemListElement: [
    { "@type": "ListItem", item: { "@type": "ComedyEvent", name: "Cheap Standup Comedy", url: "https://in.bookmyshow.com/events/cheap-standup/ET00000001", startDate: "2026-10-25T20:00:00", location: { "@type": "Place", name: "Hall One" }, offers: { "@type": "Offer", price: "199" } } },
    { "@type": "ListItem", item: { "@type": "ComedyEvent", name: "Pricey Standup Comedy", url: "https://in.bookmyshow.com/events/pricey-standup/ET00000002", startDate: "2026-10-25T21:00:00", offers: { "@type": "Offer", price: "800" } } },
    { "@type": "ListItem", item: { "@type": "ComedyEvent", name: "Bad Link Comedy", url: "http://in.bookmyshow.com/events/bad/ET00000003", startDate: "2026-10-25T21:00:00" } },
  ],
})}</script>`;

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

  it("reads BookMyShow's explore page and keeps a comedy under the budget", async () => {
    const asked: string[] = [];
    const readPage = async (url: string) => {
      asked.push(url);
      return { ok: true as const, html: bookMyShowEventsHtml };
    };
    const events = await turn("comedy in Bengaluru under 500", sources(), new ChatMemoryStore(), "", readPage);
    const titles = events.flatMap((event) => (event.type === "card" ? [event.listing.title] : []));
    assert.equal(titles.includes("Cheap Standup Comedy"), true);
    assert.equal(titles.includes("Pricey Standup Comedy"), false);
    assert.equal(titles.includes("Bad Link Comedy"), false);
    const cheap = events.find((event) => event.type === "card" && event.listing.title === "Cheap Standup Comedy");
    assert.equal(cheap?.type === "card" && cheap.listing.platform, "BookMyShow");
    assert.equal(cheap?.type === "card" && cheap.listing.price.min, 199);
    assert.deepEqual(asked.filter((url) => url.includes("bookmyshow")), ["https://in.bookmyshow.com/explore/events-bengaluru"]);
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

  it("treats tomorrow as the next calendar day in Asia/Kolkata", () => {
    const now = Date.parse("2026-10-26T18:35:00.000Z");
    const range = dateRange("tomorrow", now, "Asia/Kolkata");
    assert.equal(calendarDate(now, "Asia/Kolkata"), "2026-10-27");
    assert.equal(new Date(range.startMs).toISOString(), "2026-10-27T18:30:00.000Z");
    assert.equal(new Date(range.endMs).toISOString(), "2026-10-28T18:30:00.000Z");
    assert.equal(calendarDate(range.startMs, "Asia/Kolkata"), "2026-10-28");
    const explicit = dayRange("2026-10-28", "Asia/Kolkata");
    assert.equal(explicit?.startMs, range.startMs);
    assert.equal(explicit?.endMs, range.endMs);
    assert.equal(dayRange("2026-02-31", "Asia/Kolkata"), null);
    assert.equal(parseChatIntent("okay, what's happening tomorrow in delhi").date, "tomorrow");
    assert.equal(parseChatIntent("this week in delhi").date, "week");
    const thirtyFirst = Date.parse("2026-10-29T06:30:00.000Z");
    assert.equal(parseChatIntent("what's happening on the 31st in delhi", thirtyFirst, "Asia/Kolkata").date, "2026-10-31");
    assert.equal(parseChatIntent("shows on 31 October in delhi", thirtyFirst, "Asia/Kolkata").date, "2026-10-31");
    assert.equal(parseChatIntent("friday night in delhi", thirtyFirst, "Asia/Kolkata").date, "2026-10-30");
    const hindi = parseChatIntent("दिल्ली में 31 तारीख को क्या हो रहा है", thirtyFirst, "Asia/Kolkata");
    assert.equal(hindi.city?.id, "delhi");
    assert.equal(hindi.date, "2026-10-31");
    assert.equal(parseChatIntent("मुंबई में कल क्या है", thirtyFirst, "Asia/Kolkata").date, "tomorrow");
    assert.equal(parseChatIntent("Any other thing happening in delhi aside from comedy shows").kind.kind, "clear");
    assert.deepEqual(excludedKinds("Any other thing happening in delhi aside from comedy shows"), ["comedy"]);
    assert.deepEqual(excludedKinds("except the ones already shown"), []);
    assert.equal(parseChatIntent("any other").kind.kind, "keep");
    const named = dateRange("2026-10-31", thirtyFirst, "Asia/Kolkata");
    assert.equal(calendarDate(named.startMs, "Asia/Kolkata"), "2026-10-31");
    assert.equal(new Date(named.endMs - 1).toISOString() > new Date(named.startMs).toISOString(), true);
  });

  it("remembers the city for a later budget", async () => {
    const memory = new ChatMemoryStore();
    await turn("what's happening in Bengaluru this week", sources(), memory);
    const events = await turn("under 500", sources(), memory);
    assert.equal(events.some((event) => event.type === "question" && event.message.includes("Bengaluru")), true);
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

  it("lets Sarvam talk and call Luma, District, and BookMyShow", async () => {
    const bodies: WireBody[] = [];
    const headers: Headers[] = [];
    let modelCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === SARVAM_CHAT_URL) {
        modelCalls += 1;
        const body = JSON.parse(String(init?.body)) as WireBody;
        bodies.push(body);
        headers.push(new Headers(init?.headers));
        if (modelCalls === 1) {
          return Response.json(sarvamReply({
            stop_reason: "tool_use",
            content: [
              { type: "text", text: "I'll check Bengaluru for tonight." },
              { type: "tool_use", id: "toolu_luma", name: "search_luma", input: { city: "bengaluru", when: "today", kind: "any", budgetRupees: 0 } },
              { type: "tool_use", id: "toolu_district", name: "search_district", input: { city: "bengaluru", when: "today", kind: "any", budgetRupees: 0 } },
              { type: "tool_use", id: "toolu_bms", name: "search_bookmyshow", input: { city: "bengaluru", when: "today", kind: "any", budgetRupees: 0 } },
            ],
          }));
        }
        return Response.json(sarvamReply({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Tonight in Bengaluru I found Roast Tank on Luma." }],
        }));
      }
      return sources()(input, init);
    }) as typeof fetch;
    const events = await turn("films tonight in the garden city", fetchImpl, new ChatMemoryStore(), "", undefined, "test-sarvam-key");
    const replies = events.flatMap((event) => (event.type === "question" ? [event.message] : []));
    assert.match(replies.join("\n"), /Roast Tank/);
    assert.equal(events.some((event) => event.type === "card" && event.listing.title === "Roast Tank"), true);
    assert.equal(events.some((event) => event.type === "source" && event.source === "BookMyShow"), true);
    const names = bodies[0]?.tools?.map((tool) => tool.function?.name);
    assert.deepEqual(names, ["search_luma", "search_district", "search_bookmyshow", "open_event", "register_event", "ask_user", "phone_action"]);
    assert.equal(bodies[0]?.model, SARVAM_CHAT_MODEL);
    assert.equal(bodies[0]?.temperature, undefined);
    assert.equal(bodies[0]?.reasoning_effort, "low");
    assert.equal(headers[0]?.get("api-subscription-key"), "test-sarvam-key");
    const followUp = JSON.stringify(bodies[1]?.messages);
    assert.match(followUp, /toolu_luma/);
    assert.match(followUp, /toolu_district/);
    assert.match(followUp, /toolu_bms/);
  });

  it("keeps the keyword parser when Sarvam does not answer", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === SARVAM_CHAT_URL) return new Response("no", { status: 500 });
      return sources()(input, init);
    }) as typeof fetch;
    const events = await turn("comedy in Bengaluru under 500", fetchImpl, new ChatMemoryStore(), "", undefined, "test-sarvam-key");
    const titles = events.flatMap((event) => (event.type === "card" ? [event.listing.title] : []));
    assert.equal(titles.includes("Free Comedy"), true);
  });

  it("leaves comedy out and does not call undated movies the weekend", async () => {
    const memory = new ChatMemoryStore();
    memory.save("session", {
      cityId: "bengaluru",
      lat: null,
      lon: null,
      budget: null,
      date: "week",
      kind: "comedy",
      timezone: "Asia/Kolkata",
      lines: [],
      found: [{ title: "Free Comedy", url: "https://www.district.in/events/free-comedy" }],
    });
    const events = await turn("Any other thing happening in bengaluru aside from comedy shows", sources(), memory);
    const titles = events.flatMap((event) => (event.type === "card" ? [event.listing.title] : []));
    assert.equal(titles.includes("Udta Teer"), false);
    assert.equal(titles.includes("Free Comedy"), false);
    assert.equal(titles.includes("Roast Tank"), true);
    const question = events.find((event) => event.type === "question");
    assert.equal(question?.type === "question" && question.message.includes("Nothing else matched"), false);
  });

  it("shows the next listings when tomorrow itself is empty", async () => {
    const now = Date.parse("2026-11-09T07:00:00.000Z");
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("api.luma.com")) {
        return Response.json({ entries: [lumaShow("Weekend Show", "weekend-show", "2026-11-14T12:30:00.000Z")] });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const events: ChatEvent[] = [];
    await runChat(
      {
        sessionId: "session",
        text: "what's happening tomorrow in delhi",
        timezone: "Asia/Kolkata",
        pincode: "",
        lat: null,
        lon: null,
        timeoutMs: 1000,
        signal: new AbortController().signal,
        now: () => now,
        memory: new ChatMemoryStore(),
        cache: new ListingCache(60_000, () => now),
        fetchImpl,
        mapsApiKey: "",
        sarvamApiKey: "",
      },
      (event) => events.push(event),
    );
    const cards = events.flatMap((event) => (event.type === "card" ? [event.listing.title] : []));
    assert.deepEqual(cards, ["Weekend Show"]);
    const question = events.find((event) => event.type === "question");
    assert.match(question?.type === "question" ? question.message : "", /Nothing is listed for tomorrow in Delhi/);
    assert.match(question?.type === "question" ? question.message : "", /Weekend Show/);
    assert.equal(events.some((event) => event.type === "status" && event.message === "Event Scout fetching from Luma, District, and BookMyShow."), true);
    const brief = events.find((event) => event.type === "brief");
    assert.equal(brief?.type === "brief" && brief.fed, false);
    assert.equal(brief?.type === "brief" && brief.tools.some((tool) => tool.name === "search_district"), true);
    assert.equal(brief?.type === "brief" && brief.tools.some((tool) => tool.name === "search_luma"), true);
    assert.equal(brief?.type === "brief" && brief.tools.some((tool) => tool.name === "search_bookmyshow"), true);
  });

  it("clamps tomorrow to that day even when Sarvam asks for a week", async () => {
    const now = Date.parse("2026-10-26T18:35:00.000Z");
    const cache = new ListingCache(60_000, () => now);
    const bodies: WireBody[] = [];
    let modelCalls = 0;
    let lumaCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === SARVAM_CHAT_URL) {
        modelCalls += 1;
        const body = JSON.parse(String(init?.body)) as WireBody;
        bodies.push(body);
        if (modelCalls % 2 === 1) {
          return Response.json(sarvamReply({
            stop_reason: "tool_use",
            content: [
              { type: "tool_use", id: "toolu_luma", name: "search_luma", input: { city: "delhi", when: "week", kind: "any", budgetRupees: 0 } },
            ],
          }));
        }
        return Response.json(sarvamReply({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Tomorrow in Delhi I only have Tomorrow Show." }],
        }));
      }
      if (url.includes("api.luma.com")) {
        lumaCalls += 1;
        return new Response(JSON.stringify({
          entries: [
            lumaShow("Today Show", "today-show", "2026-10-27T09:30:00.000Z"),
            lumaShow("Tomorrow Show", "tomorrow-show", "2026-10-28T09:30:00.000Z"),
            lumaShow("Later Show", "later-show", "2026-10-31T09:30:00.000Z"),
            lumaShow("Undated Show", "undated-show", null),
          ],
        }), { status: 200 });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const first = await sarvamTurn("what's happening tomorrow in delhi", fetchImpl, cache, now);
    const second = await sarvamTurn("what's happening tomorrow in delhi", fetchImpl, cache, now);
    for (const events of [first, second]) {
      const status = events.find((event) => event.type === "status" && event.message.startsWith("Looking"));
      assert.match(status?.type === "status" ? status.message : "", /Looking in Delhi for tomorrow/);
      assert.doesNotMatch(status?.type === "status" ? status.message : "", /seven days/);
      assert.equal(events.some((event) => event.type === "status" && event.message === "Message sent to Event Scout."), true);
      assert.equal(events.some((event) => event.type === "status" && event.message === "Event Scout fetching from Luma."), true);
      const brief = events.find((event) => event.type === "brief");
      assert.equal(brief?.type === "brief" && brief.fed, true);
      assert.match(brief?.type === "brief" ? brief.prompt : "", /Event Scout/);
      assert.equal(brief?.type === "brief" && brief.tools.some((tool) => tool.name === "search_bookmyshow"), true);
      const cards = events.flatMap((event) => (event.type === "card" ? [event.listing] : []));
      assert.deepEqual(cards.map((card) => card.title), ["Tomorrow Show"]);
      assert.equal(calendarDate(Date.parse(cards[0]?.start ?? ""), "Asia/Kolkata"), "2026-10-28");
    }
    assert.equal(lumaCalls, 1);
    const followUps = bodies.filter((body) => body.messages?.some((message) => message.role === "tool"));
    assert.equal(followUps.length, 2);
    const parsed = followUps.map((body) => toolResultJson(body));
    assert.equal(parsed[0]?.cached, false);
    assert.equal(parsed[1]?.cached, true);
    for (const result of parsed) {
      assert.equal(result?.source, "Luma");
      assert.equal(result?.ok, true);
      assert.equal(result?.window, "tomorrow");
      assert.equal(result?.date, "2026-10-28");
      assert.equal(result?.start, "2026-10-28");
      assert.equal(result?.end, "2026-10-28");
      assert.equal(result?.timezone, "Asia/Kolkata");
      assert.equal(result?.listings.length, 1);
      assert.equal(result?.listings[0]?.title, "Tomorrow Show");
      assert.equal(result?.listings[0]?.kind, "other");
      assert.equal(result?.listings[0]?.start, "2026-10-28T09:30:00.000Z");
      assert.equal(typeof result?.listings[0]?.price, "string");
      assert.equal(result?.listings[0]?.url, "https://luma.com/tomorrow-show");
    }
    const instructions = systemText(bodies[0]);
    assert.match(instructions, /2026-10-27/);
    assert.match(instructions, /Asia\/Kolkata/);
    assert.match(instructions, /Do not use week for one day/);
    assert.match(instructions, /Reply in the language of their latest message/);
    const searchTool = bodies[0]?.tools?.[0]?.function;
    assert.match(searchTool?.description ?? "", /YYYY-MM-DD/);
    assert.equal(searchTool?.parameters?.properties?.when?.enum, undefined);
  });

  it("puts listings past the first three behind Show more and names them to the model", async () => {
    const now = Date.parse("2026-10-26T18:35:00.000Z");
    const cache = new ListingCache(60_000, () => now);
    const bodies: WireBody[] = [];
    let modelCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === SARVAM_CHAT_URL) {
        modelCalls += 1;
        bodies.push(JSON.parse(String(init?.body)) as WireBody);
        if (modelCalls === 1) {
          return Response.json(sarvamReply({
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "toolu_luma", name: "search_luma", input: { city: "delhi", when: "week", kind: "any", budgetRupees: 0 } }],
          }));
        }
        return Response.json(sarvamReply({ stop_reason: "end_turn", content: [{ type: "text", text: "Three shows are up; the rest are under Show more." }] }));
      }
      if (url.includes("api.luma.com")) {
        const days = ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"];
        return Response.json({ entries: days.map((day, index) => lumaShow(`Show ${index + 1}`, `show-${index + 1}`, `${day}T09:30:00.000Z`)) });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const events = await sarvamTurn("what's on in delhi this week", fetchImpl, cache, now);
    const cards = events.flatMap((event) => (event.type === "card" ? [event.listing.title] : []));
    const more = events.flatMap((event) => (event.type === "more" ? event.listings.map((listing) => listing.title) : []));
    assert.equal(cards.length, 3);
    assert.equal(more.length, 3);
    assert.equal(new Set([...cards, ...more]).size, 6);
    const result = toolResultJson(bodies[1] ?? {}) as { more?: Array<{ title?: string }>; moreCount?: number } | null;
    assert.equal(result?.moreCount, 3);
    assert.deepEqual(result?.more?.map((item) => item.title).sort(), [...more].sort());
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

function lumaShow(name: string, slug: string, start: string | null) {
  return {
    ticket_info: { price: null, is_free: true, max_price: null },
    event: {
      api_id: slug,
      name,
      url: slug,
      start_at: start,
      timezone: "Asia/Kolkata",
      geo_address_info: { city: "Delhi", address: "Connaught Place" },
    },
  };
}

async function sarvamTurn(text: string, fetchImpl: typeof fetch, cache: ListingCache, nowMs: number): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  await runChat(
    {
      sessionId: "session",
      text,
      timezone: "Asia/Kolkata",
      pincode: "",
      lat: null,
      lon: null,
      timeoutMs: 1000,
      signal: new AbortController().signal,
      now: () => nowMs,
      memory: new ChatMemoryStore(),
      cache,
      fetchImpl,
      mapsApiKey: "",
      sarvamApiKey: "test-sarvam-key",
    },
    (event) => events.push(event),
  );
  return events;
}

type WireMessage = { role?: string; content?: unknown };
type WireTool = {
  function?: {
    name?: string;
    description?: string;
    parameters?: { properties?: { when?: { enum?: string[] } } };
  };
};
type WireBody = {
  model?: string;
  temperature?: unknown;
  reasoning_effort?: string;
  tools?: WireTool[];
  messages?: WireMessage[];
};

function systemText(body: WireBody | undefined): string {
  const system = body?.messages?.find((message) => message.role === "system");
  return typeof system?.content === "string" ? system.content : "";
}

function toolResultJson(body: { messages?: WireMessage[] }): {
  source?: string;
  ok?: boolean;
  cached?: boolean;
  window?: string;
  date?: string | null;
  start?: string | null;
  end?: string | null;
  timezone?: string;
  listings: Array<{ title?: string; kind?: string; start?: string | null; price?: string; url?: string }>;
} | null {
  for (const message of body.messages ?? []) {
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    return JSON.parse(message.content) as ReturnType<typeof toolResultJson>;
  }
  return null;
}
