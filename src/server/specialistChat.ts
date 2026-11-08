import type { AgentId } from "../shared/hosts.ts";
import type { ChatEvent } from "../shared/chatEvents.ts";
import { BASKET_LIMIT, quoteLine, quoteOffers, storeName } from "../shared/cartQuote.ts";
import { BasketMemory, planBasket, readBasket, readBuy, type BasketItem } from "./basket.ts";
import type { CommerceEvent } from "../shared/commerce.ts";
import { withEmoji } from "../shared/emoji.ts";
import type { ChatTurn } from "./chatRun.ts";
import { askedUser, askPicks, askReply, blockText, contentBlocks, transcript } from "./toolLoop.ts";
import { isChatter, isLiveShopQuery, payResultLine, shopCompareView, shopSearchPlaces } from "./browser/shelf.ts";
import { postSarvam } from "./sarvamChat.ts";
import { scoutPurpose, talkDuty } from "./scoutPrompt.ts";
import { assistantPrompt, assistantTools, isAssistantTool, runAssistantTool, type AssistantToolName } from "./assistantTools.ts";
import { assistantContext, voicePrompt } from "./eventChat.ts";

const ROUND_LIMIT = 4;

export type SpecialistAgent = Exclude<AgentId, "event">;

type SpecialistTool = "compare_shops" | "compare_basket" | "order_basket" | "buy_from_shop" | "shop_catalog" | "food_order" | "salon_request";
type ToolName = SpecialistTool | AssistantToolName;

type ToolSpec = {
  name: SpecialistTool;
  description: string;
  input_schema: Readonly<Record<string, unknown>>;
};

const QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { query: { type: "string" } },
  required: ["query"],
} as const;

const TEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { text: { type: "string" } },
  required: ["text"],
} as const;

const SHOP_TOOLS: readonly ToolSpec[] = [
  {
    name: "compare_shops",
    description: "Open Blinkit, Zepto, and Instamart in the browser worker and compare prices for one item. Pass only the item words, such as chocolate ice cream. Use this when they ask you to find, check, or compare an item.",
    input_schema: QUERY_SCHEMA,
  },
  {
    name: "compare_basket",
    description: `Compare a basket of 2 to ${BASKET_LIMIT} different items on Blinkit, Zepto, and Instamart at once, and estimate each store's total for the whole basket in one cart, with its fees counted once. Use this, not compare_shops, whenever they name two or more items. Pass each item's words, such as Tata Salt 1 kg, and how many they want.`,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          minItems: 2,
          maxItems: BASKET_LIMIT,
          items: {
            type: "object",
            additionalProperties: false,
            properties: { query: { type: "string" }, quantity: { type: "integer", minimum: 1, maximum: 20 } },
            required: ["query", "quantity"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "order_basket",
    description: "Fill the basket from the last compare_basket in one store's app on their phone, all items in one run. store is best unless they named a store. They tap Allow on the phone; Scout stops before payment.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { store: { type: "string", enum: ["best", "blinkit", "zepto", "instamart"] } },
      required: ["store"],
    },
  },
  {
    name: "buy_from_shop",
    description: "Prepare a real cart on Blinkit, Zepto, or Instamart in Scout's browser: sign in with their phone and an SMS code if needed, set their delivery area, add the item, and read the bill. Returns when the cart waits for their approval or Scout needs them. A card on screen shows the code box, the cart, and the Approve button. Use this only when they ask to buy or order a specific item.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        store: { type: "string", enum: ["blinkit", "zepto", "instamart"] },
        item: { type: "string" },
        quantity: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["store", "item"],
    },
  },
  {
    name: "shop_catalog",
    description: "Run one simulated catalog command: add, remove, show the cart, or checkout. Pass their words, such as 'add 1 milk' or 'checkout'. Do not use this to compare live prices.",
    input_schema: TEXT_SCHEMA,
  },
];

const FOOD_TOOLS: readonly ToolSpec[] = [
  {
    name: "food_order",
    description: "Search the simulated menu, change the cart, or start checkout. Pass their words, such as 'find dosa' or 'add 1 dosa'. The menu has Masala Dosa, Idli, and Chef Thali.",
    input_schema: TEXT_SCHEMA,
  },
];

