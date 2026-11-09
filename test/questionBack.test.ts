import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatEvent } from "../src/shared/chatEvents.ts";
import { ChatMemoryStore } from "../src/server/chatMemory.ts";
import { runChat, type ChatTurn } from "../src/server/chatRun.ts";
import { ListingCache } from "../src/server/listingCache.ts";
import { runAnsweredErrands } from "../src/server/mainScout.ts";
import { answersMessage, askShelf, askShelfChoices, askUser, PendingForms } from "../src/server/questionBack.ts";
import { askPicks, picksFromProse } from "../src/server/toolLoop.ts";
import { sarvamReply } from "./sarvamReply.ts";

const NOW = Date.parse("2026-11-06T17:00:00.000Z");

type Sent = { messages: { role: string; content: unknown }[]; tools: string[] };

/** A fake Sarvam that answers in order and records what Scout sent it. */
function sarvam(...replies: { stop_reason: string; content: unknown[] }[]): { fetchImpl: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  let index = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages?: { role: string; content: unknown }[]; tools?: { function?: { name?: string } }[] };
    sent.push({ messages: body.messages ?? [], tools: (body.tools ?? []).map((tool) => tool.function?.name ?? "") });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return Response.json(sarvamReply(reply ?? { stop_reason: "end_turn", content: [] }));
  }) as typeof fetch;
  return { fetchImpl, sent };
}

const ASK = {
  stop_reason: "tool_use",
  content: [
    { type: "text", text: "Which pack size do you want?" },
    {
      type: "tool_use",
      id: "t_ask",
      name: "ask_user",
      input: { why: "Then I'll compare it on all three stores.", questions: [{ prompt: "Which size of Amul butter?", options: ["100 g", "500 g"] }, { prompt: "How many?", options: [] }] },
    },
  ],
};

