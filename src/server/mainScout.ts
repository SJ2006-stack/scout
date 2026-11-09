import type { ChatEvent } from "../shared/chatEvents.ts";
import { cityById, cityFromPincode, cityFromText } from "../shared/cities.ts";
import { whenInMessage } from "../shared/when.ts";
import { withEmoji } from "../shared/emoji.ts";
import { runAssistantTool } from "./assistantTools.ts";
import { isChatter } from "./browser/shelf.ts";
import { busSummary } from "./browser/buses.ts";
import { flightSummary } from "./browser/flights.ts";
import type { ChatTurn } from "./chatRun.ts";
import { assistantContext } from "./eventChat.ts";
import { applyAnswers, errandLabel, formFor, isoDay, planErrands, questionsFor, type Errand, type ErrandPlan } from "./errands.ts";
import { asksForOtherResults } from "./otherResults.ts";
import { pendingForms } from "./questionBack.ts";
import { readBuy } from "./basket.ts";
import { converseSpecialist, orderPendingBasket, shopErrand } from "./specialistChat.ts";

/** Words that mean one of the errands Main Scout hands out. Other messages skip the planner call. */
const ERRAND_WORDS = /\b(order|buy|get me|grocer\w*|blinkit|zepto|instamart|quick[\s-]?commerce|price of|how much|whats ?app|send|message|text|tell|events?|happening|things to do|plans?|shows?|movies?|concerts?|bus(es)?|flights?|fly|travel|trip|ticket)\b|\bto [a-z]+ (today|tomorrow|tonight)/i;

type ListEvents = (turn: ChatTurn, emit: (event: ChatEvent) => void) => Promise<{ message: string; count: number; drives: () => Promise<void> }>;
const WHATSAPP_LIMIT = 500;
const WHEN_WORDS = { today: "today", tomorrow: "tomorrow", weekend: "this weekend", week: "this week" } as const;
/**
 * Main Scout splits one message into errands, asks every missing detail in one form, then hands the errands
 * to Shop, Event, Travel, and the phone at the same time. False when the message is not a set of errands,
 * so Main Scout just chats.
 */
export async function runMainScout(turn: ChatTurn, emit: (event: ChatEvent) => void, listEvents: ListEvents): Promise<boolean> {
  const ordered = await orderPendingBasket(turn, emit);
  if (ordered) return reply(emit, ordered);
  if (readBuy(turn.text)) return reply(emit, "There's no compared item to order. Name what you want first. After the prices, say order and the phone opens that store and fills the cart, then stops before payment.");
  if (await showOtherEvents(turn, emit, listEvents)) return true;
  const defaults = { city: savedCity(turn) };
  if (!isChatter(turn.text) && !ERRAND_WORDS.test(turn.text) && await showWhenFollowUp(turn, emit, listEvents)) return true;
  if (turn.sarvamApiKey.trim().length === 0 || isChatter(turn.text) || !ERRAND_WORDS.test(turn.text)) return false;
  emit({ type: "status", message: "Splitting that into tasks." });
  const plan = await planErrands({ text: turn.text, sarvamApiKey: turn.sarvamApiKey, now: turn.now(), timezone: turn.timezone, fetchImpl: turn.fetchImpl, signal: turn.signal, history: turn.history });
  if (!plan || !plan.errands.some((errand) => errand.kind !== "other")) return false;
  const questions = questionsFor(plan, defaults);
  if (questions.length === 0) {
    await runErrands(plan, turn, emit, listEvents);
    return true;
  }
  const form = formFor(plan, questions);
  pendingForms.save(turn.sessionId, form.id, { kind: "errands", plan });
  emit({ type: "form", form });
  const count = plan.errands.length;
  return reply(emit, `📋 I'll do ${count === 1 ? "this" : `these ${count} together`}: ${form.tasks.join("; ")}. A few details first, then everything starts at once.`);
}