const SALON_TOOLS: readonly ToolSpec[] = [
  {
    name: "salon_request",
    description: "Search the simulated salon or request a booking. Pass their words. Services are haircut, beard trim, color, and blowdry. A booking needs a service, a time, and a name.",
    input_schema: TEXT_SCHEMA,
  },
];

export async function converseSpecialist(agent: SpecialistAgent, turn: ChatTurn, emit: (event: ChatEvent) => void): Promise<boolean> {
  if (turn.sarvamApiKey.trim().length === 0) return false;
  const memoryId = specialistMemoryId(turn.sessionId, agent);
  const previous = turn.memory.get(memoryId);
  const messages = transcript(previous.lines, turn.text);
  const spoken: string[] = [];
  let started = false;
  let toolSummary = "";
  const forced = agent === "shop" ? serverBasketCall(turn) : null;
  if (forced) {
    started = true;
    const ran = await runTool(turn, forced, emit);
    toolSummary = ran.ok ? shopSentence(ran.content) : ran.content;
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: forced.id, name: forced.name, input: forced.input }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: ran.id, is_error: !ran.ok, content: ran.content }] });
  }
  for (let round = 0; round < ROUND_LIMIT; round += 1) {
    if (turn.signal.aborted) return finish(turn, agent, spoken.join("\n\n"), emit, toolSummary);
    const body = await postSarvam({
      apiKey: turn.sarvamApiKey,
      fetchImpl: turn.fetchImpl,
      signal: turn.signal,
      system: `${instructions(agent)} ${assistantPrompt(assistantContext(turn))}${voicePrompt(turn)}`,
      tools: [...toolsFor(agent), ...assistantTools(assistantContext(turn))],
      messages,
      ...(turn.onSpeech ? { onText: turn.onSpeech } : {}),
    });
    if (body == null) {
      if (!started) return false;
      return finish(turn, agent, spoken.join("\n\n"), emit, toolSummary);
    }
    if (body.stop_reason === "refusal") return finish(turn, agent, "I can't help with that.", emit);
    const blocks = contentBlocks(body.content);
    const text = blockText(blocks);
    if (text.length > 0 && !spoken.includes(text)) spoken.push(text);
    const calls = blocks.filter((block) => isToolUse(agent, block));
    if (calls.length === 0) return finish(turn, agent, text.length > 0 ? text : spoken.join("\n\n"), emit, toolSummary);
    started = true;
    messages.push({ role: "assistant", content: blocks });
    const results = await Promise.all(
      calls.map((call) => {
        if (call.name === forced?.name) return Promise.resolve({ id: call.id, ok: true, content: "Scout already ran this for their message; the result is above. Reply from it." });
        if (call.name === "order_basket" && forced?.name === "compare_basket") return Promise.resolve({ id: call.id, ok: false, content: "They have not asked to buy yet. Tell them the best store and ask if they want it." });
        return runTool(turn, call, emit);
      }),
    );
    if (askedUser(calls, results)) return finish(turn, agent, askReply(text), emit);
    calls.forEach((call, index) => {
      const ran = results[index];
      if (call.name === "compare_shops" && ran?.ok) toolSummary = shopSentence(ran.content);
    });
    messages.push({
      role: "user",
      content: results.map((ran) => ({
        type: "tool_result",
        tool_use_id: ran.id,
        is_error: !ran.ok,
        content: ran.content,
      })),
    });
  }
  return finish(turn, agent, spoken.join("\n\n"), emit, toolSummary);
}

export async function fallbackSpecialist(agent: SpecialistAgent, turn: ChatTurn, emit: (event: ChatEvent) => void): Promise<void> {
  if (agent === "shop" && turn.compareShop && isLiveShopQuery(turn.text)) {
    const summary = await speakShop(turn, turn.text, emit);
    const spoken = shopSentence(summary);
    emit({ type: "question", message: withEmoji(spoken) });
    emit({ type: "done", count: 0 });
    return;
  }
  if (agent === "shop" && isChatter(turn.text)) {
    const earlier = turn.memory.get(specialistMemoryId(turn.sessionId, agent)).lines.filter((line) => line.role === "user").at(-1)?.text;
    const remembered = earlier && isLiveShopQuery(earlier) ? ` Last time you asked about ${earlier}.` : "";
    emit({ type: "question", message: withEmoji(`I'm Shop Scout. I compare one grocery on Blinkit, Zepto, and Instamart.${remembered} Name the item and I'll check.`) });
    emit({ type: "done", count: 0 });
    return;
  }
  const commerceAgent = agent === "shop" || agent === "food" || agent === "appointments" ? agent : null;
  if (commerceAgent && turn.commerce) {
    const events = turn.commerce.handle({ sessionId: turn.sessionId, agent: commerceAgent, action: "message", text: turn.text });
    for (const event of events) emit(commerceAsChat(event));
    return;
  }
  const line = agent === "main" || agent === "travel" || agent === "home" ? talkDuty(agent).offline : "That scout could not take the request.";
  emit({ type: "question", message: withEmoji(line) });
  emit({ type: "done", count: 0 });
}

