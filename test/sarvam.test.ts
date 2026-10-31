import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spokenLanguage } from "../src/shared/spoken.ts";
import { voiceResponse } from "../src/server/voice/sarvam.ts";
import { withApi } from "./helpers.ts";

describe("sarvam voice", () => {
  it("picks a speech language from the reply script", () => {
    assert.equal(spokenLanguage("What is on this weekend?"), "en-IN");
    assert.equal(spokenLanguage("दिल्ली में क्या हो रहा है"), "hi-IN");
    assert.equal(spokenLanguage("சென்னையில் என்ன"), "ta-IN");
  });

  it("stays quiet until a Sarvam key is set", async () => {
    let called = false;
    const result = await voiceResponse("POST", "/api/voice/stt", Uint8Array.from([1, 2]), "audio/webm", {
      fetchImpl: async () => {
        called = true;
        return Response.json({});
      },
    });
    assert.equal(called, false);
    assert.equal(result?.status, 503);
  });

  it("sends a recording to Saaras and a reply to Bulbul", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push(url);
      assert.equal(new Headers(init?.headers).get("api-subscription-key"), "test-key");
      if (url.endsWith("/speech-to-text")) return Response.json({ transcript: "events in Delhi" });
      const body = JSON.parse(String(init?.body)) as { language_code: string; model: string; speaker: string };
      assert.equal(body.language_code, "hi-IN");
      assert.equal(body.model, "bulbul:v3");
      assert.equal(body.speaker, "shubh");
      return Response.json({ audios: [Buffer.from("wav").toString("base64")] });
    };
    const heard = await voiceResponse("POST", "/api/voice/stt", Uint8Array.from([1, 2, 3]), "audio/webm", {
      sarvamApiKey: "test-key",
      fetchImpl,
    });
    assert.deepEqual(heard, { status: 200, body: { text: "events in Delhi" } });
    const spoken = await voiceResponse(
      "POST",
      "/api/voice/tts",
      new TextEncoder().encode(JSON.stringify({ text: "दिल्ली में तीन कार्यक्रम हैं" })),
      "application/json",
      { sarvamApiKey: "test-key", fetchImpl },
    );
    assert.equal(spoken?.status, 200);
    assert.equal((spoken?.body as { mediaType: string }).mediaType, "audio/wav");
    assert.deepEqual(seen, ["https://api.sarvam.ai/speech-to-text", "https://api.sarvam.ai/text-to-speech"]);
  });

  it("serves the voice routes without calling Sarvam when the key is empty", async () => {
    await withApi({ sarvamApiKey: "" }, async (base) => {
      const response = await fetch(`${base}/api/voice/tts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      assert.equal(response.status, 503);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /SARVAM_API_KEY/);
    });
  });
});
