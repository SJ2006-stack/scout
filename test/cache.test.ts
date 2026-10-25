import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cacheKey, PriceCache, roundCoordinate } from "../src/server/cache.ts";
import { parseQuery } from "../src/shared/parseQuery.ts";
import { confirmedArea, sampleOffer } from "./helpers.ts";

describe("price cache", () => {
  it("rounds coordinates to two decimal degrees and keeps locations apart", () => {
    assert.equal(roundCoordinate(28.666), 28.67);
    const parsed = parseQuery("Amul milk 1 L");
    const shared = {
      source: "store",
      keywords: parsed.keywords,
      quantity: parsed.quantity,
      pincode: "110001",
    };
    const near = cacheKey({ ...shared, lat: 28.666, lon: 77.216 });
    const sameCell = cacheKey({ ...shared, lat: 28.671, lon: 77.221 });
    const otherCell = cacheKey({ ...shared, lat: 28.641, lon: 77.204 });
    const otherPin = cacheKey({ ...shared, pincode: "110054", lat: 28.666, lon: 77.216 });
    assert.equal(near, sameCell);
    assert.notEqual(near, otherCell);
    assert.notEqual(near, otherPin);
  });

  it("expires a successful price and never turns a miss into a stored failure", () => {
    let now = 1_000;
    const cache = new PriceCache(60_000, () => now);
    const area = confirmedArea();
    const key = cacheKey({
      source: "store",
      keywords: "amul taaza milk",
      quantity: sampleOffer().quantity,
      pincode: area.pincode,
      lat: area.lat,
      lon: area.lon,
    });
    cache.set(key, [sampleOffer()]);
    const fresh = cache.get(key);
    assert.equal(fresh?.[0]?.provenance, "cached");
    assert.equal(fresh?.[0]?.retrievedAt, sampleOffer().retrievedAt);
    now += 60_000;
    assert.equal(cache.get(key), undefined);
    assert.equal(cache.get("missing"), undefined);
  });
});
