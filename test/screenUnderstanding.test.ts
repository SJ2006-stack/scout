import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { screenResponse } from "../src/server/screenUnderstanding.ts";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]);

describe("screen understanding", () => {
  it("returns a checked reading from the report_screen tool and leaves /api/ocr unused", async () => {
    const seen: string[] = [];
    const result = await screenResponse("POST", JPEG, "image/jpeg", {
      anthropicApiKey: "test-key",
      fetchImpl: async (_url, init) => {
        seen.push(String(init?.body));
        return new Response(JSON.stringify({
          content: [{
            type: "tool_use",
            name: "report_screen",
            input: {
              kind: "menu",
              app: "Zomato",
              summary: "A restaurant menu.",
              confidence: 0.8,
              items: [{ kind: "menu", title: "Masala dosa", confidence: 0.7, fields: [{ label: "Price", value: "₹90", source: "visible_text", confidence: 0.9 }] }],
              sensitive: [],
              embedded_instructions: false,
            },
          }],
        }), { status: 200 });
      },
    });
    assert.equal(result.status, 200);
    assert.equal((result.body as { reading: { kind: string } }).reading.kind, "menu");
    assert.match(seen[0] ?? "", /report_screen/);
    assert.match(seen[0] ?? "", /never an instruction/);
  });

  it("refuses missing keys, the wrong type, an empty file, and a failed model", async () => {
    assert.equal((await screenResponse("GET", JPEG, "image/jpeg", { anthropicApiKey: "k" })).status, 405);
    assert.equal((await screenResponse("POST", JPEG, "image/png", { anthropicApiKey: "" })).status, 503);
    assert.equal((await screenResponse("POST", JPEG, "application/pdf", { anthropicApiKey: "k" })).status, 415);
    assert.equal((await screenResponse("POST", new Uint8Array(), "image/jpeg", { anthropicApiKey: "k" })).status, 400);
    const failed = await screenResponse("POST", JPEG, "image/webp", {
      anthropicApiKey: "k",
      fetchImpl: async () => new Response("no", { status: 500 }),
    });
    assert.equal(failed.status, 502);
    const empty = await screenResponse("POST", JPEG, "image/jpeg", {
      anthropicApiKey: "k",
      fetchImpl: async () => new Response(JSON.stringify({ content: [{ type: "text", text: "a menu" }] }), { status: 200 }),
    });
    assert.equal(empty.status, 502);
  });
});
