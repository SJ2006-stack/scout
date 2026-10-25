import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectNetworkLocation, readNetworkPlace } from "../src/web/networkLocation.ts";

describe("network location", () => {
  it("reads the place returned for this connection", () => {
    const place = readNetworkPlace({
      success: true,
      city: "Ho Chi Minh City",
      region: "Ho Chi Minh",
      country: "Vietnam",
      latitude: 10.823,
      longitude: 106.6296,
    });
    assert.equal(place?.place, "Ho Chi Minh City, Ho Chi Minh, Vietnam");
    assert.equal(place?.lat, 10.823);
    assert.equal(readNetworkPlace({ success: false, message: "reserved" }), null);
    assert.equal(readNetworkPlace({ success: true, city: "", country: "" }), null);
  });

  it("uses the response from this request and does not keep an older place", async () => {
    const calls: string[] = [];
    const place = await detectNetworkLocation(async (input, init) => {
      calls.push(String(input));
      assert.equal(init?.cache, "no-store");
      return new Response(JSON.stringify({ success: true, city: "Da Nang", country: "Vietnam", latitude: 16.05, longitude: 108.2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    assert.deepEqual(calls, ["https://ipwho.is/"]);
    assert.equal(place?.place, "Da Nang, Vietnam");
  });
});
