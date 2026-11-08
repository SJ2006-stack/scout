import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatEvent } from "../src/shared/chatEvents.ts";
import { readErrandAnswers, readErrandForm } from "../src/shared/errands.ts";
import { ChatMemoryStore } from "../src/server/chatMemory.ts";
import { runChat, type ChatTurn } from "../src/server/chatRun.ts";
import { applyAnswers, groundPlan, lines, planErrands, questionsFor, readPlan } from "../src/server/errands.ts";
import { ListingCache } from "../src/server/listingCache.ts";
import { fitWhatsApp, runAnsweredErrands, runMainScout } from "../src/server/mainScout.ts";
import { pendingForms } from "../src/server/questionBack.ts";
import { busesInWindow, busSummary, readBusRows, redbusSearchUrl } from "../src/server/browser/buses.ts";
import { cleanReply } from "../src/server/specialistChat.ts";

const NOW = Date.parse("2026-11-06T17:00:00.000Z");
const SESSION = "b".repeat(32);

const blank = { items: [], city: null, when: null, eventKind: null, contact: null, message: null, messageFromPhoto: false, from: null, to: null, date: null, timeOfDay: null };
const ERRANDS = {
  errands: [
    {
      ...blank,
      kind: "groceries",
      summary: "Bread, butter, and jam",
      items: [
        { query: "bread", quantity: 1, clarify: null },
        { query: "butter", quantity: 1, clarify: null },
        { query: "jam", quantity: 1, clarify: { prompt: "Which jam?", options: ["Mixed fruit", "Strawberry", "Any"] } },
      ],
    },
    { ...blank, kind: "events", summary: "What's on in Delhi this weekend", city: "delhi", when: "weekend" },
    { ...blank, kind: "whatsapp", summary: "Mess menu to Soham Bahnja", contact: "Soham Bahnja", messageFromPhoto: true },
    { ...blank, kind: "bus", summary: "Bus to Bareilly tomorrow", to: "Bareilly", date: "2026-11-07" },
  ],
};

