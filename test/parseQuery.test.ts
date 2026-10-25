import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO_REQUEST } from "../src/shared/demoRequest.ts";
import { parseQuery } from "../src/shared/parseQuery.ts";
import { parseQuantity, quantitiesMatch } from "../src/shared/quantity.ts";

describe("parseQuery", () => {
  it("turns the prepared milk request into a brand, pack, and keywords", () => {
    const parsed = parseQuery(DEMO_REQUEST);
    assert.equal(parsed.brand, "Amul");
    assert.deepEqual(parsed.quantity, { amount: 1000, unit: "ml", raw: "1 litre" });
    assert.equal(parsed.keywords, "amul taaza milk");
  });

  it("drops request filler and keeps the product words", () => {
    const parsed = parseQuery("Please find the milk near my delivery location");
    assert.equal(parsed.keywords, "milk");
    assert.equal(parsed.quantity, null);
    assert.equal(parsed.brand, null);
  });

  it("recognises a longer brand before a shorter one", () => {
    assert.equal(parseQuery("Mother Dairy milk 500 ml").brand, "Mother Dairy");
  });
});

describe("parseQuantity", () => {
  it("normalises litre and litre packs to millilitres", () => {
    assert.equal(parseQuantity("1 litre")?.amount, 1000);
    assert.equal(parseQuantity("1 L")?.unit, "ml");
    assert.equal(parseQuantity("1 L")?.amount, 1000);
    assert.equal(parseQuantity("2 x 500 ml")?.amount, 1000);
    assert.equal(parseQuantity("500 ml x 2")?.amount, 1000);
  });

  it("does not treat 200 ml as 1 L", () => {
    const small = parseQuantity("200 ml");
    const litre = parseQuantity("1 L");
    assert.equal(quantitiesMatch(small, litre), false);
    assert.equal(quantitiesMatch(parseQuantity("1 litre"), parseQuantity("1000 ml")), true);
  });

  it("keeps weight units in grams", () => {
    assert.deepEqual(parseQuantity("1 kg"), { amount: 1000, unit: "g", raw: "1 kg" });
    assert.equal(quantitiesMatch(parseQuantity("1 kg"), parseQuantity("500 g")), false);
  });
});
