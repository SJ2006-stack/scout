import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readNativeSpeech } from "../src/shared/nativeSpeech.ts";

describe("phone speech", () => {
  it("keeps a recording, a transcript, and a permission failure apart", () => {
    assert.deepEqual(readNativeSpeech(JSON.stringify({ op: "microphone", granted: true, recording: true })), { kind: "recording" });
    assert.deepEqual(readNativeSpeech(JSON.stringify({ op: "microphone", granted: true, text: "films tonight" })), { kind: "text", text: "films tonight" });
    assert.deepEqual(
      readNativeSpeech(JSON.stringify({ op: "microphone", granted: false, error: "Microphone permission is needed to talk." })),
      { kind: "error", message: "Microphone permission is needed to talk." },
    );
    assert.equal(readNativeSpeech(JSON.stringify({ op: "location", granted: true })), null);
  });
});