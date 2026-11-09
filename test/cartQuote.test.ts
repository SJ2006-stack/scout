import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import {
  STARTING_FEES,
  cheaperElsewhere,
  estimateTotal,
  learnFees,
  phoneMs,
  quoteBasket,
  quoteOffers,
  readCartEstimate,
  type StoreBill,
} from "../src/shared/cartQuote.ts";
import { pickOffer, planBasket, readBasket, readBuy } from "../src/server/basket.ts";
import { CartBillStore } from "../src/server/cartBills.ts";
import { routeAssistant } from "../src/server/assistantRoutes.ts";

const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const USER = "u".repeat(24);

function bill(store: StoreBill["store"], itemsTotal: number, delivery: number, handling: number, elapsedMs: number | null = null): StoreBill {
  return { store, itemsTotal, handling, delivery, otherFees: 0, grandTotal: itemsTotal + delivery + handling, elapsedMs, lines: 1, at: NOW };
}

describe("cart quote", () => {
  it("starts from the measured fees and charges delivery below the free level", () => {
    assert.deepEqual(estimateTotal(STARTING_FEES.blinkit, 29), { fees: 41, total: 70 });
    assert.deepEqual(estimateTotal(STARTING_FEES.blinkit, 200), { fees: 6, total: 206 });
    assert.deepEqual(estimateTotal(STARTING_FEES.instamart, 500), { fees: 47.7, total: 547.7 });
  });

  it("learns fees and the free-delivery level from a user's bills", () => {
    const rule = learnFees("instamart", [bill("instamart", 29, 30, 10), bill("instamart", 60, 30, 14), bill("instamart", 250, 0, 12)]);
    assert.equal(rule.delivery, 30);
    assert.equal(rule.handling, 12);
    assert.equal(rule.freeDeliveryFrom, 250);
    assert.equal(rule.bills, 3);
    const paidHigh = learnFees("blinkit", [bill("blinkit", 180, 25, 6)]);
    assert.equal(paidHigh.freeDeliveryFrom, null, "a paid bill above the starting free level overrules it");
    assert.equal(learnFees("zepto", [{ ...bill("zepto", 40, 30, 0), itemsTotal: null }]).bills, 0, "footer-only bills teach nothing");
  });

  it("uses the median of the last runs for the phone time", () => {
    assert.equal(phoneMs("instamart", []), 17_000);
    const runs = [9_000, 30_000, 10_000, 11_000, 12_000, 13_000].map((ms) => bill("instamart", 29, 30, 12, ms));
    assert.equal(phoneMs("instamart", runs), 12_000);
  });

  it("picks the store with the lowest total, not the lowest shelf price", () => {
    const quote = quoteOffers([
      { merchant: "Blinkit", rupees: 30 },
      { merchant: "Blinkit", rupees: 28 },
      { merchant: "Zepto", rupees: 31 },
      { merchant: "Instamart", rupees: 32 },
      { merchant: "Amazon", rupees: 1 },
    ], []);
    assert.equal(quote.best, "zepto");
    assert.deepEqual(quote.estimates.map((row) => [row.store, row.itemsTotal, row.total]), [["zepto", 31, 61], ["blinkit", 28, 69], ["instamart", 32, 79.7]]);
    assert.equal(cheaperElsewhere(quote, "zepto", 66)?.store, undefined);
    assert.equal(cheaperElsewhere(quote, "zepto", 75)?.store, "blinkit");
    assert.equal(cheaperElsewhere(quote, "zepto", null), null);
  });

  it("reads an estimate back from saved chats and drops bad rows", () => {
    const read = readCartEstimate({
      item: "milk",
      quote: {
        best: "zepto",
        estimates: [
          { store: "zepto", itemsTotal: 31, fees: 30, total: 61, basis: "rough", phoneSeconds: 9_999 },
          { store: "amazon", itemsTotal: 1, fees: 0, total: 1, basis: "rough", phoneSeconds: 1 },
          { store: "blinkit", itemsTotal: -4, fees: 0, total: 1, basis: "rough", phoneSeconds: 1 },
        ],
      },
    });
    assert.deepEqual(read, { item: "milk", lines: 1, quote: { best: "zepto", estimates: [{ store: "zepto", itemsTotal: 31, fees: 30, total: 61, basis: "rough", phoneSeconds: 300, units: 1, missing: [] }] } });
    assert.equal(readCartEstimate({ item: "milk", quote: { estimates: [] } }), null);
  });
});

