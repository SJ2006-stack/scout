import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GeocodeError, createGoogleGeocoder, parseArcGisReverse, parseGoogleGeocode, parseNominatimPayload } from "../src/server/geocode.ts";
import { createApiServer } from "../src/server/api.ts";
import { PriceCache } from "../src/server/cache.ts";
import { RateLimit } from "../src/server/rateLimit.ts";
import type { Geocoder } from "../src/server/geocode.ts";
import { withApi } from "./helpers.ts";

const sample = {
  place_id: 99,
  lat: "28.667",
  lon: "77.217",
  display_name: "12, Example Road, Karol Bagh, Delhi, 110005, India",
  address: { house_number: "12", road: "Example Road", suburb: "Karol Bagh", city: "Delhi", postcode: "110005" },
};

describe("reverse geocoding", () => {
  it("keeps the place name from a reverse-geocode result", () => {
    const address = parseArcGisReverse(
      {
        address: {
          PlaceName: "Nilgiri Hostel",
          Address: "Aruna Asaf Ali Marg",
          District: "Qutab Enclave",
          City: "South Delhi",
          MetroArea: "New Delhi",
          Region: "Delhi",
          Postal: "110016",
          CntryName: "India",
        },
        location: { x: 77.182401, y: 28.546622 },
      },
      { latitude: 1, longitude: 2, accuracyMeters: 12 },
    );
    assert.equal(address?.formattedAddress, "Nilgiri Hostel, Aruna Asaf Ali Marg, Qutab Enclave, New Delhi, Delhi, 110016, India");
    assert.equal(address?.landmark, "Nilgiri Hostel");
    assert.equal(address?.postalCode, "110016");
    assert.equal(address?.provider, "arcgis");
    assert.equal(parseArcGisReverse({ error: { message: "Unable to find address" } }, { latitude: 1, longitude: 2, accuracyMeters: null }), null);
  });

  it("keeps Google's formatted address and leaves missing parts blank", async () => {
    const payload = {
      status: "OK",
      results: [
        {
          formatted_address: "Nilgiri Hostel, D-64, Nilgiri Hostel Rd, Ber Sarai, New Delhi, Delhi 110016, India",
          place_id: "place-1",
          address_components: [
            { long_name: "D-64", types: ["street_number"] },
            { long_name: "Nilgiri Hostel Rd", types: ["route"] },
            { long_name: "Nilgiri Hostel", types: ["premise"] },
            { long_name: "Ber Sarai", types: ["sublocality_level_1", "sublocality", "political"] },
            { long_name: "110016", types: ["postal_code"] },
          ],
        },
      ],
    };
    const address = parseGoogleGeocode(payload, { latitude: 28.54, longitude: 77.18, accuracyMeters: 20 });
    assert.equal(address?.formattedAddress, "Nilgiri Hostel, D-64, Nilgiri Hostel Rd, Ber Sarai, New Delhi, Delhi 110016, India");
    assert.equal(address?.house, "D-64");
    assert.equal(address?.street, "Nilgiri Hostel Rd");
    assert.equal(address?.locality, "Ber Sarai");
    assert.equal(address?.landmark, "Nilgiri Hostel");
    assert.equal(address?.postalCode, "110016");
    assert.equal(address?.provider, "google");
    assert.equal(parseGoogleGeocode({ status: "ZERO_RESULTS", results: [] }, { latitude: 1, longitude: 2, accuracyMeters: null }), null);
    assert.throws(
      () => parseGoogleGeocode({ status: "OVER_DAILY_LIMIT", results: [] }, { latitude: 1, longitude: 2, accuracyMeters: null }),
      (error: unknown) => error instanceof GeocodeError && error.message === "The daily geocoding limit has been reached.",
    );

    let calls = 0;
    const geocoder = createGoogleGeocoder({
      apiKey: "test-key",
      timeoutMs: 50,
      now: () => 0,
      fetchImpl: async (input) => {
        calls += 1;
        const url = new URL(String(input));
        assert.equal(url.searchParams.get("latlng"), "28.54,77.18");
        assert.equal(url.searchParams.get("key"), "test-key");
        return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const first = await geocoder.reverse(28.54, 77.18, AbortSignal.timeout(50));
    const second = await geocoder.reverse(28.54, 77.18, AbortSignal.timeout(50));
    assert.equal(first?.house, "D-64");
    assert.equal(second?.formattedAddress, first?.formattedAddress);
    assert.equal(calls, 1);
  });

  it("maps a Nominatim payload without inventing missing parts", () => {
    const address = parseNominatimPayload(sample, { latitude: 1, longitude: 2, accuracyMeters: 15 });
    assert.equal(address?.house, "12");
    assert.equal(address?.street, "Example Road");
    assert.equal(address?.locality, "Karol Bagh");
    assert.equal(address?.landmark, "");
    assert.equal(address?.postalCode, "110005");
    assert.equal(address?.formattedAddress, "12, Example Road, Karol Bagh, Delhi, 110005");
    assert.equal(address?.placeId, "99");
    assert.equal(address?.provider, "nominatim");
    const nearbyPlace = parseNominatimPayload(
      {
        ...sample,
        display_name: "State Bank of India, Example Road, Karol Bagh, Delhi, 110005, India",
        address: { ...sample.address, amenity: "State Bank of India", country: "India" },
      },
      { latitude: 1, longitude: 2, accuracyMeters: null },
    );
    assert.equal(nearbyPlace?.formattedAddress, "12, Example Road, Karol Bagh, Delhi, 110005, India");
    assert.equal(parseNominatimPayload({ error: "Unable to geocode" }, { latitude: 1, longitude: 2, accuracyMeters: null }), null);
  });

  it("returns the address, an empty result, and provider failures", async () => {
    const geocoder: Geocoder = {
      async reverse(latitude) {
        if (latitude === 0) return null;
        if (latitude === 1) throw new GeocodeError("provider", "down");
        if (latitude === 2) throw new GeocodeError("timeout", "The address service timed out.");
        return parseNominatimPayload(sample, { latitude, longitude: 77, accuracyMeters: null });
      },
    };
    await withApi({ geocoder, timeoutMs: 50, geocodeRate: new RateLimit(0, Date.now) }, async (base) => {
      const found = await postPoint(base, 28.6, 77.2, 42);
      assert.equal(found.status, 200);
      const body = (await found.json()) as { postalCode?: string; accuracyMeters?: number; provider?: string };
      assert.equal(body.postalCode, "110005");
      assert.equal(body.accuracyMeters, 42);
      assert.equal(body.provider, "nominatim");

      const empty = await postPoint(base, 0, 0, null);
      assert.equal(empty.status, 404);

      const failed = await postPoint(base, 1, 0, null);
      assert.equal(failed.status, 502);

      const timedOut = await postPoint(base, 2, 0, null);
      assert.equal(timedOut.status, 504);

      const invalid = await postPoint(base, 99, 0, null);
      assert.equal(invalid.status, 400);
    });
  });

  it("rate limits repeated lookups from the same client", async () => {
    let calls = 0;
    const geocoder: Geocoder = {
      async reverse(latitude, longitude) {
        calls += 1;
        return parseNominatimPayload(sample, { latitude, longitude, accuracyMeters: null });
      },
    };
    const server = createApiServer({
      liveConnectors: [],
      cache: new PriceCache(60_000, () => 0),
      timeoutMs: 50,
      now: () => 0,
      demoStepMs: 0,
      geocoder,
      geocodeRate: new RateLimit(10_000, () => 0),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      assert.equal((await postPoint(base, 28.6, 77.2, null)).status, 200);
      assert.equal((await postPoint(base, 28.6, 77.2, null)).status, 429);
      assert.equal(calls, 1);
    } finally {
      server.close();
    }
  });
});

function postPoint(base: string, latitude: number, longitude: number, accuracyMeters: number | null): Promise<Response> {
  return fetch(`${base}/api/location/reverse-geocode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ latitude, longitude, accuracyMeters }),
  });
}