function finish(turn: ChatTurn, agent: SpecialistAgent, reply: string, emit: (event: ChatEvent) => void, toolSummary = ""): boolean {
  const fallback = toolSummary.trim().length > 0 ? toolSummary.trim() : "I checked. What should I look at next?";
  const cleaned = askPicks(turn.sessionId, agent, cleanReply(reply), emit);
  const spoken = withEmoji(cleaned.length > 0 ? cleaned : fallback);
  emit({ type: "question", message: spoken });
  const memoryId = specialistMemoryId(turn.sessionId, agent);
  const previous = turn.memory.get(memoryId);
  const remembered = spoken.length > 0 ? spoken : "I checked.";
  const lines = [...previous.lines, { role: "user" as const, text: turn.text }, { role: "assistant" as const, text: remembered }].slice(-12);
  turn.memory.save(memoryId, { ...previous, lines });
  emit({ type: "done", count: 0 });
  return true;
}

async function runTool(
  turn: ChatTurn,
  call: { id: string; name: ToolName; input: unknown },
  emit: (event: ChatEvent) => void,
): Promise<{ id: string; ok: boolean; content: string }> {
  if (isAssistantTool(call.name)) {
    const ran = await runAssistantTool(assistantContext(turn), call.name, call.input, emit);
    return { id: call.id, ...ran };
  }
  const text = textInput(call.input);
  switch (call.name) {
    case "compare_shops":
      return { id: call.id, ok: true, content: await shopComparison(turn, text, emit) };
    case "compare_basket":
      return { id: call.id, ...(await basketComparison(turn, call.input, emit)) };
    case "order_basket":
      return { id: call.id, ...(await orderBasket(turn, call.input, emit)) };
    case "buy_from_shop":
      return { id: call.id, ...(await buyFromShop(turn, call.input, emit)) };
    case "shop_catalog":
      return catalog(turn, "shop", call.id, text, emit);
    case "food_order":
      return catalog(turn, "food", call.id, text, emit);
    case "salon_request":
      return catalog(turn, "appointments", call.id, text, emit);
    default: {
      const neverName: never = call.name;
      return { id: call.id, ok: false, content: neverName };
    }
  }
}

const comparing = new WeakMap<ChatTurn, { query: string; result: Promise<string> }>();

async function shopComparison(turn: ChatTurn, query: string, emit: (event: ChatEvent) => void): Promise<string> {
  const needle = query.trim();
  if (!isLiveShopQuery(needle)) return "That is not a grocery item. Answer them in words and do not search the shops.";
  if (needle.length < 2) return "Ask which item to compare before opening the shops.";
  if (!turn.compareShop) return "The browser worker is not enabled on this server.";
  const running = comparing.get(turn);
  if (running) {
    const first = await running.result;
    return `Only one shop comparison runs per message. Scout compared "${running.query}" instead of "${needle}". Use this result and offer to compare "${needle}" next.\n${first}`;
  }
  baskets.forget(turn.sessionId);
  const result = speakShop(turn, needle, emit);
  comparing.set(turn, { query: needle, result });
  return result;
}

