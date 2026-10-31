import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatEvent } from "../src/shared/chatEvents.ts";
import type { EventKind, Listing } from "../src/shared/event.ts";
import { readDeviceCommand, readDeviceResult } from "../src/shared/deviceActions.ts";
import { ChatMemoryStore } from "../src/server/chatMemory.ts";
import { runChat, type ChatTurn } from "../src/server/chatRun.ts";
import { ListingCache } from "../src/server/listingCache.ts";
import { InboxStore } from "../src/server/notify/inbox.ts";
import { Notifier } from "../src/server/notify/notifier.ts";
import { ProfileStore, profilePrompt } from "../src/server/profile/profileStore.ts";
import type { EventTool } from "../src/server/tools/types.ts";
import { readCompletion, readVoiceTicket, signVoiceTicket, spokenText } from "../src/server/voice/bolna.ts";
import { WatchRunner } from "../src/server/watch/watchRunner.ts";
import { WatchStore } from "../src/server/watch/watchStore.ts";
import { parseSse, withApi } from "./helpers.ts";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const USER = "b".repeat(32);

describe("shared profile", () => {
  it("keeps explicit preferences over guesses and refuses secrets", () => {
    const profile = new ProfileStore(":memory:");
    assert.equal(profile.set(USER, "city", "delhi", "explicit", NOW).ok, true);
    profile.set(USER, "city", "mumbai", "inferred", NOW + 1);
    assert.equal(profile.get(USER, "city")?.value, "delhi");
    assert.equal(profile.set(USER, "routine", "my UPI PIN is 1234", "explicit", NOW).ok, false);
    assert.equal(profile.set(USER, "routine", "card 4111 1111 1111 1111", "explicit", NOW).ok, false);
    assert.equal(profile.set(USER, "budget_rupees", "five hundred", "explicit", NOW).ok, false);
    profile.set(USER, "event_kinds", "comedy", "inferred", NOW);
    const prompt = profilePrompt(profile.list(USER));
    assert.match(prompt, /Preferences they set: city=delhi/);
    assert.match(prompt, /Guesses from earlier chats: event_kinds=comedy/);
    assert.equal(profile.remove(USER, "city"), true);
    assert.equal(profile.get(USER, "city"), null);
  });

  it("lets any specialist save a preference through Haiku", async () => {
    const profile = new ProfileStore(":memory:");
    const events = await speak({
      agent: "food",
      text: "I am vegetarian, remember that",
      profile,
      replies: [
        { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "remember_preference", input: { key: "diet", value: "vegetarian" } }] },
        { stop_reason: "end_turn", content: [{ type: "text", text: "Noted, vegetarian." }] },
      ],
    });
    assert.equal(profile.get(USER, "diet")?.value, "vegetarian");
    assert.equal(profile.get(USER, "diet")?.source, "explicit");
    assert.equal(events.some((event) => event.type === "note" && event.message.includes("vegetarian")), true);
  });
});

describe("phone actions", () => {
  it("validates commands against the allowlist", () => {
    assert.equal(readDeviceCommand("set_alarm", { hour: 7, minute: 30 }, NOW).ok, true);
    assert.equal(readDeviceCommand("set_alarm", { hour: 25, minute: 0 }, NOW).ok, false);
    assert.equal(readDeviceCommand("open_app", { app: "com.evil.app" }, NOW).ok, false);
    assert.equal(readDeviceCommand("run_intent", { action: "android.intent.action.CALL" }, NOW).ok, false);
    assert.equal(readDeviceCommand("share_text", { text: "intent:#Intent;end" }, NOW).ok, false);
    assert.equal(readDeviceCommand("create_reminder", { title: "Show", at: "2026-10-31T10:00:00+05:30" }, NOW).ok, false);
    const reminder = readDeviceCommand("create_reminder", { title: "Leave for the show", at: "2026-11-01T18:00:00+05:30" }, NOW);
    assert.equal(reminder.ok && reminder.command.name === "create_reminder" && reminder.command.args.at, Date.parse("2026-11-01T18:00:00+05:30"));
    assert.equal(readDeviceResult({ op: "action", id: "c".repeat(24), status: "handoff_started", message: "Clock app opened." })?.status, "handoff_started");
    assert.equal(readDeviceResult({ id: "c".repeat(24), status: "done" }), null);
  });

  it("emits a device event with a short-lived id instead of claiming success", async () => {
    const events = await speak({
      agent: "main",
      text: "Wake me at 6:45",
      replies: [
        { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "phone_action", input: { action: "set_alarm", hour: 6, minute: 45, label: "Wake up" } }] },
        { stop_reason: "end_turn", content: [{ type: "text", text: "Sent an alarm for 6:45 to your phone." }] },
      ],
    });
    const device = events.find((event) => event.type === "device");
    assert.equal(device?.type, "device");
    if (device?.type !== "device") return;
    assert.equal(device.action.name, "set_alarm");
    assert.match(device.action.id, /^[a-f0-9]{24}$/);
    assert.equal(device.action.expiresAt > NOW, true);
  });
});