describe("question-back", () => {
  it("lets any scout ask with a form, stops the turn, and resumes it with the answers", async () => {
    const memory = new ChatMemoryStore();
    const first = sarvam(ASK, { stop_reason: "end_turn", content: [{ type: "text", text: "should not run" }] });
    const events: ChatEvent[] = [];
    await runChat(turn({ text: "get me amul butter", agent: "shop", fetchImpl: first.fetchImpl, memory }), (event) => events.push(event));
    assert.equal(first.sent.length, 1, "no second model round after asking");
    assert.equal(first.sent[0]?.tools.includes("ask_user"), true);
    const form = events.find((event) => event.type === "form");
    assert.equal(form?.type, "form");
    if (form?.type !== "form") return;
    assert.deepEqual(form.form.tasks, ["Then I'll compare it on all three stores."]);
    assert.deepEqual(form.form.questions, [
      { id: "q0", prompt: "Which size of Amul butter?", kind: "choice", options: ["100 g", "500 g"] },
      { id: "q1", prompt: "How many?", kind: "text", options: [] },
    ]);
    const asked = events.find((event) => event.type === "question");
    assert.equal(asked?.type === "question" && asked.message.includes("Which pack size do you want?"), true);
    assert.equal(events.at(-1)?.type, "done");

    const second = sarvam({ stop_reason: "end_turn", content: [{ type: "text", text: "Comparing 500 g now." }] });
    const resumed: ChatEvent[] = [];
    await runChat(
      turn({ text: "Which size of Amul butter? 500 g", agent: "event", fetchImpl: second.fetchImpl, memory, answers: { formId: form.form.id, values: { q0: "500 g" } } }),
      (event) => resumed.push(event),
    );
    const last = second.sent[0]?.messages.at(-1);
    assert.equal(last?.role, "user");
    assert.match(String(last?.content), /My answers to your questions:\n- Which size of Amul butter\? 500 g\n- How many\? \(left blank/);
    assert.equal(second.sent[0]?.tools.includes("compare_basket"), true, "the answers go to Shop Scout, which asked");
    assert.match(JSON.stringify(second.sent[0]?.messages), /get me amul butter/);

    const again: ChatEvent[] = [];
    await runChat(turn({ text: "again", agent: "shop", fetchImpl: second.fetchImpl, memory, answers: { formId: form.form.id, values: { q0: "500 g" } } }), (event) => again.push(event));
    assert.match(again.find((event) => event.type === "question")?.type === "question" ? (again.find((event) => event.type === "question") as { message: string }).message : "", /expired/);
  });

  it("stops Event Scout after it asks, too", async () => {
    const model = sarvam(
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "ask_user", input: { why: "Then I'll search.", questions: [{ prompt: "Which city?", options: ["Delhi", "Mumbai"] }] } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "should not run" }] },
    );
    const events: ChatEvent[] = [];
    await runChat(turn({ text: "find me a standup show", agent: "event", fetchImpl: model.fetchImpl }), (event) => events.push(event));
    assert.equal(model.sent.length, 1);
    assert.equal(events.some((event) => event.type === "form"), true);
    const reply = events.find((event) => event.type === "question");
    assert.match(reply?.type === "question" ? reply.message : "", /A few details first/);
  });

  it("reads the asked questions safely", () => {
    const events: ChatEvent[] = [];
    const ran = askUser("u".repeat(32), "food", {
      why: "",
      questions: [
        { prompt: "Which dish?", options: ["Dosa"] },
        { prompt: "Which dish?", options: ["Idli", "Dosa"] },
        { prompt: "Menu photo?", options: ["a", "b"], photo: true },
        { prompt: "x" },
        { prompt: "Spice level?", options: ["Mild", "Hot", "Hot", "Very hot", "Extra", "Inferno"] },
        { prompt: "Delivery time?" },
        { prompt: "One too many?" },
      ],
    }, (event) => events.push(event));
    assert.equal(ran.ok, true);
    const form = events[0]?.type === "form" ? events[0].form : null;
    assert.deepEqual(form?.questions.map((question) => [question.prompt, question.kind, question.options.length]), [
      ["Which dish?", "text", 0],
      ["Menu photo?", "photo", 0],
      ["Spice level?", "choice", 4],
      ["Delivery time?", "text", 0],
    ]);
    assert.deepEqual(form?.tasks, ["A few details first."]);
    assert.equal(askUser("u".repeat(32), "food", { questions: [] }, () => undefined).ok, false);
    assert.equal(answersMessage([{ id: "q0", prompt: "Which dish?", kind: "text", options: [] }], { q0: "Dosa" }), "My answers to your questions:\n- Which dish? Dosa\nCarry on with the task now.");
  });

  it("turns a prose question with a short list of picks into a form, and leaves other replies alone", () => {
    assert.deepEqual(picksFromProse("Just one last thing — which stylist works for you?\n\n- Noor\n- Asha\n\nPick one and I'll lock it in."), {
      prompt: "Just one last thing — which stylist works for you?",
      options: ["Noor", "Asha"],
      rest: "Just one last thing — which stylist works for you?\n\nPick one and I'll lock it in.",
    });
    assert.deepEqual(picksFromProse("Which showtime?\n1. 6:30 PM\n2. **9:45 PM**")?.options, ["6:30 PM", "9:45 PM"]);
    assert.equal(picksFromProse("Here are three:\n- Comedy night\n- Jazz at Piano Man\n- Open mic\nWant details on one?"), null, "a list before the question is a result, not picks");
    assert.equal(picksFromProse("Which one?\n- Only one"), null);
    assert.equal(picksFromProse("Zepto is cheapest at ₹161."), null);
    assert.deepEqual(picksFromProse("I still need a time for your beard trim. Which slot works — afternoon or evening? Pick one.")?.options, ["afternoon", "evening"]);
    assert.deepEqual(picksFromProse("🍽️ What would you like? We have Masala Dosa, Idli, or Chef Thali."), {
      prompt: "What would you like?",
      options: ["Masala Dosa", "Idli", "Chef Thali"],
      rest: "🍽️ What would you like? We have Masala Dosa, Idli, or Chef Thali.",
    });
    assert.deepEqual(picksFromProse("Do you want Noor or Asha?")?.options, ["Noor", "Asha"]);
    assert.equal(picksFromProse("Want me to compare it on Zepto or Blinkit next time you shop?"), null, "a long lead-in is not a pick list");
    assert.equal(picksFromProse("Zepto has it, and Blinkit or Instamart may too."), null, "no question asked");
    assert.equal(picksFromProse("I checked Luma, District, and BookMyShow. Anything else?"), null);
    assert.equal(picksFromProse("Which do you want?\n- A very long option that is a whole sentence with many words in it\n- B"), null);

    const events: ChatEvent[] = [];
    const reply = askPicks("d".repeat(32), "appointments", "Which stylist?\n- Noor\n- Asha", (event) => events.push(event));
    assert.equal(reply, "Which stylist?");
    assert.deepEqual(events[0]?.type === "form" ? events[0].form.questions : null, [{ id: "q0", prompt: "Which stylist?", kind: "choice", options: ["Noor", "Asha"] }]);
  });

  it("keeps a few forms per user, each answered once, until they expire", () => {
    let now = NOW;
    const forms = new PendingForms(() => now);
    const ask = (agent: "shop" | "food") => ({ kind: "ask" as const, agent, questions: [] });
    forms.save("u1", "a", ask("shop"));
    forms.save("u1", "b", ask("food"));
    assert.equal(forms.take("u2", "a"), null, "another user cannot answer it");
    assert.deepEqual(forms.take("u1", "a"), ask("shop"));
    assert.equal(forms.take("u1", "a"), null);
    for (const id of ["c", "d", "e", "f"]) forms.save("u1", id, ask("shop"));
    assert.equal(forms.take("u1", "b"), null, "the oldest form drops past four");
    now += 31 * 60 * 1000;
    assert.equal(forms.take("u1", "f"), null);
  });

  it("asks if the first shop listing is the one, and keeps it when they say yes", async () => {
    const offer = {
      merchant: "Blinkit" as const,
      title: "Govardhan Pure Cow Ghee 500 ml",
      rupees: 345,
      pageUrl: "https://blinkit.com/",
      ref: { store: "blinkit" as const, productId: "1", link: "https://blinkit.com/prn/ghee/prid/1", name: "Govardhan Pure Cow Ghee 500 ml", size: "500 ml", price: 345, seenAt: 0 },
    };
    const asked: ChatEvent[] = [];
    askShelf("c".repeat(32), offer, "Govardhan Ghee 1L", (event) => asked.push(event));
    const form = asked.find((event) => event.type === "form");
    assert.equal(form?.type === "form" ? form.form.questions[0]?.prompt : "", "Is that what you're looking for?");
    assert.deepEqual(form?.type === "form" ? form.form.questions[0]?.options : [], ["Yes", "No"]);
    const events: ChatEvent[] = [];
    await runChat(turn({ text: "yes", answers: { formId: form?.type === "form" ? form.form.id : "", values: { match: "Yes" } } }), (event) => events.push(event));
    const reply = events.find((event) => event.type === "question");
    assert.match(reply?.type === "question" ? reply.message : "", /Govardhan Pure Cow Ghee 500 ml at ₹345/);
    assert.match(reply?.type === "question" ? reply.message : "", /Say "order"/);
  });

  it("asks which pack when several brands are listed, and keeps the one they pick", async () => {
    const gowardhan = {
      merchant: "Blinkit" as const,
      title: "Gowardhan Pure Cow Ghee | Jar",
      rupees: 439,
      pageUrl: "https://blinkit.com/",
      ref: { store: "blinkit" as const, productId: "1", link: "https://blinkit.com/prn/ghee/prid/1", name: "Gowardhan Pure Cow Ghee | Jar", size: "500 ml", price: 439, seenAt: 0 },
    };
    const patanjali = {
      merchant: "Blinkit" as const,
      title: "Patanjali Cow Ghee (1 l) 1 ltr",
      rupees: 763,
      pageUrl: "https://blinkit.com/",
      ref: { store: "blinkit" as const, productId: "2", link: "https://blinkit.com/prn/ghee/prid/2", name: "Patanjali Cow Ghee (1 l) 1 ltr", size: "1 l", price: 763, seenAt: 0 },
    };
    const asked: ChatEvent[] = [];
    askShelfChoices("c".repeat(32), [gowardhan, patanjali], "govardhan ghee", (event) => asked.push(event));
    const form = asked.find((event) => event.type === "form");
    assert.equal(form?.type === "form" ? form.form.questions[0]?.prompt : "", "Which pack?");
    assert.deepEqual(form?.type === "form" ? form.form.questions[0]?.options : [], ["Gowardhan Pure Cow Ghee | Jar ₹439", "Patanjali Cow Ghee (1 l) 1 ltr ₹763"]);
    const events: ChatEvent[] = [];
    await runChat(turn({ text: "Patanjali", answers: { formId: form?.type === "form" ? form.form.id : "", values: { match: "Patanjali Cow Ghee (1 l) 1 ltr ₹763" } } }), (event) => events.push(event));
    const reply = events.find((event) => event.type === "question");
    assert.match(reply?.type === "question" ? reply.message : "", /Patanjali Cow Ghee \(1 l\) 1 ltr at ₹763/);
  });

  it("hands an errand no specialist owns to Main Scout's own tools", async () => {
    const model = sarvam(
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "phone_action", input: { action: "set_alarm", hour: 7, minute: 0, label: "Gym" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "⏰ Sent a 7 am alarm to your phone." }] },
    );
    const events: ChatEvent[] = [];
    await runAnsweredErrands(
      { errands: [{ kind: "other", summary: "Set an alarm for 7 am called Gym" }] },
      {},
      turn({ text: "set an alarm for 7 am called gym", agent: "main", fetchImpl: model.fetchImpl, phone: { serviceOn: true, apps: {} } }),
      (event) => events.push(event),
      async () => ({ message: "", count: 0, drives: async () => undefined }),
    );
    assert.match(String(model.sent[0]?.messages.at(-1)?.content), /Set an alarm for 7 am called Gym/);
    const device = events.find((event) => event.type === "device");
    assert.equal(device?.type === "device" && device.action.name, "set_alarm");
    const reply = events.filter((event) => event.type === "question");
    assert.equal(reply.length, 1, "only the combined reply is shown");
    assert.match(reply[0]?.type === "question" ? reply[0].message : "", /\*\*1\. Set an alarm for 7 am called Gym:\*\* Sent a 7 am alarm/);
  });
});

function turn(options: Partial<ChatTurn> & { text: string }): ChatTurn {
  return {
    sessionId: "c".repeat(32),
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
    compareBasket: async () => ({ opened: 0, signIn: null, lines: [] }),
    ...options,
  };
}