async function speakShop(turn: ChatTurn, query: string, emit: (event: ChatEvent) => void): Promise<string> {
  emit({ type: "status", message: `Comparing ${query} on Blinkit, Zepto, and Instamart.` });
  const shop = await turn.compareShop?.(query, turn.signal, (message) => emit({ type: "status", message }));
  if (!shop) return "The browser worker is not enabled on this server.";
  if (shop.pay) {
    emit({ type: "status", message: payResultLine(shop.pay) });
    emit({ type: "pay", pay: shop.pay });
  }
  const quote = quoteOffers(shop.offers, turn.cartBills?.() ?? []);
  const estimate = quoteLine(quote);
  if (estimate) {
    emit({ type: "status", message: estimate });
    emit({ type: "estimate", estimate: { item: query, quote, lines: 1 } });
  }
  return JSON.stringify({
    summary: estimate ? `${shop.summary} ${estimate}` : shop.summary,
    signIn: shop.signIn,
    cheapest: shop.cheapest ? shopCompareView(shop.cheapest) : null,
    offers: modelOffers(shop.offers).map((offer) => shopCompareView(offer)),
    estimates: quote.estimates,
    best: quote.best,
    pay: shop.pay?.url ?? null,
  });
}

const baskets = new BasketMemory(Date.now);

/** The model sometimes answers a basket in words without searching, or says it ordered without ordering, so Scout runs these itself. */
function serverBasketCall(turn: ChatTurn): { id: string; name: "compare_basket" | "order_basket"; input: unknown } | null {
  const buy = baskets.get(turn.sessionId) ? readBuy(turn.text) : null;
  if (buy) return { id: "toolu_scout_order", name: "order_basket", input: { store: buy.store } };
  const items = turn.compareBasket ? readBasket(turn.text) : null;
  return items ? { id: "toolu_scout_basket", name: "compare_basket", input: { items } } : null;
}

function basketItems(input: unknown): BasketItem[] {
  const record = input && typeof input === "object" ? (input as { items?: unknown }) : {};
  if (!Array.isArray(record.items)) return [];
  const items: BasketItem[] = [];
  for (const raw of record.items.slice(0, BASKET_LIMIT)) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as { query?: unknown; quantity?: unknown };
    const query = typeof row.query === "string" ? row.query.trim().slice(0, 80) : "";
    const quantity = typeof row.quantity === "number" && Number.isInteger(row.quantity) ? Math.min(20, Math.max(1, row.quantity)) : 1;
    if (query.length < 2 || items.some((item) => item.query.toLowerCase() === query.toLowerCase())) continue;
    items.push({ query, quantity });
  }
  return items;
}

/** Main Scout's grocery errand: the same compare as Shop Scout, kept as the basket "buy it" fills. */
export async function shopErrand(turn: ChatTurn, items: readonly BasketItem[], emit: (event: ChatEvent) => void): Promise<string> {
  for (const item of items) emit({ type: "places", places: shopSearchPlaces(item.query) });
  const only = items.length === 1 ? items[0] : null;
  if (only) return shopSentence(await shopComparison({ ...turn, agent: "shop" }, only.query, emit));
  const ran = await basketComparison({ ...turn, agent: "shop" }, { items }, emit, 1);
  if (!ran.ok) return ran.content;
  const best = baskets.get(turn.sessionId)?.quote.best;
  return `${shopSentence(ran.content)}${best ? ` Say "buy it" and your phone fills the ${storeName(best)} cart.` : ""}`;
}

/** "buy it" after a compare, from any chat. Null when there is no basket or it is not a go-ahead. */
export async function orderPendingBasket(turn: ChatTurn, emit: (event: ChatEvent) => void): Promise<string | null> {
  if (!baskets.get(turn.sessionId)) return null;
  const buy = readBuy(turn.text);
  if (!buy) return null;
  const ran = await orderBasket({ ...turn, agent: "shop" }, { store: buy.store }, emit);
  return ran.content;
}

