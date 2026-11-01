import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatEvent } from "../src/shared/chatEvents.ts";
import { ChatMemoryStore } from "../src/server/chatMemory.ts";
import { createCommerceHub } from "../src/server/commerce/hub.ts";
import { ListingCache } from "../src/server/listingCache.ts";
import { runChat, type ChatTurn } from "../src/server/chatRun.ts";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");

describe("specialist chat", () => {
  it("asks Shop Scout to compare an item in the browser", async () => {
    let compared = "";
    const events = await speak({
      agent: "shop",
      text: "Look for chocolate ice cream",
      fetchImpl: haiku(
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

  it("lets Food Scout use the menu tool and keeps the reply", async () => {
    const events = await speak({
      agent: "food",
      text: "Find dosa",
      commerce: createCommerceHub(() => NOW),
      fetchImpl: haiku(
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
      const body = JSON.parse(String(init?.body)) as { tools?: unknown; system?: string };
      tools = (Array.isArray(body.tools) ? body.tools : []).map((tool: { name?: string }) => tool.name);
      assert.match(String(body.system), /no fare tool/);
      return Response.json({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Where are you headed?" }],
      });
    };
    const events = await speak({ agent: "travel", text: "I need a cab", fetchImpl });
    assert.deepEqual(tools, ["phone_action"]);
    const reply = events.find((event) => event.type === "question");
    assert.equal(reply?.type === "question" && reply.message.includes("Where are you headed?"), true);
  });

  it("points Main Scout at a specialist when Haiku is off", async () => {
    const events = await speak({ agent: "main", text: "hello", anthropicApiKey: "" });
    const reply = events.find((event) => event.type === "question");
    assert.equal(reply?.type === "question" && reply.message.includes("Event Scout"), true);
  });
});

function haiku(...replies: { stop_reason: string; content: unknown[] }[]): typeof fetch {
  let index = 0;
  return (async () => {
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return Response.json(reply);
  }) as typeof fetch;
}

async function speak(options: {
  agent: ChatTurn["agent"];
  text: string;
  fetchImpl?: typeof fetch;
  anthropicApiKey?: string;
  commerce?: ChatTurn["commerce"];
  compareShop?: ChatTurn["compareShop"];
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
    fetchImpl: options.fetchImpl ?? (async () => Response.json({ stop_reason: "end_turn", content: [] })),
    mapsApiKey: "",
    anthropicApiKey: options.anthropicApiKey ?? "test-key",
    agent: options.agent,
    commerce: options.commerce,
    compareShop: options.compareShop,
  };
  await runChat(turn, (event) => events.push(event));
  return events;
}
