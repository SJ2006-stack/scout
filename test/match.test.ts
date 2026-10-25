import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifiedDiscount } from "../src/shared/offer.ts";
import { dedupeOffers, prepareOffers, samePack } from "../src/server/match.ts";
import { sampleOffer } from "./helpers.ts";

describe("offers", () => {
  it("shows a discount only when MRP is a higher number", () => {
    assert.equal(verifiedDiscount(66, 99), 33);
    assert.equal(verifiedDiscount(66, 66), null);
    assert.equal(verifiedDiscount(66, 40), null);
    assert.equal(verifiedDiscount(66, null), null);
    assert.equal(verifiedDiscount(66, Number.NaN), null);
  });

  it("keeps the cheaper copy of the same pack and keeps other platforms", () => {
    const expensive = sampleOffer({ id: "high", price: 80 });
    const cheap = sampleOffer({ id: "low", price: 61 });
    const otherPlatform = sampleOffer({ id: "other", price: 90, platform: "Other" });
    const otherPack = sampleOffer({
      id: "pouch",
      price: 20,
      quantity: { amount: 200, unit: "ml", raw: "200 ml" },
      quantityLabel: "200 ml",
    });
    const kept = dedupeOffers([expensive, otherPlatform, cheap, otherPack]);
    assert.deepEqual(
      kept.map((offer) => offer.id).sort(),
      ["low", "other", "pouch"],
    );
    assert.equal(samePack(expensive, cheap), true);
    assert.equal(samePack(expensive, otherPlatform), false);
    assert.equal(samePack(expensive, otherPack), false);
  });

  it("sorts by ascending price", () => {
    const sorted = prepareOffers([
      sampleOffer({ id: "b", price: 70, mrp: 70 }),
      sampleOffer({ id: "a", price: 50, mrp: 80, platform: "A" }),
    ]);
    assert.deepEqual(
      sorted.map((offer) => offer.price),
      [50, 70],
    );
    assert.equal(sorted[0]?.discountAmount, 30);
    assert.equal(sorted[1]?.discountAmount, null);
  });
});
