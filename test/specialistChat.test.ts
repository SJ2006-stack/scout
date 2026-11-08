import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatEvent } from "../src/shared/chatEvents.ts";
import type { ShopOffer } from "../src/server/browser/shelf.ts";
import { ChatMemoryStore } from "../src/server/chatMemory.ts";
import { createCommerceHub } from "../src/server/commerce/hub.ts";
import { ListingCache } from "../src/server/listingCache.ts";
import { runChat, type ChatTurn } from "../src/server/chatRun.ts";
import { modelOffers } from "../src/server/specialistChat.ts";
import { sarvamReply } from "./sarvamReply.ts";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");

describe("specialist chat", () => {
  it("asks Shop Scout to compare an item in the browser", async () => {
    let compared = "";
    const events = await speak({
      agent: "shop",
      text: "Look for chocolate ice cream",
      fetchImpl: sarvam(
        {
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "toolu_shop", name: "compare_shops", input: { query: "chocolate ice cream" } }],
        },
        {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Blinkit is cheapest for chocolate ice cream." }],
        },
      ),
      compareShop: async (query, _signal, onStatus) => {
        compared = query;
        onStatus("Opening Blinkit.");
        return {
          offers: [{ merchant: "Blinkit", title: "Chocolate ice cream", rupees: 99, pageUrl: "https://blinkit.com/s/?q=chocolate%20ice%20cream" }],
          cheapest: { merchant: "Blinkit", title: "Chocolate ice cream", rupees: 99, pageUrl: "https://blinkit.com/s/?q=chocolate%20ice%20cream" },
          pay: null,
          summary: "Blinkit is cheapest: Chocolate ice cream at ₹99.",
          signIn: null,
        };
      },
    });
    assert.equal(compared, "chocolate ice cream");
    assert.equal(events.some((event) => event.type === "status" && event.message === "Opening Blinkit."), true);
    const reply = events.find((event) => event.type === "question");
    assert.equal(reply?.type === "question" && reply.message.includes("chocolate ice cream"), true);
  });

  it("sends Sarvam the cheapest three offers per store and says the summary when its reply is empty", async () => {
    const offers = Array.from({ length: 40 }, (_, index) => ({
      merchant: (["Blinkit", "Zepto", "Instamart"] as const)[index % 3],
      title: `Milk ${index}`,
      rupees: 30 + index,
      pageUrl: "https://blinkit.com/s/?q=milk",
    }));
    const events = await speak({
      agent: "shop",
      text: "Find milk",
      fetchImpl: sarvam(
        { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_milk", name: "compare_shops", input: { query: "milk" } }] },
        { stop_reason: "end_turn", content: [] },
      ),
      compareShop: async () => ({ offers, cheapest: offers[0] ?? null, pay: null, summary: "Blinkit is cheapest: Milk 0 at ₹30.", signIn: null }),
    });
    const reply = events.find((event) => event.type === "question");
    assert.equal(reply?.type === "question" && reply.message.includes("Blinkit is cheapest: Milk 0 at ₹30."), true);
    const kept = modelOffers(offers);
    assert.equal(kept.length, 9);
    assert.deepEqual(kept.filter((offer) => offer.merchant === "Zepto").map((offer) => offer.rupees), [31, 34, 37]);
  });

  it("estimates each store's total with fees right after the compare, so the cheapest shelf price can lose", async () => {
    const offers: ShopOffer[] = [
      { merchant: "Blinkit", title: "Milk", rupees: 30, pageUrl: "https://blinkit.com/s/?q=milk" },
      { merchant: "Zepto", title: "Milk", rupees: 31, pageUrl: "https://www.zepto.com/search?query=milk" },
      { merchant: "Instamart", title: "Milk", rupees: 32, pageUrl: "https://www.swiggy.com/instamart/search?query=milk" },
    ];
    let toolResult = "";
    const replies = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_milk", name: "compare_shops", input: { query: "milk" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Zepto should be cheapest with fees." }] },
    ];
    let index = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages?: { role?: string; content?: unknown }[] };
      const tool = body.messages?.find((message) => message.role === "tool");
      if (tool && typeof tool.content === "string") toolResult = tool.content;
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return Response.json(sarvamReply(reply));
    };
    const events = await speak({
      agent: "shop",
      text: "Find milk",
      fetchImpl,
      compareShop: async () => ({ offers, cheapest: offers[0] ?? null, pay: null, summary: "Blinkit is cheapest: Milk at ₹30.", signIn: null }),
      cartBills: () => [{ store: "zepto", itemsTotal: 31, handling: 0, delivery: 30, otherFees: 0, grandTotal: 61, elapsedMs: 11_000, lines: 1, at: NOW - 1000 }],
    });
    const estimate = events.find((event) => event.type === "estimate");
    assert.equal(estimate?.type, "estimate");
    if (estimate?.type !== "estimate") return;
    assert.equal(estimate.estimate.item, "milk");
    assert.equal(estimate.estimate.quote.best, "zepto");
    assert.deepEqual(estimate.estimate.quote.estimates.map((row) => [row.store, row.total, row.basis, row.phoneSeconds]), [
      ["zepto", 61, "learned", 11],
      ["blinkit", 71, "rough", 17],
      ["instamart", 79.7, "rough", 17],
    ]);
    assert.equal(events.some((event) => event.type === "status" && event.message.startsWith("Zepto should come to about ₹61")), true);
    const sent = JSON.parse(toolResult) as { best?: unknown; estimates?: unknown[] };
    assert.equal(sent.best, "zepto");
    assert.equal(sent.estimates?.length, 3);
  });

  it("compares a basket at once and sends the whole best-store basket to the phone in one run", async () => {
    const ref = (store: "blinkit" | "zepto", name: string, size: string, price: number) => ({ store, productId: null, link: null, name, size, price, seenAt: NOW });
    const offer = (merchant: "Blinkit" | "Zepto", name: string, size: string, price: number): ShopOffer => ({
      merchant, title: `${name} ${size}`, rupees: price, pageUrl: "https://example.invalid/", ref: ref(merchant === "Blinkit" ? "blinkit" : "zepto", name, size, price),
    });
    let asked: readonly string[] = [];
    const compareBasket: ChatTurn["compareBasket"] = async (queries) => {
      asked = queries;
      return {
        opened: 3,
        signIn: null,
        lines: [
          { query: "Tata Salt 1 kg", offers: [offer("Blinkit", "Tata Salt", "1 kg", 31), offer("Zepto", "Tata Salt", "1 kg", 29)] },
          { query: "Amul Butter 100 g", offers: [offer("Blinkit", "Amul Butter", "100 g", 60), offer("Zepto", "Amul Butter", "100 g", 58)] },
        ],
      };
    };
    const phone = { serviceOn: true, apps: { blinkit: { installed: true, version: null }, zepto: { installed: true, version: null } } };
    const first = await speak({
      agent: "shop",
      text: "2 Tata Salt 1 kg and Amul Butter 100 g",
      fetchImpl: sarvam(
        { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_basket", name: "compare_basket", input: { items: [{ query: "Tata Salt 1 kg", quantity: 2 }, { query: "Amul Butter 100 g", quantity: 1 }] } }] },
        { stop_reason: "end_turn", content: [{ type: "text", text: "Zepto is best." }] },
      ),
      compareBasket,
      phone,
    });
    assert.deepEqual(asked, ["Tata Salt 1 kg", "Amul Butter 100 g"]);
    const estimate = first.find((event) => event.type === "estimate");
    assert.equal(estimate?.type === "estimate" && estimate.estimate.lines, 2);
    assert.equal(estimate?.type === "estimate" && estimate.estimate.quote.best, "zepto");
    const second = await speak({
      agent: "shop",
      text: "order it",
      fetchImpl: sarvam(
        { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_order", name: "order_basket", input: { store: "best" } }] },
        { stop_reason: "end_turn", content: [{ type: "text", text: "Tap Allow on your phone." }] },
      ),
      phone,
    });
    const device = second.find((event) => event.type === "device");
    assert.equal(device?.type, "device");
    if (device?.type !== "device") return;
    assert.equal(device.action.name, "app_cart_add");
    const items = (device.action.args as { items: { ref: { store: string; name: string }; quantity: number }[] }).items;
    assert.deepEqual(items.map((item) => [item.ref.store, item.ref.name, item.quantity]), [["zepto", "Tata Salt", 2], ["zepto", "Amul Butter", 1]]);
  });

  it("searches and orders a basket even when the model only answers in words", async () => {
    const ref = { store: "zepto" as const, productId: "7", link: null, name: "Bread", size: null, price: 40, seenAt: NOW };
    let searches = 0;
    const compareBasket: ChatTurn["compareBasket"] = async (queries) => {
      searches += 1;
      return { opened: 3, signIn: null, lines: queries.map((query) => ({ query, offers: [{ merchant: "Zepto" as const, title: query, rupees: 40, pageUrl: "https://www.zepto.com/", ref: { ...ref, name: query } }] })) };
    };
    const phone = { serviceOn: true, apps: { zepto: { installed: true, version: null } } };
    const words = (text: string) => sarvam({ stop_reason: "end_turn", content: [{ type: "text", text }] });
    const eager = sarvam(
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_eager", name: "order_basket", input: { store: "best" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Zepto is best. Want it?" }] },
    );
    const first = await speak({ agent: "shop", text: "bread, 2 eggs", fetchImpl: eager, compareBasket, phone });
    assert.equal(searches, 1);
    assert.equal(first.some((event) => event.type === "estimate"), true);
    assert.equal(first.some((event) => event.type === "device"), false, "comparing never fills a cart before they say buy");
    const second = await speak({ agent: "shop", text: "Buy it", fetchImpl: words("Done, your cart is filled."), phone });
    const device = second.find((event) => event.type === "device");
    assert.equal(device?.type === "device" && device.action.name, "app_cart_add");
    const again = await speak({ agent: "shop", text: "Buy it", fetchImpl: words("Done."), phone });
    assert.equal(again.some((event) => event.type === "device"), false, "an ordered basket is not filled twice");
  });

  it("lets Food Scout use the menu tool and keeps the reply", async () => {
    const events = await speak({
      agent: "food",
      text: "Find dosa",
      commerce: createCommerceHub(() => NOW),
      fetchImpl: sarvam(
        {
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "toolu_food", name: "food_order", input: { text: "find dosa" } }],
        },
        {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Masala Dosa is on the simulated menu." }],
        },
      ),
    });
    assert.equal(events.some((event) => event.type === "status" && event.message === "Checking the simulated menu."), true);
    const reply = events.find((event) => event.type === "question");
    assert.equal(reply?.type === "question" && reply.message.includes("Masala Dosa"), true);
  });

  it("talks as Travel Scout without a fare tool", async () => {
    let tools: unknown = "missing";
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        tools?: { function?: { name?: string } }[];
        messages?: { role?: string; content?: unknown }[];
      };
      tools = (Array.isArray(body.tools) ? body.tools : []).map((tool) => tool.function?.name);
      const system = body.messages?.find((message) => message.role === "system");
      assert.match(typeof system?.content === "string" ? system.content : "", /no fare tool/);
      return Response.json(sarvamReply({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Where are you headed?" }],
      }));
    };
    const events = await speak({ agent: "travel", text: "I need a cab", fetchImpl });
    assert.deepEqual(tools, ["ask_user", "phone_action"]);
    const reply = events.find((event) => event.type === "question");
    assert.equal(reply?.type === "question" && reply.message.includes("Where are you headed?"), true);
  });

  it("has the chief answer when Sarvam is off", async () => {
    const events = await speak({ agent: "main", text: "hello", sarvamApiKey: "" });
    const reply = events.find((event) => event.type === "question");
    assert.equal(reply?.type === "question" && reply.message.includes("hand it to the right scout"), true);
  });
});