describe("Main Scout errands", () => {
  it("reads the plan and asks only what each errand is missing, all at once", () => {
    const plan = readPlan(ERRANDS);
    assert.ok(plan);
    assert.deepEqual(plan.errands.map((errand) => errand.kind), ["groceries", "events", "whatsapp", "bus"]);
    const questions = questionsFor(plan, { city: "delhi" });
    assert.deepEqual(questions.map((question) => [question.id, question.kind]), [
      ["0.item.0", "choice"],
      ["0.item.1", "choice"],
      ["0.item.2", "choice"],
      ["2.message", "photo"],
      ["3.from", "choice"],
      ["3.time", "choice"],
    ]);
    assert.equal(questions[0]?.prompt, "Which bread?");
    assert.equal(questions[1]?.prompt, "Which butter?");
    assert.deepEqual(questions[4]?.options, ["Delhi"]);
  });

  it("fills the errands from the answers", () => {
    const plan = readPlan(ERRANDS);
    assert.ok(plan);
    const filled = applyAnswers(plan, { "0.item.2": "Mixed fruit", "2.message": "Lunch\nDal, rice\n\nDinner\nPaneer", "3.from": "Delhi", "3.time": "Evening" }, NOW, "Asia/Kolkata", { city: "delhi" });
    const [groceries, , whatsapp, bus] = filled.errands;
    assert.equal(groceries?.kind === "groceries" && groceries.items[2]?.query, "Mixed fruit jam");
    assert.equal(whatsapp?.kind === "whatsapp" && whatsapp.message, "Lunch\nDal, rice\n\nDinner\nPaneer");
    assert.deepEqual(bus?.kind === "bus" ? [bus.from, bus.to, bus.date, bus.timeOfDay] : [], ["Delhi", "Bareilly", "2026-11-07", "evening"]);
  });

  it("drops a bus start, time, or message the planner filled in on its own", () => {
    const guessed = readPlan({
      errands: [
        { ...blank, kind: "bus", summary: "Bus", from: "Delhi", to: "Bareilly", date: "2026-11-07", timeOfDay: "any" },
        { ...blank, kind: "whatsapp", summary: "Menu", contact: "Soham", message: "Here is the current mess menu:", messageFromPhoto: false },
        { ...blank, kind: "events", summary: "Events", city: "mumbai", when: "weekend" },
      ],
    });
    assert.ok(guessed);
    const request = "send soham the current mess menu, a bus for bareilly tomorrw, and whats on this weekend";
    const [bus, whatsapp, events] = groundPlan(guessed, request).errands;
    assert.deepEqual(bus?.kind === "bus" ? [bus.from, bus.to, bus.timeOfDay] : [], [null, "Bareilly", null]);
    assert.deepEqual(whatsapp?.kind === "whatsapp" ? [whatsapp.message, whatsapp.messageFromPhoto] : [], [null, true]);
    assert.deepEqual(events?.kind === "events" ? [events.city, events.when] : [], [null, "weekend"]);
    const [said] = groundPlan(guessed, "bus from delhi to bareilly tomorrow evening").errands;
    assert.deepEqual(said?.kind === "bus" ? [said.from] : [], ["Delhi"]);
    const [message] = groundPlan(readPlan({ errands: [{ ...blank, kind: "whatsapp", summary: "x", contact: "Soham", message: "Running 10 minutes late" }] }) ?? { errands: [] }, "tell soham I'm running 10 minutes late").errands;
    assert.equal(message?.kind === "whatsapp" && message.message, "Running 10 minutes late");
  });

  it("plans with Sarvam when Claude is out of credit, without reasoning", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("anthropic")) return Response.json({ type: "error", error: { message: "Your credit balance is too low" } }, { status: 400 });
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "plan_errands", arguments: JSON.stringify({ errands: [{ kind: "bus", summary: "Bus to Bareilly", to: "Bareilly", from: "null", date: "2026-11-07" }] }) } }] } }] });
    }) as typeof fetch;
    const plan = await planErrands({ text: "bus to bareilly tomorrow", apiKey: "claude", sarvamApiKey: "sarvam", now: NOW, timezone: "Asia/Kolkata", fetchImpl, signal: new AbortController().signal });
    assert.deepEqual(plan?.errands, [{ kind: "bus", summary: "Bus to Bareilly", from: null, to: "Bareilly", date: "2026-11-07", timeOfDay: null }]);
    assert.equal(bodies[0]?.tool_choice, "required");
    assert.equal(bodies[0]?.reasoning_effort, null);
  });

  it("sends a quick-commerce price question to Shop even when the planner calls it other", async () => {
    const request = "tell me what's happening in delhi today as well as the price of tea in all 3 quick commerce apps";
    const planned = readPlan({
      errands: [
        { ...blank, kind: "events", summary: "What's happening in Delhi", city: "delhi", when: "today" },
        { ...blank, kind: "other", summary: "What's the price of tea in all 3 quick commerce apps" },
      ],
    });
    const grounded = planned ? groundPlan(planned, request) : null;
    assert.equal(grounded?.errands[1]?.kind, "groceries");
    assert.deepEqual(grounded?.errands[1]?.kind === "groceries" ? grounded.errands[1].items : [], [{ query: "tea", quantity: 1, clarify: { prompt: "Which tea?", options: ["Tata Tea", "Red Label", "Green tea", "Any"] } }]);

    const looked: string[] = [];
    const planner = (async () => Response.json({ content: [{ type: "tool_use", id: "t", name: "plan_errands", input: planned }] })) as unknown as typeof fetch;
    const events: ChatEvent[] = [];
    const base = turn({
      text: request,
      fetchImpl: planner,
      compareShop: async (query) => {
        looked.push(query);
        return { offers: [], cheapest: null, pay: null, summary: "Blinkit is cheapest: Tata Tea at ₹99. Zepto from ₹110. Instamart from ₹120.", signIn: null };
      },
    });
    await runMainScout(base, (event) => events.push(event), async () => ({ message: "15 in Delhi for today.", count: 15, drives: async () => undefined }));
    assert.deepEqual(looked, []);
    const form = events.find((event) => event.type === "form");
    assert.equal(form?.type, "form");
    if (form?.type !== "form") return;
    const saved = pendingForms.take(base.sessionId, form.form.id);
    assert.equal(saved?.kind, "errands");
    if (saved?.kind !== "errands") return;
    const answered: ChatEvent[] = [];
    await runAnsweredErrands(saved.plan, { "1.item.0": "Tata Tea" }, base, (event) => answered.push(event), async () => ({ message: "15 in Delhi for today.", count: 15, drives: async () => undefined }));
    assert.deepEqual(looked, ["Tata Tea"]);
    const replies = answered.filter((event) => event.type === "question").map((event) => event.type === "question" ? event.message : "").join("\n");
    assert.match(replies, /Blinkit is cheapest: Tata Tea at ₹99/);
    assert.equal(answered.some((event) => event.type === "places"), false);
  });

  it("starts the shop lookup and the event search before either one finishes", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let shopWaiting = false;
    let eventsWaiting = false;
    const request = "what's happening in delhi today and the price of tea on blinkit";
    const planned = readPlan({
      errands: [
        { ...blank, kind: "events", summary: "What's happening in Delhi", city: "delhi", when: "today" },
        { ...blank, kind: "groceries", summary: "Price of Amul butter", items: [{ query: "amul butter 500g", quantity: 1, clarify: null }] },
      ],
    });
    const planner = (async () => Response.json({ content: [{ type: "tool_use", id: "t", name: "plan_errands", input: planned }] })) as unknown as typeof fetch;
    const running = runMainScout(turn({
      text: request,
      fetchImpl: planner,
      compareShop: async () => {
        shopWaiting = true;
        await gate;
        return { offers: [], cheapest: null, pay: null, summary: "Blinkit is cheapest: tea at ₹99.", signIn: null };
      },
    }), () => undefined, async () => {
      eventsWaiting = true;
      await gate;
      return { message: "15 in Delhi for today.", count: 15, drives: async () => undefined };
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(shopWaiting && eventsWaiting, true);
    release();
    await running;
  });

  it("saves the WhatsApp chat and does not replace a shop compare with search links", async () => {
    const request = "text 919876543210 that I am on my way, and the price of tea on blinkit";
    const planned = readPlan({
      errands: [
        { ...blank, kind: "whatsapp", summary: "Text Priya", contact: "919876543210", message: "On my way" },
        { ...blank, kind: "groceries", summary: "Price of Amul butter", items: [{ query: "amul butter 500g", quantity: 1, clarify: null }] },
      ],
    });
    const planner = (async () => Response.json({ content: [{ type: "tool_use", id: "t", name: "plan_errands", input: planned }] })) as unknown as typeof fetch;
    const events: ChatEvent[] = [];
    await runMainScout(turn({
      text: request,
      fetchImpl: planner,
      phone: { serviceOn: true, apps: {} },
      compareShop: async () => ({ offers: [], cheapest: null, pay: null, summary: "Blinkit is cheapest: tea at ₹99.", signIn: null }),
    }), (event) => events.push(event), async () => ({ message: "", count: 0, drives: async () => undefined }));
    const places = events.filter((event) => event.type === "places").flatMap((event) => event.type === "places" ? event.places : []);
    assert.deepEqual(places.map((place) => place.url), ["https://wa.me/919876543210"]);
    const device = events.find((event) => event.type === "device");
    assert.equal(device?.type === "device" && device.action.name, "send_whatsapp");
  });

  it("drops a made-up city and an empty grocery list", () => {
    const plan = readPlan({ errands: [{ ...blank, kind: "events", summary: "x", city: "paris" }, { ...blank, kind: "groceries", summary: "y" }] });
    assert.deepEqual(plan?.errands.map((errand) => errand.kind === "events" && errand.city), [null]);
  });

  it("asks first, then runs groceries, events, WhatsApp, and the bus together", async () => {
    const planner = (async () => Response.json({ content: [{ type: "tool_use", id: "t", name: "plan_errands", input: ERRANDS }] })) as unknown as typeof fetch;
    const shopped: string[][] = [];
    const busTrips: unknown[] = [];
    const eventTexts: string[] = [];
    const base = turn({
      text: "order bread, butter and jam, look what's happening in delhi this weekend, send soham bahnja the current mess menu, and a bus for bareilly tomorrow",
      fetchImpl: planner,
      compareBasket: async (queries) => {
        shopped.push([...queries]);
        return { opened: 3, signIn: null, lines: queries.map((query) => ({ query, offers: [] })) };
      },
      compareBuses: async (trip) => {
        busTrips.push(trip);
        return {
          failure: null,
          result: { from: "Delhi", to: "Bareilly", date: "2026-11-07", window: "evening (6 pm to midnight)", url: "https://www.redbus.in/bus-tickets/delhi-to-bareilly", total: 74, options: [{ operator: "FlixBus", busType: "A/C Sleeper", departs: "22:30", arrives: "04:00", duration: "5h 30m", seats: 18, rupees: 856, rating: 4.3 }] },
        };
      },
      phone: { serviceOn: true, apps: {} },
    });
    const listEvents = async (eventTurn: ChatTurn) => {
      eventTexts.push(eventTurn.text);
      return { message: "12 in Delhi for this weekend: A, B, C.", count: 12, drives: async () => undefined };
    };
    const first: ChatEvent[] = [];
    assert.equal(await runMainScout(base, (event) => first.push(event), listEvents), true);
    const form = first.find((event) => event.type === "form");
    assert.equal(form?.type, "form");
    if (form?.type !== "form") return;
    assert.ok(readErrandForm(form.form));
    assert.equal(shopped.length, 0, "nothing runs before the questions are answered");

    const answers = readErrandAnswers({ formId: form.form.id, values: { "0.item.2": "Mixed fruit", "2.message": "Lunch: Dal, rice", "3.from": "Delhi", "3.time": "Evening" } });
    assert.ok(answers);
    const saved = pendingForms.take(base.sessionId, form.form.id);
    assert.equal(saved?.kind, "errands");
    if (saved?.kind !== "errands") return;
    const second: ChatEvent[] = [];
    await runAnsweredErrands(saved.plan, answers.values, base, (event) => second.push(event), listEvents);
    assert.deepEqual(shopped, [["bread", "butter", "Mixed fruit jam"]]);
    assert.deepEqual(eventTexts, ["events in Delhi this weekend"]);
    assert.deepEqual(busTrips, [{ from: "Delhi", to: "Bareilly", date: "2026-11-07", timeOfDay: "evening" }]);
    const device = second.find((event) => event.type === "device");
    assert.equal(device?.type === "device" && device.action.name, "send_whatsapp");
    assert.deepEqual(device?.type === "device" ? device.action.args : null, { phone: null, name: "Soham Bahnja", text: "Lunch: Dal, rice" });
    assert.equal(second.some((event) => event.type === "buses"), true);
    const replies = second.filter((event) => event.type === "question").map((event) => event.type === "question" ? event.message : "").join("\n");
    assert.match(replies, /1\. Bread, butter, and jam/);
    assert.match(replies, /2\. What's on in Delhi/);
    assert.match(replies, /3\. Mess menu/);
    assert.match(replies, /4\. Bus to Bareilly/);

    const stale: ChatEvent[] = [];
    await runChat({ ...base, text: "answers", answers }, (event) => stale.push(event));
    assert.match(stale.find((event) => event.type === "question")?.type === "question" ? String((stale.find((event) => event.type === "question") as { message: string }).message) : "", /expired/);
  });

  it("leaves chatter and single phone requests to Main Scout's chat", async () => {
    const planner = (async () => Response.json({ content: [{ type: "tool_use", id: "t", name: "plan_errands", input: { errands: [{ ...blank, kind: "other", summary: "Set an alarm" }] } }] })) as unknown as typeof fetch;
    const unused = async () => ({ message: "", count: 0, drives: async () => undefined });
    assert.equal(await runMainScout(turn({ text: "hi", fetchImpl: planner }), () => undefined, unused), false);
    assert.equal(await runMainScout(turn({ text: "wake me at 7", fetchImpl: planner }), () => undefined, unused), false);
    assert.equal(await runMainScout(turn({ text: "bread and jam", fetchImpl: planner, anthropicApiKey: "" }), () => undefined, unused), false);
  });

  it("keeps a WhatsApp message under 500 characters at a line break, and keeps line breaks", () => {
    const menu = Array.from({ length: 40 }, (_, index) => `Day ${index + 1}: dal, rice, roti`).join("\n");
    const fitted = fitWhatsApp(menu);
    assert.ok(fitted.length <= 500);
    assert.match(fitted, /roti\n…$/);
    assert.equal(lines("  Lunch \n\n\n Dal  rice ", 100), "Lunch\n\nDal rice");
  });
});

