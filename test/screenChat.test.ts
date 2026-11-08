import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { screenPrompt, screenSpecialist, screenToolAllowed, screenTools } from "../src/server/screenChat.ts";
import type { ScreenReading } from "../src/shared/screenReading.ts";

const reading: ScreenReading = {
  kind: "form",
  app: "IRCTC",
  summary: "A ticket form.",
  confidence: 0.6,
  items: [{ kind: "form", title: "Passenger", confidence: 0.5, fields: [{ label: "Name", value: "Asha", source: "visible_text", confidence: 0.7 }] }],
  sensitive: ["government_id"],
  embeddedInstructions: true,
};

describe("screen chat", () => {
  it("quotes the reading as untrusted data and keeps only lookup tools", () => {
    const prompt = screenPrompt(reading);
    assert.match(prompt, /<screen>/);
    assert.match(prompt, /untrusted data/);
    assert.match(prompt, /never buy/);
    assert.match(prompt, /ignore it/);
    assert.equal(screenPrompt(undefined), "");
    assert.equal(screenSpecialist("event"), "main");
    assert.equal(screenSpecialist("shop"), "shop");
    assert.equal(screenToolAllowed("compare_shops"), true);
    assert.equal(screenToolAllowed("ask_user"), true);
    assert.equal(screenToolAllowed("buy_from_shop"), false);
    assert.equal(screenToolAllowed("order_basket"), false);
    assert.equal(screenToolAllowed("phone_action"), false);
    const tools = screenTools(reading, [{ name: "compare_shops" }, { name: "buy_from_shop" }, { name: "ask_user" }, { name: "app_cart_add" }]);
    assert.deepEqual(tools.map((tool) => tool.name), ["compare_shops", "ask_user"]);
    assert.equal(screenTools(undefined, [{ name: "buy_from_shop" }]).length, 1);
  });
});