async function basketComparison(turn: ChatTurn, input: unknown, emit: (event: ChatEvent) => void, fewest = 2): Promise<{ ok: boolean; content: string }> {
  const items = basketItems(input);
  if (items.length < fewest) return { ok: false, content: "Pass two or more different items. For one item use compare_shops." };
  if (!turn.compareBasket) return { ok: false, content: "The browser worker is not enabled on this server." };
  const run = await turn.compareBasket(items.map((item) => item.query), turn.signal, (message) => emit({ type: "status", message }));
  if (run.opened === 0) return { ok: false, content: run.signIn ?? "The browser worker could not open Blinkit, Zepto, or Instamart." };
  const plan = planBasket(items, run, turn.cartBills?.() ?? []);
  baskets.save(turn.sessionId, plan);
  const estimate = quoteLine(plan.quote);
  if (estimate) {
    emit({ type: "status", message: estimate });
    emit({ type: "estimate", estimate: { item: plan.label, quote: plan.quote, lines: items.length } });
  }
  const stores = Object.fromEntries(
    Object.entries(plan.picks).map(([store, picks]) => [store, picks.map(({ query, offer, quantity }) => ({ item: query, quantity, title: offer.title, rupees: offer.rupees }))]),
  );
  return {
    ok: true,
    content: JSON.stringify({
      summary: estimate ?? "No store showed a price for these items.",
      estimates: plan.quote.estimates,
      best: plan.quote.best,
      stores,
      next: "To buy, call order_basket with store best, or the store they name. Do not call app_cart_add for a basket.",
    }),
  };
}

async function orderBasket(turn: ChatTurn, input: unknown, emit: (event: ChatEvent) => void): Promise<{ ok: boolean; content: string }> {
  const plan = baskets.get(turn.sessionId);
  if (!plan) return { ok: false, content: "There is no basket to order. Call compare_basket with their items first." };
  const asked = input && typeof input === "object" ? (input as { store?: unknown }).store : undefined;
  const store = asked === "blinkit" || asked === "zepto" || asked === "instamart" ? asked : plan.quote.best;
  const cart = store ? plan.carts[store] : undefined;
  if (!store || !cart || cart.items.length === 0) return { ok: false, content: `${store ? storeName(store) : "No store"} had none of these items. Offer another store.` };
  const estimate = plan.quote.estimates.find((row) => row.store === store);
  const sent = await runAssistantTool(assistantContext(turn), "app_cart_add", cart, emit);
  if (!sent.ok) return sent;
  baskets.forget(turn.sessionId);
  const missing = estimate && estimate.missing.length > 0 ? ` ${storeName(store)} does not have ${estimate.missing.join(", ")}, so those are left out.` : "";
  return { ok: true, content: `${sent.content} Estimated total about ₹${estimate?.total ?? "?"}; the phone takes about ${estimate?.phoneSeconds ?? "?"} s after Allow.${missing}` };
}

const OFFERS_PER_STORE = 3;

/** Sarvam spends its whole token budget reasoning over 40+ offers and returns no reply, so it sees the cheapest few per store. */
export function modelOffers<T extends { merchant: string; rupees: number }>(offers: readonly T[]): T[] {
  const kept: T[] = [];
  for (const merchant of new Set(offers.map((offer) => offer.merchant))) {
    const cheapest = offers.filter((offer) => offer.merchant === merchant).sort((left, right) => left.rupees - right.rupees);
    kept.push(...cheapest.slice(0, OFFERS_PER_STORE));
  }
  return kept;
}

const STORE_NAMES: Readonly<Record<string, string>> = { blinkit: "Blinkit", zepto: "Zepto", instamart: "Instamart" };

async function buyFromShop(turn: ChatTurn, input: unknown, emit: (event: ChatEvent) => void): Promise<{ ok: boolean; content: string }> {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const store = typeof record.store === "string" ? record.store.toLowerCase() : "";
  const item = typeof record.item === "string" ? record.item.trim() : "";
  const quantity = typeof record.quantity === "number" ? record.quantity : 1;
  const name = STORE_NAMES[store];
  if (!name) return { ok: false, content: "Scout can build a cart on Blinkit, Zepto, or Instamart." };
  if (item.length < 2) return { ok: false, content: "Ask which item to buy." };
  if (!turn.prepareCart) return { ok: false, content: "Live carts are not enabled on this server." };
  emit({ type: "status", message: `Preparing a ${name} cart for ${item}.` });
  const result = await turn.prepareCart(
    store,
    item,
    quantity,
    (taskId) => emit({ type: "task", taskId, skill: store, title: `${name}: ${item}` }),
    (message) => emit({ type: "status", message }),
  );
  if (!result.ok) return { ok: false, content: result.error };
  const last = result.task.events.at(-1);
  const approval = [...result.task.events].reverse().find((event) => event.approval)?.approval;
  return {
    ok: true,
    content: JSON.stringify({
      state: result.task.state,
      message: last?.message ?? "",
      cart: approval?.cart ?? null,
      next: nextStep(result.task.state),
    }),
  };
}

