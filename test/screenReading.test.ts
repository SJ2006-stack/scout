import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compactReading,
  kindLabel,
  maskSensitive,
  readScreenReading,
  screenAgent,
  screenSuggestions,
  sourceLabel,
  type ScreenReading,
} from "../src/shared/screenReading.ts";

const BASE: ScreenReading = {
  kind: "product",
  app: "Blinkit",
  summary: "A grocery product page.",
  confidence: 0.9,
  items: [{ kind: "product", title: "Amul Taaza", confidence: 0.8, fields: [{ label: "Price", value: "₹54", source: "visible_text", confidence: 0.9 }] }],
  sensitive: [],
  embeddedInstructions: false,
};

describe("screen reading", () => {
  it("masks card numbers and labelled codes, and keeps a usable reading", () => {
    assert.equal(maskSensitive("card 4111 1111 1111 1111"), "card ••••1111");
    assert.equal(maskSensitive("OTP 482913"), "OTP ••••");
    assert.equal(maskSensitive("password hunter2"), "password ••••");
    const reading = readScreenReading({
      kind: "product",
      app: " Blinkit ",
      summary: " Milk on offer ",
      confidence: 1.4,
      items: [{ kind: "product", title: "Amul Taaza", confidence: 0.5, fields: [{ label: "Price", value: "₹54", source: "visible_text", confidence: 0.7 }] }],
      sensitive: ["payment_card", "payment_card", "nope"],
      embedded_instructions: true,
    });
    assert.equal(reading?.app, "Blinkit");
    assert.equal(reading?.confidence, 1);
    assert.equal(reading?.embeddedInstructions, true);
    assert.deepEqual(reading?.sensitive, ["payment_card"]);
    assert.equal(screenAgent("product"), "shop");
    assert.equal(screenAgent("menu"), "food");
    assert.equal(screenAgent("travel"), "travel");
    assert.equal(screenAgent("event"), "main");
    assert.equal(kindLabel("app_screen"), "App screen");
    assert.equal(sourceLabel("inferred"), "Scout's guess");
    assert.ok(screenSuggestions(BASE).every((idea) => idea.label.includes("?") || idea.label.startsWith("Compare") || idea.label.startsWith("What") || idea.label.startsWith("Which") || idea.label.startsWith("Summarise")));
  });

  it("drops malformed readings and shrinks a bulky one for chat", () => {
    assert.equal(readScreenReading({ kind: "product" }), null);
    assert.equal(readScreenReading({ summary: "x" }), null);
    const bulky: ScreenReading = {
      ...BASE,
      items: Array.from({ length: 12 }, (_, index) => ({
        kind: "product",
        title: `Item ${index} ${"x".repeat(80)}`,
        confidence: 0.5,
        fields: Array.from({ length: 16 }, (__, field) => ({
          label: `L${field}`,
          value: "v".repeat(80),
          source: "visible_text" as const,
          confidence: 0.4,
        })),
      })),
    };
    const compact = compactReading(bulky, 2_000);
    assert.ok(JSON.stringify(compact).length <= 2_000);
    assert.ok(compact.items.length < bulky.items.length || compact.items[0]!.fields.length < 16);
  });
});
