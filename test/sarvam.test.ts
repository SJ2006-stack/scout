import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { voiceResponse } from "../src/server/voice/sarvam.ts";

describe("sarvam voice", () => {
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

  it("sends a recording to Prisma", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push(url);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("X-API-Key-ID"), "gnani-key");
      const form = init?.body as FormData;
      assert.equal(form.get("format"), "codemix");
      assert.equal(form.get("model"), "prisma-v3.0");
      assert.equal(form.get("language_code"), "indic-auto");
      const file = form.get("audio_file");
      assert.equal(file instanceof File ? file.name : "", "speech.m4a");
      return Response.json({ transcript: "events in Delhi" });
    };
    const heard = await voiceResponse("POST", "/api/voice/stt", Uint8Array.from([1, 2, 3]), "audio/mp4", {
      gnaniApiKey: "gnani-key",
      fetchImpl,
    });
    assert.deepEqual(heard, { status: 200, body: { text: "events in Delhi" } });
    assert.deepEqual(seen, ["https://api.vachana.ai/stt/v3"]);
  });

  it("says when Prisma heard nothing", async () => {
    const result = await voiceResponse("POST", "/api/voice/stt", Uint8Array.from([1]), "audio/wav", {
      gnaniApiKey: "gnani-key",
      fetchImpl: async () => Response.json({ transcript: "" }),
    });
    assert.equal(result?.status, 422);
  });
});