function nextStep(state: string): string {
  if (state === "approval_required") return "Tell them the total and that they approve it on the card. Scout presses pay only after they approve.";
  if (state === "waiting_verification") return "Tell them the store sent an SMS code. On Android Scout can read it with their consent, or they type it in the card.";
  if (state === "needs_user") return "Tell them what the store needs, in the message.";
  return "Tell them the message.";
}

function catalog(
  turn: ChatTurn,
  agent: "shop" | "food" | "appointments",
  id: string,
  text: string,
  emit: (event: ChatEvent) => void,
): { id: string; ok: boolean; content: string } {
  if (!turn.commerce) return { id, ok: false, content: "That catalog is not available on this server." };
  if (text.trim().length < 2) return { id, ok: false, content: "Say what to add, change, or book." };
  emit({ type: "status", message: catalogStatus(agent) });
  const events = turn.commerce.handle({ sessionId: turn.sessionId, agent, action: "message", text });
  const notes: string[] = [];
  for (const event of events) {
    if (event.type === "text" || event.type === "note" || event.type === "status") notes.push(event.message);
    else if (event.type !== "done") emit(event);
  }
  return { id, ok: true, content: notes.join("\n") || "The catalog did not return a result." };
}

function catalogStatus(agent: "shop" | "food" | "appointments"): string {
  switch (agent) {
    case "shop":
      return "Checking the simulated shop catalog.";
    case "food":
      return "Checking the simulated menu.";
    case "appointments":
      return "Checking the simulated salon.";
    default: {
      const neverAgent: never = agent;
      return neverAgent;
    }
  }
}

function toolsFor(agent: SpecialistAgent): readonly ToolSpec[] {
  switch (agent) {
    case "shop":
      return SHOP_TOOLS;
    case "food":
      return FOOD_TOOLS;
    case "appointments":
      return SALON_TOOLS;
    case "main":
    case "travel":
    case "home":
      return [];
    default: {
      const neverAgent: never = agent;
      return neverAgent;
    }
  }
}

function instructions(agent: SpecialistAgent): string {
  switch (agent) {
    case "shop":
      return [
        scoutPurpose("Shop Scout", "Compare groceries on Blinkit, Zepto, and Instamart, build the real cart, and hand payment to their UPI app."),
        "Your tools are compare_shops, compare_basket, order_basket, buy_from_shop, and shop_catalog. The browser worker is available. Never say you have no browser worker.",
        "If they have not named an item, answer them and wait. A greeting, who you are, or what you can do is not an item. Do not call a tool for it. Use the earlier messages in this chat.",
        "When they name two or more items in one message, call compare_basket once with all of them and their quantities, then tell them the best store, its estimated total, any missing item, and the phone time. When they then ask to order or buy the basket, call order_basket with store best, or the store they name; it fills every item in one phone run.",
        "When they name one item to find or compare, call compare_shops with the item words only. Tell them the summary the tool returns. Do not invent a price. Blinkit, Zepto, and Instamart are the shops compared.",
        "compare_shops also returns estimates: each store's total with its delivery and handling fees, for one unit, and phoneSeconds, how long the phone takes to fill that cart. best is the store with the lowest estimated total. A rough basis means the fees are Scout's starting guess, not yet learned from their own bills; say about.",
        "When they ask to buy or order, and app_cart_add is available, call app_cart_add once, for the best store's cheapest offer unless they name a store: its ref, the quantity, and a maxPrice at or above the price Scout saw. Only that one cart is filled. Tell them the estimated total and that the phone takes about phoneSeconds after they tap Allow. A null Instamart link is still that offer. Call buy_from_shop only when app_cart_add is not available, once, for the best store or the store they name.",
        "Never claim an order is placed. Scout stops at the cart for their approval, then hands payment to their UPI app.",
        "Use shop_catalog only when they ask for the simulated practice cart.",
        "A pay link from compare_shops is already on the screen. Tell them they can open it in their UPI app. Never ask for a UPI PIN.",
      ].join(" ");
    case "food":
      return [
        scoutPurpose("Food Scout", "Look up dishes and review a simulated food order."),
        "Your tool is food_order. The menu is simulated: Masala Dosa, Idli, and Chef Thali.",
        "If they have not named a dish or a cart action, ask what they want and wait.",
        "When they name a dish, add, remove, or check out, call food_order with their words. Say the order is simulated. Do not invent dishes or prices.",
      ].join(" ");
    case "appointments":
      return [
        scoutPurpose("Appointments Scout", "Request a simulated salon time."),
        "Your tool is salon_request. Services are haircut, beard trim, color, and blowdry. A booking needs a service, a time, and a name.",
        "If one of those is missing, ask for it and wait. When you have enough, call salon_request with one sentence that includes what they told you.",
        "Say the booking is simulated and stays pending until the salon answers. Do not invent a confirmation.",
      ].join(" ");
    case "travel":
      return [
        scoutPurpose("Travel Scout", "Talk through trips and cab rides."),
        "You have no fare tool. Ask where they are leaving from, where they are going, and when.",
        "Do not state a fare, an arrival time, or a booking. Say live cab fares are not connected yet.",
      ].join(" ");
    case "home":
      return [
        scoutPurpose("Home Scout", "Talk through household tasks."),
        "You have no booking tool. Ask what they need done around the house and help them plan the next step.",
        "Do not claim a booking, a purchase, or a visit. Say no home service is connected yet.",
      ].join(" ");
    case "main":
      return [
        scoutPurpose("Scout", "You are the chief. You assign Event, Shop, Food, Travel, Home, and Appointments, and their results come back in this chat."),
        "Groceries, events, WhatsApp messages, and bus trips are handed off before you speak. What reaches you is the rest: quick phone tasks (alarm, timer, reminder, open an app or maps), preferences, and event watches, which your tools run, or chat. If they have not given you a task, ask what they need and say you will assign the right scout.",
        "Do not tell them to open another website. Do not pretend you searched, compared a price, or booked anything.",
      ].join(" ");
    default: {
      const neverAgent: never = agent;
      return neverAgent;
    }
  }
}