describe("redBus reader", () => {
  it("builds the day's search link from the city names", () => {
    assert.equal(redbusSearchUrl("New Delhi", "bareilly", "2026-11-07"), "https://www.redbus.in/bus-tickets/delhi-to-bareilly?fromCityName=Delhi&toCityName=Bareilly&onward=07-Nov-2026");
    assert.equal(redbusSearchUrl("Delhi", "Delhi", "2026-11-07"), null);
    assert.equal(redbusSearchUrl("Delhi", "Bareilly", "tomorrow"), null);
  });

  it("reads each bus from its spoken row label and keeps the asked window, cheapest first", () => {
    const html = [
      `<li id="1" aria-label="FlixBus, Bharat Benz A/C Semi Sleeper (2+2). Departs 22:30, arrives 04:00. Duration 5h 30m. Available seats 18 Seats. Price 856.19 INR. Rated 4.3 out of 5. Total reviewers 591. 1 of 45">`,
      `<li id="2" aria-label="NueGo, Electric A/C Semi Sleeper (2+2). Departs 06:30, arrives 12:10. Duration 5h 40m. Available seats 10 Seats. Price 1,569 INR. Rated 4.2 out of 5. 2 of 45">`,
      `<li id="3" aria-label="SHRI RAM TRAVELS, A/C Seater (2+2). Departs 23:59, arrives 05:30. Duration 5h 31m. Available seats 34 Seats. Price 799 INR. 3 of 45">`,
    ].join("");
    const rows = readBusRows(html);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[1], { operator: "NueGo", busType: "Electric A/C Semi Sleeper (2+2)", departs: "06:30", arrives: "12:10", duration: "5h 40m", seats: 10, rupees: 1569, rating: 4.2 });
    assert.deepEqual(busesInWindow(rows, "evening").map((row) => [row.operator, row.rupees]), [["SHRI RAM TRAVELS", 799], ["FlixBus", 856]]);
    assert.deepEqual(busesInWindow(rows, "morning").map((row) => row.operator), ["NueGo"]);
    assert.match(busSummary({ from: "Delhi", to: "Bareilly", date: "2026-11-07", window: "evening", url: "https://www.redbus.in/x", total: 74, options: busesInWindow(rows, "evening") }), /cheapest is SHRI RAM TRAVELS at ₹799, leaving 23:59/);
  });
});

