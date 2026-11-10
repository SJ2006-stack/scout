import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatEvent } from "../src/shared/chatEvents.ts";
import { readErrandAnswers, readErrandForm } from "../src/shared/errands.ts";
import { ChatMemoryStore, emptyMemory } from "../src/server/chatMemory.ts";
import { listingsToShow } from "../src/server/otherResults.ts";
import { runChat, type ChatTurn } from "../src/server/chatRun.ts";
import { applyAnswers, groundPlan, lines, planErrands, questionsFor, readPlan } from "../src/server/errands.ts";
import { ListingCache } from "../src/server/listingCache.ts";
import { fitWhatsApp, runAnsweredErrands, runMainScout } from "../src/server/mainScout.ts";
import { pendingForms } from "../src/server/questionBack.ts";
import { busesInWindow, busSearches, busSummary, keepScrollingBuses, readBusPage, readBusRows, readLooseBuses, redbusSearchUrl } from "../src/server/browser/buses.ts";
import { flightSearches, flightSummary, readFlightFare } from "../src/server/browser/flights.ts";
import type { IsolatedPage } from "../src/server/browser/driver.ts";
import { cleanReply } from "../src/server/specialistChat.ts";
import { sarvamReply } from "./sarvamReply.ts";

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

  it("plans with Sarvam, without reasoning", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "plan_errands", arguments: JSON.stringify({ errands: [{ kind: "bus", summary: "Bus to Bareilly", to: "Bareilly", from: "null", date: "2026-11-07" }] }) } }] } }] });
    }) as typeof fetch;
    const plan = await planErrands({ text: "bus to bareilly tomorrow", sarvamApiKey: "sarvam", now: NOW, timezone: "Asia/Kolkata", fetchImpl, signal: new AbortController().signal });
    assert.deepEqual(plan?.errands, [{ kind: "bus", summary: "Bus to Bareilly", from: null, to: "Bareilly", date: "2026-11-07", timeOfDay: null }]);
    assert.equal(seen[0]?.url, "https://api.sarvam.ai/v1/chat/completions");
    assert.equal(seen[0]?.body.model, "sarvam-105b");
    assert.equal(seen[0]?.body.tool_choice, "required");
    assert.equal(seen[0]?.body.reasoning_effort, null);
    assert.doesNotMatch(JSON.stringify(seen[0]?.body), /anthropic|claude/i);
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
    const planner = planFetch(planned);
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

  it("finishes the event search before the shop lookup starts", async () => {
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
    const planner = planFetch(planned);
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
    assert.equal(eventsWaiting, true);
    assert.equal(shopWaiting, false);
    release();
    await running;
    assert.equal(shopWaiting, true);
  });

  it("saves the WhatsApp chat and does not replace a shop compare with search links", async () => {
    const request = "text 919876543210 that I am on my way, and the price of tea on blinkit";
    const planned = readPlan({
      errands: [
        { ...blank, kind: "whatsapp", summary: "Text Priya", contact: "919876543210", message: "On my way" },
        { ...blank, kind: "groceries", summary: "Price of Amul butter", items: [{ query: "amul butter 500g", quantity: 1, clarify: null }] },
      ],
    });
    const planner = planFetch(planned);
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

  it("collapses two event searches that would show the same cards", () => {
    const doubled = readPlan({
      errands: [
        { ...blank, kind: "events", summary: "Find more standup comedy shows/events, excluding ones already mentioned", city: "delhi", when: "weekend", eventKind: "comedy" },
        { ...blank, kind: "events", summary: "Find more standup comedy shows/events, excluding ones already mentioned", city: "delhi", when: "weekend", eventKind: "comedy" },
      ],
    });
    assert.ok(doubled);
    const grounded = groundPlan(doubled, "More standup comedies except the above ones that you could get me");
    assert.equal(grounded.errands.length, 1);
    assert.equal(grounded.errands[0]?.kind, "events");
  });

  it("searches the next weekend instead of chatting the question back", async () => {
    const base = turn({ text: "What about the next weekend", fetchImpl: (async () => { throw new Error("planner"); }) as unknown as typeof fetch });
    base.memory.save(SESSION, { ...emptyMemory(), cityId: "delhi", date: "tomorrow" });
    const texts: string[] = [];
    const events: ChatEvent[] = [];
    const ran = await runMainScout(base, (event) => events.push(event), async (eventTurn) => {
      texts.push(eventTurn.text);
      return { message: "6 in Delhi for this weekend: Patiala Mehfil, Community Run, Miles & melody.", count: 6, drives: async () => undefined };
    });
    assert.equal(ran, true);
    assert.deepEqual(texts, ["What about the next weekend"]);
    const reply = events.find((event) => event.type === "question");
    assert.match(reply?.type === "question" ? reply.message : "", /this weekend/);
  });

  it("asks again for other listings without planning a second copy", async () => {
    const base = turn({ text: "any other", fetchImpl: (async () => { throw new Error("planner"); }) as unknown as typeof fetch });
    base.memory.save(SESSION, {
      ...emptyMemory(),
      cityId: "delhi",
      date: "weekend",
      kind: "comedy",
      found: [
        { title: "Stand-Up Comedy Show ft. Various Artist", url: "https://www.district.in/events/one" },
        { title: "Comedy Show Ft. Various Artist", url: "https://www.district.in/events/two" },
      ],
    });
    const texts: string[] = [];
    const events: ChatEvent[] = [];
    const ran = await runMainScout(base, (event) => events.push(event), async (eventTurn) => {
      texts.push(eventTurn.text);
      return { message: "Those are the only listings I found: Stand-Up Comedy Show ft. Various Artist, Comedy Show Ft. Various Artist. Nothing else matched.", count: 0, drives: async () => undefined };
    });
    assert.equal(ran, true);
    assert.deepEqual(texts, ["any other\nexcept the ones already shown"]);
    assert.equal(events.some((event) => event.type === "form"), false);
    const reply = events.find((event) => event.type === "question");
    assert.match(reply?.type === "question" ? reply.message : "", /Nothing else matched/);
  });

  it("leaves out listings that were already shown", () => {
    const ranked = [{ url: "https://shown" }, { url: "https://new" }];
    assert.deepEqual(listingsToShow(ranked, [{ url: "https://shown" }], true), { shown: [{ url: "https://new" }], repeated: false });
    assert.deepEqual(listingsToShow(ranked, [{ url: "https://shown" }, { url: "https://new" }], true).repeated, true);
    assert.equal(listingsToShow(ranked, [{ url: "https://shown" }], false).shown.length, 2);
  });

  it("drops a made-up city and an empty grocery list", () => {
    const plan = readPlan({ errands: [{ ...blank, kind: "events", summary: "x", city: "paris" }, { ...blank, kind: "groceries", summary: "y" }] });
    assert.deepEqual(plan?.errands.map((errand) => errand.kind === "events" && errand.city), [null]);
  });

  it("asks first, then runs groceries, events, WhatsApp, and the bus one at a time", async () => {
    const planner = planFetch(ERRANDS);
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

  it("runs several errands one at a time and updates the queue", async () => {
    let running = 0;
    let maxRunning = 0;
    const events: ChatEvent[] = [];
    const plan = readPlan({
      errands: [
        { ...blank, kind: "events", summary: "Comedy in Delhi", city: "delhi", when: "weekend" },
        { ...blank, kind: "events", summary: "Movies in Mumbai", city: "mumbai", when: "week" },
      ],
    });
    assert.ok(plan);
    const listEvents = async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 40));
      running -= 1;
      return { message: "A few listings.", count: 2, drives: async () => undefined };
    };
    await runAnsweredErrands(plan, {}, turn({ text: "comedy in delhi and movies in mumbai" }), (event) => events.push(event), listEvents);
    assert.equal(maxRunning, 1);
    const queues = events.filter((event) => event.type === "queue").map((event) => event.type === "queue" ? event.queue.items.map((item) => item.state) : []);
    assert.deepEqual(queues, [
      ["waiting", "waiting"],
      ["running", "waiting"],
      ["done", "waiting"],
      ["done", "running"],
      ["done", "done"],
    ]);
    const statuses = events.filter((event) => event.type === "status").map((event) => event.type === "status" ? event.message : "");
    assert.deepEqual(statuses, ["Now 1 of 2: Comedy in Delhi.", "Now 2 of 2: Movies in Mumbai."]);
  });

  it("looks up something to do now instead of saving a reminder", async () => {
    const texts: string[] = [];
    const events: ChatEvent[] = [];
    const ran = await runMainScout(turn({
      text: "Look for something to do around this weekend in Delhi",
      fetchImpl: (async () => { throw new Error("planner"); }) as unknown as typeof fetch,
    }), (event) => events.push(event), async (eventTurn) => {
      texts.push(eventTurn.text);
      return { message: "12 in Delhi for this weekend.", count: 12, drives: async () => undefined };
    });
    assert.equal(ran, true);
    assert.deepEqual(texts, ["Look for something to do around this weekend in Delhi"]);
    assert.equal(events.some((event) => event.type === "watch"), false);
    const reply = events.find((event) => event.type === "question");
    assert.match(reply?.type === "question" ? reply.message : "", /12 in Delhi for this weekend/);
  });

  it("reads the usual grocery basket from the Vault before searching", async () => {
    const queries: string[][] = [];
    const events: ChatEvent[] = [];
    const ran = await runMainScout(turn({
      text: "Scout, find me my usual groceries",
      fetchImpl: (async () => { throw new Error("planner"); }) as unknown as typeof fetch,
      compareBasket: async (asked) => {
        queries.push([...asked]);
        return { opened: 3, signIn: null, lines: asked.map((query) => ({ query, offers: [] })) };
      },
    }), (event) => events.push(event), async () => ({ message: "", count: 0, drives: async () => undefined }));
    assert.equal(ran, true);
    assert.equal(queries.length, 1);
    assert.match(queries[0]?.join(" ") ?? "", /Amul Taaza Toned Milk/);
    assert.match(queries[0]?.join(" ") ?? "", /Britannia Whole Wheat Bread/);
    assert.equal(queries[0]?.some((query) => /usual/i.test(query)), false);
    assert.equal(events.some((event) => event.type === "form"), false);
    const reply = events.find((event) => event.type === "question");
    assert.match(reply?.type === "question" ? reply.message : "", /From your Vault/);
    assert.equal(events.some((event) => event.type === "status" && event.message.includes("Vault")), true);
  });

  it("does not search an order sentence as a product", async () => {
    const events: ChatEvent[] = [];
    const ran = await runMainScout(turn({
      sessionId: "c".repeat(32),
      text: "Order from zepto then",
      fetchImpl: (async () => { throw new Error("planner"); }) as unknown as typeof fetch,
    }), (event) => events.push(event), async () => ({ message: "", count: 0, drives: async () => undefined }));
    assert.equal(ran, true);
    const reply = events.find((event) => event.type === "question");
    assert.match(reply?.type === "question" ? reply.message : "", /no compared item to order/);
    assert.equal(events.some((event) => event.type === "form"), false);
  });

  it("leaves chatter and single phone requests to Main Scout's chat", async () => {
    const planner = planFetch({ errands: [{ ...blank, kind: "other", summary: "Set an alarm" }] });
    const unused = async () => ({ message: "", count: 0, drives: async () => undefined });
    assert.equal(await runMainScout(turn({ text: "hi", fetchImpl: planner }), () => undefined, unused), false);
    assert.equal(await runMainScout(turn({ text: "wake me at 7", fetchImpl: planner }), () => undefined, unused), false);
    assert.equal(await runMainScout(turn({ text: "bread and jam", fetchImpl: planner, sarvamApiKey: "" }), () => undefined, unused), false);
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

  it("keeps scrolling when the first rows leave outside the asked window", () => {
    assert.equal(keepScrollingBuses({ timeOfDay: "evening", inWindow: 0, grew: true, moved: true, pass: 1, fruitless: 0 }), true);
    assert.equal(keepScrollingBuses({ timeOfDay: "evening", inWindow: 2, grew: false, moved: true, pass: 3, fruitless: 1 }), false);
    assert.equal(keepScrollingBuses({ timeOfDay: "evening", inWindow: 0, grew: false, moved: false, pass: 2, fruitless: 2 }), false);
  });

  it("opens four bus sites and scrolls until an evening departure is loaded", async () => {
    const searches = busSearches({ from: "Delhi", to: "Jaipur", date: "2026-11-10", timeOfDay: "evening" });
    assert.deepEqual(searches.map((search) => search.site), ["redBus", "ixigo", "Goibibo", "ConfirmTkt"]);
    assert.match(searches[0]?.url ?? "", /redbus\.in\/bus-tickets\/delhi-to-jaipur/);
    const page = new WindowPage();
    const step = <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => run(new AbortController().signal);
    const redBus = searches[0];
    assert.ok(redBus);
    const site = await readBusPage(page as unknown as IsolatedPage, { from: "Delhi", to: "Jaipur", date: "2026-11-10", timeOfDay: "evening" }, redBus, step);
    assert.ok(page.scrolls >= 1);
    assert.deepEqual(site.options.map((option) => option.operator), ["Night Rider"]);
    const loose = readLooseBuses("Volvo 21:05 - 05:40 ₹1,250 sleeper");
    assert.equal(loose[0]?.rupees, 1250);
    assert.equal(loose[0]?.departs, "21:05");
  });
});

class WindowPage {
  scrolls = 0;

  async goto(): Promise<{ url: string; title: string }> {
    return { url: "https://www.redbus.in/x", title: "buses" };
  }

  async html(): Promise<string> {
    const evening = this.scrolls > 0
      ? `<li aria-label="Night Rider, A/C Sleeper (2+1). Departs 21:10, arrives 05:00. Duration 7h 50m. Available seats 6 Seats. Price 640 INR. Rated 4.1 out of 5.">`
      : "";
    return `20 buses found<li aria-label="Morning Coach, A/C Seater (2+2). Departs 08:15, arrives 14:00. Duration 5h 45m. Available seats 12 Seats. Price 500 INR.">${evening}`;
  }

  async scroll(): Promise<boolean> {
    this.scrolls += 1;
    return true;
  }
}

describe("flight cites", () => {
  it("links Google Flights from the city names and the other sites from airport codes", () => {
    const delhi = flightSearches("Delhi", "Mumbai", "2026-11-10", "evening");
    assert.deepEqual(delhi.map((search) => search.site), ["Google Flights", "MakeMyTrip", "Goibibo", "Cleartrip", "ixigo", "EaseMyTrip"]);
    assert.match(delhi[0]?.url ?? "", /google\.com\/travel\/flights/);
    assert.match(delhi[0]?.url ?? "", /evening/);
    assert.match(delhi[1]?.url ?? "", /DEL-BOM-10\/11\/2026/);
    assert.deepEqual(flightSearches("Bareilly", "Jaipur", "2026-11-10", "any").map((search) => search.site), ["Google Flights"]);
    const fare = readFlightFare("Morning ₹3,200 at 08:10. Evening special ₹4,150 leaving 19:40. Fees ₹199.", "evening");
    assert.deepEqual(fare, { rupees: 4150, departs: "19:40" });
    assert.equal(readFlightFare("Only the 08:10 fare ₹3,200 is shown.", "evening"), null);
    assert.match(flightSummary({
      from: "Delhi",
      to: "Mumbai",
      date: "2026-11-10",
      window: "evening (6 pm to midnight)",
      cites: [{ site: "MakeMyTrip", url: "https://www.makemytrip.com/flight/search", rupees: 4150, departs: "19:40" }],
    }), /₹4150 on MakeMyTrip, leaving 19:40/);
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

function planFetch(input: unknown): typeof fetch {
  return (async () => Response.json(sarvamReply({
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "t", name: "plan_errands", input }],
  }))) as typeof fetch;
}

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
    sarvamApiKey: "test-key",
    agent: "main",
    ...options,
  };
}