describe("basket quote", () => {
  const lines = [
    { query: "Tata Salt 1 kg", quantity: 2, prices: { blinkit: 31, zepto: 29, instamart: 29 } },
    { query: "Amul Butter 100 g", quantity: 1, prices: { blinkit: 60, zepto: 58, instamart: 57 } },
    { query: "Maggi", quantity: 1, prices: { blinkit: 15, zepto: 14 } },
  ];

  it("counts fees once per cart, so a basket can cross the free-delivery level", () => {
    const quote = quoteBasket(lines, []);
    assert.deepEqual(quote.estimates.map((row) => [row.store, row.itemsTotal, row.fees, row.total, row.units, row.missing]), [
      ["zepto", 130, 30, 160, 4, []],
      ["blinkit", 137, 41, 178, 4, []],
      ["instamart", 115, 47.7, 162.7, 3, ["Maggi"]],
    ]);
    assert.equal(quote.best, "zepto");
    assert.equal(quote.estimates[0]?.phoneSeconds, 24, "12 s for the first item and about 6 s for each extra one");
    const bigger = quoteBasket([...lines, { query: "Atta 1 kg", quantity: 1, prices: { blinkit: 60, zepto: 62 } }], []);
    assert.deepEqual(bigger.estimates.slice(0, 2).map((row) => [row.store, row.itemsTotal, row.fees, row.total]), [["zepto", 192, 0, 192], ["blinkit", 197, 6, 203]]);
  });

  it("does not suggest a store that lacks an item as cheaper", () => {
    const quote = quoteBasket(lines, []);
    assert.equal(cheaperElsewhere(quote, "zepto", 170)?.store, undefined);
    assert.equal(cheaperElsewhere(quote, "blinkit", 178)?.store, "zepto");
  });

  it("scales a basket run's time back to one item for later estimates", () => {
    const run = { ...bill("zepto", 130, 0, 0, 30_000), lines: 4 };
    assert.equal(phoneMs("zepto", [run]), 12_000);
  });

  it("picks each store's cheapest offer in the size they named and builds the phone cart", () => {
    const ref = (store: "blinkit" | "zepto", name: string, size: string, price: number) => ({ store, productId: null, link: null, name, size, price, seenAt: NOW });
    const offers = [
      { merchant: "Zepto" as const, title: "Tata Salt 500 g", rupees: 15, pageUrl: "https://www.zepto.com/", ref: ref("zepto", "Tata Salt", "500 g", 15) },
      { merchant: "Zepto" as const, title: "Tata Salt 1 kg", rupees: 29, pageUrl: "https://www.zepto.com/", ref: ref("zepto", "Tata Salt", "1 kg", 29) },
      { merchant: "Blinkit" as const, title: "Tata Salt 1 kg", rupees: 31, pageUrl: "https://blinkit.com/", ref: ref("blinkit", "Tata Salt", "1 kg", 31) },
    ];
    assert.equal(pickOffer(offers, "Tata Salt 1 kg", "zepto")?.rupees, 29);
    assert.equal(pickOffer(offers, "Tata Salt", "zepto")?.rupees, 15);
    const plan = planBasket(
      [{ query: "Tata Salt 1 kg", quantity: 2 }, { query: "Maggi", quantity: 1 }],
      { lines: [{ query: "Tata Salt 1 kg", offers }, { query: "Maggi", offers: [] }], opened: 3, signIn: null },
      [],
    );
    assert.equal(plan.label, "2 × Tata Salt 1 kg, Maggi");
    assert.deepEqual(plan.carts.zepto, { items: [{ ref: ref("zepto", "Tata Salt", "1 kg", 29), quantity: 2, maxPrice: 32 }], allowSimilar: false });
    assert.deepEqual(plan.quote.estimates.map((row) => [row.store, row.missing]), [["zepto", ["Maggi"]], ["blinkit", ["Maggi"]]]);
  });
});

