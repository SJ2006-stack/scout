import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cardAction } from "../src/shared/event.ts";

describe("card links", () => {
  it("uses the BookMyShow listing url for the whole card", () => {
    const action = cardAction({
      platform: "BookMyShow",
      url: "https://in.bookmyshow.com/delhi/movies/udta-teer/ET00412345",
    });
    assert.equal(action?.href, "https://in.bookmyshow.com/delhi/movies/udta-teer/ET00412345");
    assert.equal(action?.label, "View on BookMyShow");
  });

  it("drops a non-https or other-host url", () => {
    assert.equal(cardAction({ platform: "BookMyShow", url: "http://in.bookmyshow.com/delhi/movies/a" }), null);
    assert.equal(cardAction({ platform: "BookMyShow", url: "https://evil.example/delhi/movies/a" }), null);
  });

  it("labels a District ticket page differently from a listing page", () => {
    const booking = cardAction({ platform: "District", url: "https://www.district.in/events/show-buy-tickets" });
    const listing = cardAction({ platform: "District", url: "https://www.district.in/movies/udta-teer-MV1" });
    assert.equal(booking?.label, "Book on District");
    assert.equal(listing?.label, "View on District");
  });
});
