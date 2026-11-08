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

  it("stays quiet until a Gnani key is set", async () => {
    let called = false;
    const result = await voiceResponse("POST", "/api/voice/stt", Uint8Array.from([1, 2]), "audio/webm", {
      fetchImpl: async () => {
        called = true;
        return Response.json({});
      },
    });
    assert.equal(called, false);
    assert.equal(result?.status, 503);
    assert.match((result?.body as { error: string }).error, /GNANI_API_KEY/);
  });

  it("sends a recording to Prisma and a reply to Bulbul", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push(url);
      const headers = new Headers(init?.headers);
      if (url.endsWith("/stt/v3")) {
        assert.equal(headers.get("X-API-Key-ID"), "gnani-key");
        const form = init?.body as FormData;
        assert.equal(form.get("format"), "codemix");
        assert.equal(form.get("model"), "prisma-v3.0");
        assert.equal(form.get("language_code"), "indic-auto");
        const file = form.get("audio_file");
        assert.equal(file instanceof File ? file.name : "", "speech.m4a");
        return Response.json({ transcript: "events in Delhi" });
      }
      assert.equal(headers.get("api-subscription-key"), "test-key");
      const body = JSON.parse(String(init?.body)) as { language_code: string; model: string; speaker: string };
      assert.equal(body.language_code, "hi-IN");
      assert.equal(body.model, "bulbul:v3");
      assert.equal(body.speaker, "shubh");
      return Response.json({ audios: [Buffer.from("wav").toString("base64")] });
    };
    const heard = await voiceResponse("POST", "/api/voice/stt", Uint8Array.from([1, 2, 3]), "audio/mp4", {
      gnaniApiKey: "gnani-key",
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
    assert.deepEqual(seen, ["https://api.vachana.ai/stt/v3", "https://api.sarvam.ai/text-to-speech"]);
  });

  it("says when Prisma heard nothing", async () => {
    const result = await voiceResponse("POST", "/api/voice/stt", Uint8Array.from([1]), "audio/wav", {
      gnaniApiKey: "gnani-key",
      fetchImpl: async () => Response.json({ transcript: "" }),
    });
    assert.equal(result?.status, 422);
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