describe("basket messages", () => {
  it("reads several groceries and their counts from one message", () => {
    assert.deepEqual(readBasket("Tata Salt 1 kg, Amul butter 100 g, 2 Maggi, bread"), [
      { query: "Tata Salt 1 kg", quantity: 1 },
      { query: "Amul butter 100 g", quantity: 1 },
      { query: "Maggi", quantity: 2 },
      { query: "bread", quantity: 1 },
    ]);
    assert.deepEqual(readBasket("find milk and eggs x 2"), [{ query: "milk", quantity: 1 }, { query: "eggs", quantity: 2 }]);
    assert.deepEqual(readBasket("2 kg atta, sugar"), [{ query: "2 kg atta", quantity: 1 }, { query: "sugar", quantity: 1 }]);
  });

  it("leaves one item, chatter, questions, and store talk to the model", () => {
    assert.equal(readBasket("Amul butter 100 g"), null);
    assert.equal(readBasket("hi, how are you"), null);
    assert.equal(readBasket("ok, buy it"), null);
    assert.equal(readBasket("is milk or bread cheaper, and why?"), null);
    assert.equal(readBasket("Zepto and Blinkit"), null);
    assert.equal(readBasket("a, b, c, d, e, f, g"), null);
  });

  it("reads a go-ahead and an optional store", () => {
    assert.deepEqual(readBuy("Buy it"), { store: "best" });
    assert.deepEqual(readBuy("yes"), { store: "best" });
    assert.deepEqual(readBuy("ok order them on Zepto"), { store: "zepto" });
    assert.deepEqual(readBuy("Order from zepto then"), { store: "zepto" });
    assert.deepEqual(readBuy("get it from Blinkit now"), { store: "blinkit" });
    assert.deepEqual(readBuy("instamart"), { store: "instamart" });
    assert.equal(readBuy("buy milk"), null);
    assert.equal(readBuy("order milk from zepto"), null);
    assert.equal(readBuy("which one is cheaper"), null);
  });
});

describe("cart bill store", () => {
  it("keeps the latest 20 bills per store for each user", () => {
    const store = new CartBillStore(":memory:");
    for (let index = 0; index < 25; index += 1) store.add(USER, { ...bill("zepto", 100 + index, 0, 0, 12_000), at: NOW + index });
    store.add("v".repeat(24), bill("zepto", 50, 30, 0));
    const kept = store.recent(USER);
    assert.equal(kept.length, 20);
    assert.equal(kept[0]?.itemsTotal, 105);
    assert.equal(kept.at(-1)?.itemsTotal, 124);
  });
});

describe("phone result route", () => {
  let server: Server;
  let base = "";
  const bills = new CartBillStore(":memory:");

  before(async () => {
    server = createServer((request, response) => {
      void routeAssistant(request, response, new URL(request.url ?? "/", "http://local"), USER, { cartBills: bills, now: () => NOW });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
  });

  after(() => server.close());

  async function post(status: string, data: unknown): Promise<number> {
    const response = await fetch(`${base}/api/actions/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "a".repeat(24), status, message: "", data }),
    });
    return response.status;
  }

  it("records a finished cart bill with its phone time and skips runs that stopped", async () => {
    const cart = {
      store: "instamart",
      added: [{ name: "Tata Salt", size: "1 kg", quantity: 1, unitPrice: 29, lineTotal: 29 }],
      cart: { itemsTotal: 29, handling: 12, delivery: 35.7, otherFees: 0.3, grandTotal: 77 },
      stoppedAt: null,
      reason: null,
      seen: null,
      elapsedMs: 14_200,
    };
    assert.equal(await post("completed", cart), 200);
    assert.equal(await post("needs_approval", { ...cart, reason: "price_above_limit" }), 200);
    assert.equal(await post("completed", { ...cart, added: [] }), 200);
    assert.deepEqual(bills.recent(USER), [
      { store: "instamart", itemsTotal: 29, handling: 12, delivery: 35.7, otherFees: 0.3, grandTotal: 77, elapsedMs: 14_200, lines: 1, at: NOW },
    ]);
  });
});
