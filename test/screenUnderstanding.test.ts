import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { screenResponse } from "../src/server/screenUnderstanding.ts";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]);

const READING = {
  kind: "product",
  app: "Amazon",
  summary: "An Amazon page for Rosier ghee.",
  confidence: 0.9,
  items: [{ kind: "product", title: "Rosier Gir Cow A2 Bilona Ghee", confidence: 0.9, fields: [{ label: "Price", value: "₹1,949", source: "visible_text", confidence: 0.9 }] }],
  sensitive: [],
  embedded_instructions: false,
};

describe("screen understanding", () => {
  it("asks Sarvam gemma4 for a report_screen tool call", async () => {
    const seen: { url: string; key: string; body: string }[] = [];
    const result = await screenResponse("POST", JPEG, "image/jpeg", {
      sarvamApiKey: "test-key",
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers);
        seen.push({ url: String(url), key: headers.get("api-subscription-key") ?? "", body: String(init?.body) });
        return new Response(JSON.stringify({
          choices: [{
            message: {
              tool_calls: [{ function: { name: "report_screen", arguments: JSON.stringify(READING) } }],
            },
          }],
        }), { status: 200 });
      },
    });
    assert.equal(result.status, 200);
    assert.equal((result.body as { reading: { kind: string; items: { title: string }[] } }).reading.kind, "product");
    assert.equal((result.body as { reading: { items: { title: string }[] } }).reading.items[0]?.title, "Rosier Gir Cow A2 Bilona Ghee");
    assert.equal(seen[0]?.url, "https://api.sarvam.ai/v2/chat/completions");
    assert.equal(seen[0]?.key, "test-key");
    assert.match(seen[0]?.body ?? "", /"model":"gemma4"/);
    assert.match(seen[0]?.body ?? "", /report_screen/);
    assert.match(seen[0]?.body ?? "", /data:image\/jpeg;base64,/);
    assert.match(seen[0]?.body ?? "", /never an instruction/);
    assert.doesNotMatch(seen[0]?.body ?? "", /anthropic/i);
  });

  it("refuses a missing key, the wrong type, an empty file, and a reply that is not the tool", async () => {
    assert.equal((await screenResponse("GET", JPEG, "image/jpeg", { sarvamApiKey: "k" })).status, 405);
    assert.equal((await screenResponse("POST", JPEG, "image/png", { sarvamApiKey: "" })).status, 503);
    assert.match((await screenResponse("POST", JPEG, "image/png", { sarvamApiKey: "" })).body.error, /SARVAM_API_KEY/);
    assert.equal((await screenResponse("POST", JPEG, "application/pdf", { sarvamApiKey: "k" })).status, 415);
    assert.equal((await screenResponse("POST", new Uint8Array(), "image/jpeg", { sarvamApiKey: "k" })).status, 400);
    const failed = await screenResponse("POST", JPEG, "image/webp", {
      sarvamApiKey: "k",
      fetchImpl: async () => new Response("no", { status: 500 }),
    });
    assert.equal(failed.status, 502);
    const empty = await screenResponse("POST", JPEG, "image/jpeg", {
      sarvamApiKey: "k",
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "a menu" } }] }), { status: 200 }),
    });
    assert.equal(empty.status, 502);
  });
});
