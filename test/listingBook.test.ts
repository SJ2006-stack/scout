import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Listing } from "../src/shared/event.ts";
import { bookActionForListing } from "../src/shared/listingBook.ts";

const NOW = Date.parse("2026-11-06T10:00:00.000Z");

function listing(overrides: Partial<Listing>): Listing {
  return {
    id: "1",
    sourceId: "1",
    platform: "BookMyShow",
    title: "Ramayana",
    kind: "movie",
    posterUrl: null,
    start: null,
    end: null,
    timezone: "Asia/Kolkata",
    city: "Delhi",
    venue: null,
    lat: null,
    lon: null,
    price: { min: null, max: null, currency: "INR", provenance: "unknown" },
    url: "https://in.bookmyshow.com/movies/delhi/ramayana/ET00000001",
    retrievedAt: "2026-11-06T09:00:00.000Z",
    category: null,
    driveMinutes: null,
    ...overrides,
  };
}

describe("book button on the phone", () => {
  it("turns a BookMyShow card into one app_event_book that asks for Allow and leaves seats to them", () => {
    const action = bookActionForListing(listing({}), "a".repeat(24), NOW);
    assert.equal(action?.name, "app_event_book");
    if (action?.name !== "app_event_book") return;
    assert.equal(action.confirm, true);
    assert.equal(action.args.ref.app, "bookmyshow");
    assert.equal(action.args.tickets, 1);
    assert.equal(action.args.seat, "user_picks");
    assert.equal(action.expiresAt > NOW, true);
  });

  it("keeps a District start time and price", () => {
    const action = bookActionForListing(
      listing({ platform: "District", kind: "comedy", url: "https://www.district.in/events/stand-up-comedy-show", start: "2026-11-07T09:30:00+05:30", price: { min: 149, max: null, currency: "INR", provenance: "advertised" } }),
      "b".repeat(24),
      NOW,
    );
    if (action?.name !== "app_event_book") return assert.fail("expected app_event_book");
    assert.equal(action.args.ref.app, "district");
    assert.equal(action.args.ref.price, 149);
    assert.equal(action.args.ref.startsAt, Date.parse("2026-11-07T09:30:00+05:30"));
    assert.equal(action.args.showtime, Date.parse("2026-11-07T09:30:00+05:30"));
  });

  it("leaves the showtime for movies and for a start that has passed", () => {
    const movie = bookActionForListing(listing({ platform: "District", url: "https://www.district.in/movies/ramayana-MV1", start: "2026-11-07T09:30:00+05:30" }), "d".repeat(24), NOW);
    const past = bookActionForListing(listing({ platform: "District", kind: "comedy", url: "https://www.district.in/events/open-mic", start: "2026-11-01T09:30:00+05:30" }), "e".repeat(24), NOW);
    if (movie?.name !== "app_event_book" || past?.name !== "app_event_book") return assert.fail("expected app_event_book");
    assert.equal(movie.args.showtime, null);
    assert.equal(past.args.showtime, null);
  });

  it("refuses a link that is not on the event app's own host", () => {
    assert.equal(bookActionForListing(listing({ url: "https://evil.example/movies/ramayana" }), "c".repeat(24), NOW), null);
  });
});