/** Their answers to the errand form fill the saved plan, then every errand runs. */
export async function runAnsweredErrands(plan: ErrandPlan, values: Readonly<Record<string, string>>, turn: ChatTurn, emit: (event: ChatEvent) => void, listEvents: ListEvents): Promise<void> {
  await runErrands(applyAnswers(plan, values, turn.now(), turn.timezone, { city: savedCity(turn) }), turn, emit, listEvents);
}

async function runErrands(plan: ErrandPlan, turn: ChatTurn, emit: (event: ChatEvent) => void, listEvents: ListEvents): Promise<void> {
  const count = plan.errands.length;
  emit({ type: "status", message: `Starting ${count} task${count === 1 ? "" : "s"} at once.` });
  let finished = 0;
  await Promise.all(plan.errands.map(async (errand, index) => {
    const result = await runErrand(errand, turn, emit, listEvents).catch(() => "That one failed. Try it again on its own.");
    finished += 1;
    if (count > 1) emit({ type: "status", message: `Done ${finished} of ${count}: ${errandLabel(errand)}.` });
    emit({ type: "question", message: withEmoji(`**${index + 1}. ${errandLabel(errand)}:** ${result}`) });
  }));
  emit({ type: "done", count: 0 });
}

async function runErrand(errand: Errand, turn: ChatTurn, emit: (event: ChatEvent) => void, listEvents: ListEvents): Promise<string> {
  switch (errand.kind) {
    case "groceries":
      return shopErrand(turn, errand.items, emit);
    case "events": {
      const city = cityById(errand.city);
      if (!city) return "Skipped: I need a city, one of Bengaluru, Mumbai, Delhi, or Hyderabad.";
      const words = `${errand.eventKind ? `${errand.eventKind}s` : "events"} in ${city.name} ${WHEN_WORDS[errand.when ?? "week"]}`;
      const except = asksForOtherResults(turn.text) || asksForOtherResults(errand.summary) ? " except the ones already shown" : "";
      const found = await listEvents({ ...turn, agent: "event", text: `${words}${except}` }, emit);
      await found.drives();
      return found.message;
    }
    case "whatsapp": {
      if (!errand.contact) return "Skipped: I need who to send it to.";
      if (!errand.message) return `Skipped: I need what to send ${errand.contact}. Attach the photo and ask again.`;
      const digits = errand.contact.replace(/[\s()-]/g, "");
      const phone = /^\+?\d{10,15}$/.test(digits) ? (digits.replace(/^\+/, "").length === 10 ? `91${digits}` : digits.replace(/^\+/, "")) : null;
      const chat = phone ? `https://wa.me/${phone}` : null;
      if (chat) emit({ type: "places", places: [{ app: "WhatsApp", label: "Open the WhatsApp chat", url: chat }] });
      const sent = await runAssistantTool(
        assistantContext({ ...turn, agent: "main" }),
        "phone_action",
        { action: "send_whatsapp", ...(phone ? { phone } : { name: errand.contact }), text: fitWhatsApp(errand.message) },
        emit,
      );
      const saved = chat ? " The chat link stays in this thread." : "";
      return sent.ok ? `Sent to your phone. Tap Allow and it sends the message to ${errand.contact} on WhatsApp.${saved}` : sent.content;
    }
    case "bus": {
      if (!errand.from || !errand.to) return "Skipped: I need where the bus leaves from and where it goes.";
      if (!turn.compareBuses) return "The browser worker is not enabled on this server, so I can't read the bus sites.";
      const date = errand.date ?? isoDay(turn.now(), turn.timezone, 1);
      emit({ type: "status", message: `Checking redBus, ixigo, Goibibo, and ConfirmTkt for ${errand.from} to ${errand.to} on ${date}.` });
      const run = await turn.compareBuses({ from: errand.from, to: errand.to, date, timeOfDay: errand.timeOfDay ?? "any" }, turn.signal);
      if (run.result) emit({ type: "buses", buses: run.result });
      return run.result ? busSummary(run.result) : run.failure ?? busSummary(null);
    }
    case "flight": {
      if (!errand.from || !errand.to) return "Skipped: I need where the flight leaves from and where it goes.";
      if (!turn.compareFlights) return "The browser worker is not enabled on this server, so I can't open the flight sites.";
      const date = errand.date ?? isoDay(turn.now(), turn.timezone, 1);
      emit({ type: "status", message: `Checking flight sites for ${errand.from} to ${errand.to} on ${date}.` });
      const run = await turn.compareFlights(errand.from, errand.to, date, errand.timeOfDay ?? "any", turn.signal);
      if (run.result) emit({ type: "flights", flights: run.result });
      return run.result ? flightSummary(run.result) : run.failure ?? flightSummary(null);
    }
    case "other":
      return runOther(errand.summary, turn, emit);
    default: {
      const neverErrand: never = errand;
      return neverErrand;
    }
  }
}

