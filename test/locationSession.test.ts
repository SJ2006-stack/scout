import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseLocationSession,
  readCurrentPosition,
  requestBrowserLocation,
  serializeLocationSession,
} from "../src/web/locationSession.ts";

describe("location session", () => {
  it("restores a confirmed point and drops a broken payload", () => {
    const raw = serializeLocationSession({
      lat: 28.666775,
      lon: 77.216681,
      pincode: "",
      confirmed: true,
      accuracyMeters: 40,
      detectedAt: 1_000,
    });
    const session = parseLocationSession(raw);
    assert.equal(session?.confirmed, true);
    assert.equal(session?.lat, 28.666775);
    assert.equal(session?.pincode, "");
    assert.equal(parseLocationSession("{"), null);
    assert.equal(parseLocationSession(JSON.stringify({ lat: null, lon: null, pincode: "", confirmed: true })), null);
  });

  it("reuses a recent fix and reports device errors", async () => {
    const recent = { lat: 28.67, lon: 77.22, accuracyMeters: 30, detectedAt: 5_000 };
    const reused = await requestBrowserLocation({ recent, now: 5_000 + 60_000 });
    assert.equal(reused.ok && reused.reused, true);

    const denied = await readCurrentPosition(
      {
        getCurrentPosition(_success, error) {
          error({ code: 1 });
        },
      },
      0,
    );
    assert.deepEqual(denied, { ok: false, failure: "denied" });

    const timedOut = await readCurrentPosition(
      {
        getCurrentPosition(_success, error) {
          error({ code: 3 });
        },
      },
      0,
    );
    assert.deepEqual(timedOut, { ok: false, failure: "timeout" });

    let freshOptions: { enableHighAccuracy?: boolean; maximumAge?: number } | undefined;
    const found = await readCurrentPosition(
      {
        getCurrentPosition(success, _error, options) {
          freshOptions = options;
          success({ coords: { latitude: 12.5, longitude: 77.5, accuracy: 18 } });
        },
      },
      9,
      { fresh: true },
    );
    assert.equal(freshOptions?.enableHighAccuracy, true);
    assert.equal(freshOptions?.maximumAge, 0);
    assert.equal(found.ok && found.fix.accuracyMeters, 18);
    assert.equal(found.ok && found.fix.detectedAt, 9);

    const unsupported = await requestBrowserLocation({ fresh: true });
    assert.equal(unsupported.ok, false);
    if (!unsupported.ok) assert.equal(unsupported.failure, "unsupported");
  });
});
