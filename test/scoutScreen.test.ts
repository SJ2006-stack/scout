import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { captureScreenFrame, finishScreenShot, readScreenShot, screenCaptureAvailable, screenShotFile, startScreenCapture, takeScreenShot } from "../src/web/scoutScreen.ts";

const ID = "0123456789abcdef01234567";

describe("screen capture bridge", () => {
  const scope = globalThis as unknown as { window?: unknown };
  afterEach(() => {
    delete scope.window;
  });

  function fakeApp(reply: (body: Record<string, unknown>) => unknown): Record<string, unknown>[] {
    const calls: Record<string, unknown>[] = [];
    scope.window = {
      ScoutNative: {
        request: (json: string) => {
          const body = JSON.parse(json) as Record<string, unknown>;
          calls.push(body);
          return JSON.stringify(reply(body));
        },
      },
    };
    return calls;
  }

  it("accepts a jpeg frame and ignores a path or a bad id", () => {
    assert.deepEqual(readScreenShot({ id: ID, mime: "image/jpeg", bytes: 12, width: 80, height: 120, path: "/cache/x.jpg" }), {
      id: ID,
      mime: "image/jpeg",
      bytes: 12,
      width: 80,
      height: 120,
    });
    assert.equal(readScreenShot({ id: "../x", mime: "image/jpeg", bytes: 12, width: 1, height: 1 }), null);
    assert.equal(readScreenShot({ id: ID, mime: "image/png", bytes: 12, width: 1, height: 1 }), null);
  });

  it("does nothing outside the Android app", () => {
    scope.window = {};
    assert.equal(screenCaptureAvailable(), false);
    assert.equal(takeScreenShot(), null);
  });

  it("starts, captures, reads the jpeg, and deletes it", async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]);
    const calls = fakeApp((body) => {
      if (body.op === "screen_state") return { accepted: true, state: "waiting" };
      if (body.op === "screen_start" || body.op === "screen_frame") return { accepted: true };
      if (body.op === "screen_take") return { accepted: true, shot: { id: ID, mime: "image/jpeg", bytes: jpeg.length, width: 10, height: 20 } };
      if (body.op === "screen_file") return { accepted: true, mime: "image/jpeg", data: Buffer.from(jpeg).toString("base64") };
      return { accepted: true };
    });
    assert.equal(screenCaptureAvailable(), true);
    assert.equal(startScreenCapture(), true);
    assert.equal(captureScreenFrame(), true);
    const shot = takeScreenShot();
    assert.ok(shot);
    const file = screenShotFile(shot);
    assert.ok(file);
    assert.equal(file.type, "image/jpeg");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), jpeg);
    finishScreenShot(shot);
    assert.deepEqual(calls.map((body) => body.op), ["screen_state", "screen_start", "screen_frame", "screen_take", "screen_file", "screen_done"]);
  });

  it("treats a refused start as a failed capture", () => {
    fakeApp(() => ({ accepted: false }));
    assert.equal(startScreenCapture(), false);
    assert.equal(captureScreenFrame(), false);
  });
});