/** An errand no specialist owns (an alarm, a reminder, a question) goes to Main Scout's own chat and tools. */
async function runOther(request: string, turn: ChatTurn, emit: (event: ChatEvent) => void): Promise<string> {
  let said = "";
  const relay = (event: ChatEvent): void => {
    if (event.type === "question") said = event.message;
    else if (event.type !== "done") emit(event);
  };
  const spoke = await converseSpecialist("main", { ...turn, agent: "main", text: request, answers: undefined }, relay);
  const line = said.replace(LEADING_EMOJI, "").trim();
  return spoke && line.length > 0 ? line : "I can't do that one yet.";
}

const LEADING_EMOJI = /^\p{Extended_Pictographic}\uFE0F?\s*/u;

/** WhatsApp messages from Scout stay under 500 characters; a long menu is cut at a line break. */
export function fitWhatsApp(message: string): string {
  if (message.length <= WHATSAPP_LIMIT) return message;
  const room = message.slice(0, WHATSAPP_LIMIT - 2);
  const at = room.lastIndexOf("\n");
  return `${(at > WHATSAPP_LIMIT / 2 ? room.slice(0, at) : room).trimEnd()}\n…`;
}

/** "What about the next weekend" searches that window in the city this chat already has. */
async function showWhenFollowUp(turn: ChatTurn, emit: (event: ChatEvent) => void, listEvents: ListEvents): Promise<boolean> {
  if (!isWhenFollowUp(turn.text, turn.now(), turn.timezone)) return false;
  const previous = turn.memory.get(turn.sessionId);
  const city = cityFromText(turn.text) ?? cityById(previous.cityId) ?? cityById(savedCity(turn));
  if (!city) return false;
  const found = await listEvents(turn, emit);
  await found.drives();
  return reply(emit, found.message);
}

function isWhenFollowUp(text: string, now: number, zone: string): boolean {
  if (whenInMessage(text, now, zone) == null) return false;
  return /\b(?:what|how) about\b/i.test(text) || /^(?:and |ok[, ]*)?(?:the )?(?:next |this )?(?:today|tonight|tomorrow|weekend|week)[.!?]*$/i.test(text.trim());
}

/** "Any other" or "except the ones above" searches once more and leaves out listings already shown. */
async function showOtherEvents(turn: ChatTurn, emit: (event: ChatEvent) => void, listEvents: ListEvents): Promise<boolean> {
  if (!asksForOtherResults(turn.text)) return false;
  const previous = turn.memory.get(turn.sessionId);
  if ((previous.found ?? []).length === 0) return false;
  const city = cityById(previous.cityId) ?? cityFromText(turn.text) ?? cityById(savedCity(turn));
  if (!city) return false;
  const found = await listEvents({ ...turn, agent: "event", text: `${turn.text}\nexcept the ones already shown` }, emit);
  await found.drives();
  return reply(emit, found.message);
}

function savedCity(turn: ChatTurn): string | null {
  const saved = turn.profile?.get(turn.sessionId, "city")?.value ?? null;
  return (saved ? cityFromText(saved)?.id : null) ?? cityFromPincode(turn.pincode)?.id ?? null;
}

function reply(emit: (event: ChatEvent) => void, message: string): true {
  emit({ type: "question", message: withEmoji(message) });
  emit({ type: "done", count: 0 });
  return true;
}
