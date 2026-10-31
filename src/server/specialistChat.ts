import type { AgentId } from "../shared/hosts.ts";
import type { ChatEvent } from "../shared/chatEvents.ts";
import type { CommerceEvent } from "../shared/commerce.ts";
import { withEmoji } from "../shared/emoji.ts";
import type { ChatLine } from "./chatMemory.ts";
import type { ChatTurn } from "./chatRun.ts";
import { isLiveShopQuery, payResultLine } from "./browser/shelf.ts";
import { postHaiku, type HaikuMessage } from "./haikuClient.ts";
import { scoutPurpose, talkDuty } from "./scoutPrompt.ts";
import { assistantPrompt, assistantTools, isAssistantTool, runAssistantTool, type AssistantToolName } from "./assistantTools.ts";
import { assistantContext, voicePrompt } from "./haikuChat.ts";

const ROUND_LIMIT = 4;

export type SpecialistAgent = Exclude<AgentId, "event">;

type SpecialistTool = "compare_shops" | "shop_catalog" | "food_order" | "salon_request";
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
  if (turn.anthropicApiKey.trim().length === 0) return false;
  const memoryId = specialistMemoryId(turn.sessionId, agent);
  const previous = turn.memory.get(memoryId);
  const messages = transcript(previous.lines, turn.text);
  const spoken: string[] = [];
  let started = false;
  for (let round = 0; round < ROUND_LIMIT; round += 1) {
    if (turn.signal.aborted) return finish(turn, agent, spoken.join("\n\n"), emit);
    const body = await postHaiku({
      apiKey: turn.anthropicApiKey,
      fetchImpl: turn.fetchImpl,
      signal: turn.signal,
      system: `${instructions(agent)} ${assistantPrompt(assistantContext(turn))}${voicePrompt(turn)}`,
      tools: [...toolsFor(agent), ...assistantTools(assistantContext(turn))],
      messages,
      ...(turn.onSpeech ? { onText: turn.onSpeech } : {}),
    });
    if (body == null) {
      if (!started) return false;
      return finish(turn, agent, spoken.join("\n\n"), emit);
    }
    if (body.stop_reason === "refusal") return finish(turn, agent, "I can't help with that.", emit);
    const blocks = Array.isArray(body.content) ? body.content.filter(isBlock) : [];
    const text = blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => String(block.text).trim()).filter((line) => line.length > 0).join("\n");
    if (text.length > 0 && !spoken.includes(text)) spoken.push(text);
    const calls = blocks.filter((block) => isToolUse(agent, block));
    if (calls.length === 0) return finish(turn, agent, text.length > 0 ? text : spoken.join("\n\n"), emit);
    started = true;
    messages.push({ role: "assistant", content: blocks });
    const results = await Promise.all(calls.map((call) => runTool(turn, call, emit)));
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
  return finish(turn, agent, spoken.join("\n\n"), emit);
}

export async function fallbackSpecialist(agent: SpecialistAgent, turn: ChatTurn, emit: (event: ChatEvent) => void): Promise<void> {
  if (agent === "shop" && turn.compareShop && isLiveShopQuery(turn.text)) {
    await speakShop(turn, turn.text, emit);
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

function finish(turn: ChatTurn, agent: SpecialistAgent, reply: string, emit: (event: ChatEvent) => void): boolean {
  const spoken = reply.trim().length > 0 ? withEmoji(reply.trim()) : "";
  if (spoken.length > 0) emit({ type: "question", message: spoken });
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

async function shopComparison(turn: ChatTurn, query: string, emit: (event: ChatEvent) => void): Promise<string> {
  const needle = query.trim();
  if (needle.length < 2) return "Ask which item to compare before opening the shops.";
  if (!turn.compareShop) return "The browser worker is not enabled on this server.";
  return speakShop(turn, needle, emit);
}

async function speakShop(turn: ChatTurn, query: string, emit: (event: ChatEvent) => void): Promise<string> {
  emit({ type: "status", message: "Opening Blinkit, then Zepto, then Instamart." });
  const shop = await turn.compareShop?.(query, turn.signal, (message) => emit({ type: "status", message }));
  if (!shop) return "The browser worker is not enabled on this server.";
  if (shop.pay) {
    emit({ type: "status", message: payResultLine(shop.pay) });
    emit({ type: "pay", pay: shop.pay });
  }
  return JSON.stringify({
    summary: shop.summary,
    signIn: shop.signIn,
    cheapest: shop.cheapest ? { merchant: shop.cheapest.merchant, title: shop.cheapest.title, rupees: shop.cheapest.rupees } : null,
    offers: shop.offers.map((offer) => ({ merchant: offer.merchant, title: offer.title, rupees: offer.rupees })),
    pay: shop.pay?.url ?? null,
  });
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
        scoutPurpose("Shop Scout", "Compare groceries on Blinkit, Zepto, and Instamart, and keep a simulated cart."),
        "Your tools are compare_shops and shop_catalog. The browser worker is available. Never say you have no browser worker.",
        "If they have not named an item, ask what they want and wait. Do not call a tool for a greeting.",
        "When they name an item to find or compare, call compare_shops with the item words only. Tell them the summary the tool returns. Do not invent a price.",
        "When they add, remove, show the cart, or check out, call shop_catalog with their words. Say that cart is simulated.",
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
        scoutPurpose("Main Scout", "Point them to the specialist that fits the request."),
        "You have no search tool. Ask what they need, then name Event Scout, Travel Scout, Food Scout, Shop Scout, Home Scout, or Appointments Scout.",
        "Do not pretend you searched, compared a price, or booked anything.",
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

function textInput(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as { query?: unknown; text?: unknown };
  if (typeof record.query === "string") return record.query;
  if (typeof record.text === "string") return record.text;
  return "";
}

function transcript(lines: ChatLine[], text: string): HaikuMessage[] {
  const messages: HaikuMessage[] = [];
  for (const line of lines) {
    const last = messages.at(-1);
    if (last && last.role === line.role && typeof last.content === "string") {
      last.content = `${last.content}\n${line.text}`;
      continue;
    }
    messages.push({ role: line.role, content: line.text });
  }
  if (messages[0]?.role === "assistant") messages.shift();
  const last = messages.at(-1);
  if (last?.role === "user" && typeof last.content === "string") last.content = `${last.content}\n${text}`;
  else messages.push({ role: "user", content: text });
  return messages;
}

function specialistMemoryId(sessionId: string, agent: SpecialistAgent): string {
  return `${sessionId}:${agent}`;
}

function isBlock(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isToolUse(agent: SpecialistAgent, block: Record<string, unknown>): block is Record<string, unknown> & { id: string; name: ToolName; input: unknown } {
  if (block.type !== "tool_use" || typeof block.id !== "string") return false;
  if (isAssistantTool(block.name)) return true;
  if (!isToolName(block.name)) return false;
  return toolsFor(agent).some((tool) => tool.name === block.name);
}

function isToolName(value: unknown): value is SpecialistTool {
  return value === "compare_shops" || value === "shop_catalog" || value === "food_order" || value === "salon_request";
}