function commerceAsChat(event: CommerceEvent): ChatEvent {
  switch (event.type) {
    case "text":
      return { type: "question", message: event.message };
    case "status":
    case "note":
    case "cart":
    case "quote":
    case "receipt":
    case "pay":
      return event;
    case "done":
      return { type: "done", count: 0 };
    default: {
      const neverEvent: never = event;
      return neverEvent;
    }
  }
}

const RAMBLE = /```\s*json|^\s*#{1,4}\s*user message|^\s*>?\s*user message\s*:|^\s*\**auto-reply\**\s*:|^\s*\**did i (?:get it|figure it out)/im;

/** Sarvam sometimes keeps writing past its answer: a fake JSON note, an "Auto-Reply", a quiz, or the next user turn. Only the answer is kept. */
export function cleanReply(reply: string): string {
  const text = reply.trim();
  const cut = RAMBLE.exec(text);
  return (cut ? text.slice(0, cut.index) : text).replace(/\n-{3,}\s*$/, "").trim();
}

function shopSentence(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { summary?: unknown };
    if (typeof parsed.summary === "string" && parsed.summary.trim().length > 0) return parsed.summary.trim();
  } catch {
    // The tool already returned a sentence.
  }
  const text = raw.trim();
  return text.length > 0 ? text : "I couldn't read a price on Blinkit, Zepto, or Instamart.";
}

function textInput(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as { query?: unknown; text?: unknown };
  if (typeof record.query === "string") return record.query;
  if (typeof record.text === "string") return record.text;
  return "";
}

function specialistMemoryId(sessionId: string, agent: SpecialistAgent): string {
  return `${sessionId}:${agent}`;
}

function isToolUse(agent: SpecialistAgent, block: Record<string, unknown>): block is Record<string, unknown> & { id: string; name: ToolName; input: unknown } {
  if (block.type !== "tool_use" || typeof block.id !== "string") return false;
  if (isAssistantTool(block.name)) return true;
  if (!isToolName(block.name)) return false;
  return toolsFor(agent).some((tool) => tool.name === block.name);
}

function isToolName(value: unknown): value is SpecialistTool {
  return value === "compare_shops" || value === "compare_basket" || value === "order_basket" || value === "buy_from_shop" || value === "shop_catalog" || value === "food_order" || value === "salon_request";
}

