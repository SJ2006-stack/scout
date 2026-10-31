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

  it("reads a JPEG through the model and refuses other files", async () => {
    const seen: string[] = [];
    const result = await ocrResponse("POST", Uint8Array.from([1, 2, 3]), "image/jpeg", {
      anthropicApiKey: "test-key",
      fetchImpl: async (_url, init) => {
        seen.push(String(init?.body));
        return new Response(JSON.stringify({ content: [{ type: "text", text: "Gate 4" }] }), { status: 200 });
      },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { text: "Gate 4" });
    assert.match(seen[0] ?? "", /image\/jpeg/);
    const missing = await ocrResponse("POST", Uint8Array.from([1]), "image/png", { anthropicApiKey: "" });
    assert.equal(missing.status, 503);
    const wrong = await ocrResponse("POST", Uint8Array.from([1]), "application/pdf", { anthropicApiKey: "test-key" });
    assert.equal(wrong.status, 415);
  });
});
