import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachOcrText, ocrMediaType, textFromOcrContent } from "../src/shared/ocr.ts";
import { ocrResponse } from "../src/server/ocr.ts";

describe("attachment OCR", () => {
  it("keeps writing and drops a description-shaped block", () => {
    assert.equal(ocrMediaType("image/jpg; charset=binary"), "image/jpeg");
    assert.equal(ocrMediaType("application/pdf"), null);
    assert.equal(textFromOcrContent([
      { type: "text", text: " Amul Taaza " },
      { type: "image", text: "ignore" },
      { type: "text", text: "1 litre" },
    ]), "Amul Taaza\n1 litre");
    assert.equal(attachOcrText("Find this", "Amul Taaza"), "Find this\nAmul Taaza");
    assert.equal(attachOcrText("  ", "Amul Taaza"), "Amul Taaza");
  });

  it("reads a JPEG through gemma4 and refuses other files", async () => {
    const seen: { url: string; body: string }[] = [];
    const result = await ocrResponse("POST", Uint8Array.from([1, 2, 3]), "image/jpeg", {
      sarvamApiKey: "test-key",
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), body: String(init?.body) });
        return new Response(JSON.stringify({ choices: [{ message: { content: "Gate 4" } }] }), { status: 200 });
      },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { text: "Gate 4" });
    assert.equal(seen[0]?.url, "https://api.sarvam.ai/v2/chat/completions");
    assert.match(seen[0]?.body ?? "", /"model":"gemma4"/);
    assert.match(seen[0]?.body ?? "", /data:image\/jpeg;base64,/);
    assert.doesNotMatch(seen[0]?.body ?? "", /anthropic|claude/i);
    const missing = await ocrResponse("POST", Uint8Array.from([1]), "image/png", { sarvamApiKey: "" });
    assert.equal(missing.status, 503);
    assert.match(JSON.stringify(missing.body), /SARVAM_API_KEY/);
    const wrong = await ocrResponse("POST", Uint8Array.from([1]), "application/pdf", { sarvamApiKey: "test-key" });
    assert.equal(wrong.status, 415);
  });
});