function sarvam(...replies: { stop_reason: string; content: unknown[] }[]): typeof fetch {
  let index = 0;
  return (async () => {
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return Response.json(sarvamReply(reply));
  }) as typeof fetch;
}

async function speak(options: {
  agent: ChatTurn["agent"];
  text: string;
  fetchImpl?: typeof fetch;
  sarvamApiKey?: string;
  commerce?: ChatTurn["commerce"];
  compareShop?: ChatTurn["compareShop"];
  cartBills?: ChatTurn["cartBills"];
  compareBasket?: ChatTurn["compareBasket"];
  phone?: ChatTurn["phone"];
}): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  const turn: ChatTurn = {
    sessionId: "a".repeat(32),
    text: options.text,
    timezone: "Asia/Kolkata",
    pincode: "",
    lat: null,
    lon: null,
    timeoutMs: 1000,
    signal: new AbortController().signal,
    now: () => NOW,
    memory: new ChatMemoryStore(),
    cache: new ListingCache(60_000, () => NOW),
    fetchImpl: options.fetchImpl ?? (async () => Response.json(sarvamReply({ stop_reason: "end_turn", content: [] }))),
    mapsApiKey: "",
    sarvamApiKey: options.sarvamApiKey ?? "test-key",
    agent: options.agent,
    commerce: options.commerce,
    compareShop: options.compareShop,
    ...(options.cartBills ? { cartBills: options.cartBills } : {}),
    ...(options.compareBasket ? { compareBasket: options.compareBasket } : {}),
    ...(options.phone ? { phone: options.phone } : {}),
  };
  await runChat(turn, (event) => events.push(event));
  return events;
}