describe("reply cleanup", () => {
  it("drops what Sarvam writes after its answer", () => {
    assert.equal(cleanReply("Blinkit is cheapest at ₹99.\n\n```json\n{\"note\": \"x\"}\n```"), "Blinkit is cheapest at ₹99.");
    assert.equal(cleanReply("Zepto ₹29.\n---\n### User message:\n> yeah"), "Zepto ₹29.");
    assert.equal(cleanReply("Tell me the variant.\n\nAuto-Reply: Did you mean zoom?"), "Tell me the variant.");
    assert.equal(cleanReply("Which one?\n**Did I get it?**\n(A) price"), "Which one?");
    assert.equal(cleanReply("Plain answer."), "Plain answer.");
  });
});

function turn(options: Partial<ChatTurn> & { text: string }): ChatTurn {
  return {
    sessionId: SESSION,
    timezone: "Asia/Kolkata",
    pincode: "",
    lat: null,
    lon: null,
    timeoutMs: 1000,
    signal: new AbortController().signal,
    now: () => NOW,
    memory: new ChatMemoryStore(),
    cache: new ListingCache(60_000, () => NOW),
    fetchImpl: (async () => Response.json({})) as unknown as typeof fetch,
    mapsApiKey: "",
    sarvamApiKey: "",
    agent: "main",
    anthropicApiKey: "test-key",
    ...options,
  };
}