describe("scout watch", () => {
  it("survives a reopen, notifies only new matches, and leases due work once", async () => {
    const store = new WatchStore(":memory:");
    const inbox = new InboxStore(":memory:");
    const created = store.create(USER, { cityId: "delhi", kind: "comedy", when: "weekend", budget: 500, query: "" }, NOW);
    assert.equal(created.ok, true);
    let listings = [listing("Late Night Laughs", "https://lu.ma/laughs", 400), listing("Pricey Gala", "https://lu.ma/gala", 2000)];
    const runner = new WatchRunner({
      store,
      notifier: new Notifier(inbox, null, () => NOW),
      tools: [fakeTool(() => listings)],
      cache: new ListingCache(1, () => NOW),
      fetchImpl: fetch,
      pomeradoApiKey: "",
      timeoutMs: 1000,
      now: () => NOW,
    });
    const first = await runner.tick();
    assert.equal(first.length, 1);
    assert.deepEqual(first[0]?.fresh.map((item) => item.title), ["Late Night Laughs"]);
    assert.equal(inbox.list(USER).length, 1);
    assert.equal(store.claimDue(NOW, 5).length, 0);
    listings = [...listings, listing("Open Mic Sunday", "https://lu.ma/openmic", 0)];
    const watch = store.list(USER)[0];
    assert.ok(watch);
    const second = await runner.check(watch);
    assert.deepEqual(second.fresh.map((item) => item.title), ["Open Mic Sunday"]);
    assert.equal(inbox.list(USER).length, 2);
    assert.equal(store.update(USER, watch.id, { status: "paused" }, NOW).ok, true);
    assert.equal(store.claimDue(NOW + 10 * 3_600_000, 5).length, 0);
  });
});

describe("bolna voice", () => {
  it("signs a per-user ticket and reads it back from the system prompt", () => {
    const key = "k".repeat(64);
    const ticket = signVoiceTicket({ userId: USER, agent: "event" }, key, NOW);
    assert.equal(readVoiceTicket(ticket, key, NOW)?.userId, USER);
    assert.equal(readVoiceTicket(ticket, "x".repeat(64), NOW), null);
    assert.equal(readVoiceTicket(ticket, key, NOW + 60 * 60_000), null);
    const parsed = readCompletion({
      stream: true,
      messages: [
        { role: "system", content: `You are Scout. scout_ticket: ${ticket}` },
        { role: "user", content: "kal Delhi mein comedy show batao" },
      ],
    }, key, NOW);
    assert.equal(parsed?.ticket?.agent, "event");
    assert.equal(parsed?.text, "kal Delhi mein comedy show batao");
    assert.equal(spokenText("🎭 **Show** at ₹499 https://lu.ma/x"), "Show at rupees 499 the link on screen");
  });

  it("streams Scout's own reply as OpenAI chunks and relays cards to the open chat", async () => {
    const key = "k".repeat(64);
    const ticket = signVoiceTicket({ userId: USER, agent: "main" }, key, Date.now());
    const fetchImpl = haikuFetch([{ stop_reason: "end_turn", content: [{ type: "text", text: "Namaste! Kya dhoondhun?" }] }]);
    await withApi({ bolna: { apiKey: "bn-test", agentId: "agent", llmKey: key }, anthropicApiKey: "test-key", fetchImpl }, async (base) => {
      const denied = await fetch(`${base}/api/bolna/v1/chat/completions`, { method: "POST", body: "{}" });
      assert.equal(denied.status, 401);
      const response = await fetch(`${base}/api/bolna/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "scout", stream: true, messages: [{ role: "system", content: `scout_ticket: ${ticket}` }, { role: "user", content: "hello" }] }),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /data: \[DONE\]/);
      const chunks = parseSse<{ choices?: { delta?: { content?: string } }[] }>(text.replace("data: [DONE]", ""));
      const spoken = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? "").join("");
      assert.match(spoken, /Namaste! Kya dhoondhun\?/);
    });
  });
});

function listing(title: string, url: string, rupees: number): Listing {
  return {
    id: url,
    title,
    url,
    kind: "comedy" as EventKind,
    start: "2026-11-01T14:30:00.000Z",
    venue: "Delhi",
    city: "delhi",
    price: rupees === 0 ? { min: 0, max: 0, currency: "INR", provenance: "free" } : { min: rupees, max: rupees, currency: "INR", provenance: "listed" },
    source: "Luma",
    retrievedAt: new Date(NOW).toISOString(),
  } as unknown as Listing;
}

function fakeTool(rows: () => Listing[]): EventTool {
  return { name: "Luma", load: async () => ({ name: "Luma", ok: true, message: "ok", listings: rows(), warnings: [] }) };
}

function haikuFetch(replies: unknown[]): typeof fetch {
  let index = 0;
  return (async () => {
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return Response.json(reply);
  }) as typeof fetch;
}

async function speak(options: { agent: ChatTurn["agent"]; text: string; replies: unknown[]; profile?: ProfileStore }): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  const turn: ChatTurn = {
    sessionId: USER,
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
    fetchImpl: haikuFetch(options.replies),
    mapsApiKey: "",
    pomeradoApiKey: "",
    anthropicApiKey: "test-key",
    agent: options.agent,
    ...(options.profile ? { profile: options.profile } : {}),
  };
  await runChat(turn, (event) => events.push(event));
  return events;
}
