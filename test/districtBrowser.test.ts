import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cityById } from "../src/shared/cities.ts";
import { ListingCache } from "../src/server/listingCache.ts";
import { districtTool } from "../src/server/tools/district.ts";
import type { ToolContext } from "../src/server/tools/types.ts";

const eventsHtml = `<script type="application/ld+json">${JSON.stringify({
  "@type": "ItemList",
  itemListElement: [{
    "@type": "ListItem",
    item: {
      "@type": "Event",
      name: "Free Comedy",
      url: "https://www.district.in/events/free-comedy",
      startDate: "2026-10-25T14:30:00.000Z",
      offers: { price: "0", priceCurrency: "INR" },
      location: { name: "Hall", address: { addressLocality: "Bengaluru" }, geo: { latitude: 12.97, longitude: 77.59 } },
    },
  }],
})}</script>`;

describe("district browser fallback", () => {
  it("reads District through the browser worker when the plain request is blocked", async () => {
    const seen: string[] = [];
    const result = await districtTool.load(context(async (url) => {
      seen.push(url);
      return { ok: true, html: eventsHtml };
    }));
    assert.deepEqual(seen, ["https://www.district.in/events/", "https://www.district.in/movies/"]);
    assert.equal(result.ok, true);
    assert.equal(result.message.includes("403"), false);
    assert.equal(result.listings.some((listing) => listing.title === "Free Comedy"), true);
  });

  it("reads through the browser worker when the plain page has no listings, and caches nothing empty", async () => {
    const seen: string[] = [];
    const cache = new ListingCache(60_000, () => 0);
    const empty = { ...context(async (url) => {
      seen.push(url);
      return { ok: true, html: "<html></html>" };
    }), cache, fetchImpl: async () => new Response("<html>shell</html>", { status: 200 }) };
    const first = await districtTool.load(empty);
    assert.equal(first.listings.length, 0);
    assert.deepEqual(seen, ["https://www.district.in/events/", "https://www.district.in/movies/"]);
    const second = await districtTool.load({ ...empty, readPage: async () => ({ ok: true, html: eventsHtml }) });
    assert.equal(second.listings.some((listing) => listing.title === "Free Comedy"), true);
  });

  it("keeps the 403 when the browser worker is off", async () => {
    const result = await districtTool.load(context());
    assert.equal(result.ok, false);
    assert.match(result.message, /HTTP 403/);
  });
});

function context(readPage?: ToolContext["readPage"]): ToolContext {
  const city = cityById("bengaluru");
  if (!city) throw new Error("Missing city");
  return {
    city,
    range: { startMs: 0, endMs: 1, phrase: "today" },
    kind: null,
    timezone: "Asia/Kolkata",
    retrievedAt: "2026-10-25T00:00:00.000Z",
    timeoutMs: 1_000,
    signal: new AbortController().signal,
    fetchImpl: async () => new Response("blocked", { status: 403 }),
    cache: new ListingCache(60_000, () => 0),
    readPage,
  };
}
