import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatEvent } from "../src/shared/chatEvents.ts";
import {
  accessibilityReady,
  appHome,
  appInstalled,
  deviceSummary,
  isAppLink,
  needsConfirmation,
  readAppCartResult,
  readAppEventResult,
  readDeviceCommand,
  readPhoneAutomation,
  type AutomationApp,
  type CartStopReason,
  type DeviceCommand,
  type PhoneAutomation,
} from "../src/shared/deviceActions.ts";
import { applyPhoneResult, isPhoneRun, phoneRunFromAction, phoneRunState, stopReasonLine } from "../src/shared/phoneRun.ts";
import type { AgentId } from "../src/shared/hosts.ts";
import { assistantPrompt, assistantTools, runAssistantTool, type AssistantContext } from "../src/server/assistantTools.ts";
import { ChatMemoryStore } from "../src/server/chatMemory.ts";
import { runChat, type ChatTurn } from "../src/server/chatRun.ts";
import { ListingCache } from "../src/server/listingCache.ts";
import { sarvamReply } from "./sarvamReply.ts";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const SHOW = Date.parse("2026-11-01T18:00:00+05:30");
const ID = "a".repeat(24);
const REASONS: readonly CartStopReason[] = [
  "no_match",
  "price_above_limit",
  "out_of_stock",
  "size_mismatch",
  "not_signed_in",
  "no_address",
  "app_missing",
  "service_off",
  "screen_changed",
  "timeout",
  "captcha",
  "user_stopped",
];

describe("app action validation", () => {
  it("accepts a cart and a booking on each store's own https host", () => {
    const cart = readDeviceCommand("app_cart_add", {
      items: [
        item("blinkit", "https://blinkit.com/prn/amul-butter/prid/1"),
        item("blinkit", null, { name: "Milk", size: "1 L", price: 70, maxPrice: 80, quantity: 1 }),
      ],
      allowSimilar: false,
    }, NOW);
    if (!cart.ok) throw new Error(cart.error);
    if (cart.command.name !== "app_cart_add") throw new Error(cart.command.name);
    assert.equal(cart.command.args.items[0]?.ref.link, "https://blinkit.com/prn/amul-butter/prid/1");
    assert.equal(cart.command.args.items[1]?.ref.link, null);
    assert.equal(cart.command.args.items[0]?.ref.price, 285);

    const instamart = readDeviceCommand("app_cart_add", {
      items: [item("instamart", "https://www.swiggy.com/instamart/item/1")],
      allowSimilar: true,
    }, NOW);
    assert.equal(instamart.ok, true);
    assert.equal(readDeviceCommand("app_cart_add", { items: [item("instamart", "https://instamart.in/item/1")], allowSimilar: false }, NOW).ok, true);
    assert.equal(readDeviceCommand("app_cart_add", { items: [item("zepto", "https://www.zepto.com/pn/butter")], allowSimilar: false }, NOW).ok, true);

    const events = [
      ["bookmyshow", "https://in.bookmyshow.com/events/late-show/ET1"],
      ["district", "https://www.district.in/events/late-show"],
      ["luma", "https://luma.com/late-show"],
      ["luma", "https://www.luma.com/late-show"],
      ["luma", "https://lu.ma/late-show"],
      ["luma", "https://www.lu.ma/late-show"],
    ] as const;
    for (const [app, link] of events) assert.equal(readDeviceCommand("app_event_book", booking(link, { app }), NOW).ok, true, link);
    assert.equal(readDeviceCommand("app_cart_add", { items: [item("instamart", "https://swiggy.com/instamart")], allowSimilar: false }, NOW).ok, true);
    assert.equal(readDeviceCommand("app_cart_add", { items: [item("instamart", "https://www.instamart.in/item/1")], allowSimilar: false }, NOW).ok, true);
    assert.equal(readDeviceCommand("app_event_book", booking("https://lu.ma/free", { app: "luma", price: 0, maxPricePerTicket: null, tickets: 1, seat: "user_picks", showtime: null, venue: null, startsAt: null }), NOW).ok, true);
  });

  it("rejects a cart or booking that breaks the limits", () => {
    assert.equal(readDeviceCommand("app_cart_add", { items: [], allowSimilar: false }, NOW).ok, false);
    assert.equal(readDeviceCommand("app_cart_add", { items: Array.from({ length: 11 }, () => item("blinkit", null)), allowSimilar: false }, NOW).ok, false);
    assert.equal(readDeviceCommand("app_cart_add", { items: [item("blinkit", null), item("zepto", "https://www.zepto.com/pn/x")], allowSimilar: false }, NOW).ok, false);
    assert.equal(readDeviceCommand("app_cart_add", { items: [item("blinkit", null, { quantity: 0 })], allowSimilar: false }, NOW).ok, false);
    assert.equal(readDeviceCommand("app_cart_add", { items: [item("blinkit", null, { quantity: 21 })], allowSimilar: false }, NOW).ok, false);
    assert.equal(readDeviceCommand("app_cart_add", { items: [item("blinkit", null, { quantity: 1.5 })], allowSimilar: false }, NOW).ok, false);
    assert.equal(readDeviceCommand("app_cart_add", { items: [item("blinkit", null, { maxPrice: 0 })], allowSimilar: false }, NOW).ok, false);
    assert.equal(readDeviceCommand("app_cart_add", { items: [item("blinkit", null, { maxPrice: -1 })], allowSimilar: false }, NOW).ok, false);
    assert.equal(readDeviceCommand("app_cart_add", { items: [item("blinkit", null, { maxPrice: 100_001 })], allowSimilar: false }, NOW).ok, false);
    assert.equal(readDeviceCommand("app_cart_add", { items: [item("blinkit", null, { maxPrice: "290" })], allowSimilar: false }, NOW).ok, false);
    assert.equal(readDeviceCommand("app_cart_add", { items: [item("blinkit", null)] }, NOW).ok, false);
    assert.equal(readDeviceCommand("app_cart_add", { items: [item("blinkit", null, { name: "<script>alert(1)</script>" })], allowSimilar: false }, NOW).ok, false);
    assert.equal(readDeviceCommand("app_cart_add", { items: [item("blinkit", null, { name: "javascript:alert(1)" })], allowSimilar: false }, NOW).ok, false);
    assert.equal(readDeviceCommand("app_cart_add", { items: [item("blinkit", null, { seenAt: NOW + 6 * 60_000 })], allowSimilar: false }, NOW).ok, false);
    assert.equal(readDeviceCommand("app_cart_add", { items: [item("blinkit", null, { seenAt: NOW + 5 * 60_000 })], allowSimilar: false }, NOW).ok, true);
    assert.equal(readDeviceCommand("app_event_book", booking("https://in.bookmyshow.com/e/1", { tickets: 0 }), NOW).ok, false);
    assert.equal(readDeviceCommand("app_event_book", booking("https://in.bookmyshow.com/e/1", { tickets: 11 }), NOW).ok, false);
    assert.equal(readDeviceCommand("app_event_book", booking("https://in.bookmyshow.com/e/1", { seat: "middle" }), NOW).ok, false);
    assert.equal(readDeviceCommand("app_event_book", booking("https://in.bookmyshow.com/e/1", { maxPricePerTicket: 0 }), NOW).ok, false);
    assert.equal(readDeviceCommand("app_event_book", booking("https://in.bookmyshow.com/e/1", { showtime: NOW - 60 * 60_000 - 1 }), NOW).ok, false);
    assert.equal(readDeviceCommand("app_event_book", booking("https://in.bookmyshow.com/e/1", { showtime: NOW + 366 * 24 * 60 * 60_000 + 1 }), NOW).ok, false);
    assert.equal(readDeviceCommand("app_event_book", booking("https://in.bookmyshow.com/e/1", { link: null }), NOW).ok, false);
  });

  it("rejects http, the wrong host, and lookalikes", () => {
    const rejected = [
      ["blinkit", "http://blinkit.com/prn/x"],
      ["blinkit", "https://www.blinkit.com/prn/x"],
      ["blinkit", "https://evil.blinkit.com/prn/x"],
      ["blinkit", "https://blinkit.com.evil.com/prn/x"],
      ["blinkit", "https://blinkit.com./prn/x"],
      ["blinkit", "https://blinkit.com%2eevil.com/prn/x"],
      ["blinkit", "https://user:pass@blinkit.com/prn/x"],
      ["blinkit", "https://blinkit.com:444/prn/x"],
      ["blinkit", "javascript:https://blinkit.com/prn/x"],
      ["blinkit", "intent://blinkit.com#Intent;scheme=https;end"],
      ["blinkit", "https://blinkit.com\\@evil.com/prn/x"],
      ["blinkit", "https://blinkit.com/prn/x\n"],
      ["zepto", "https://zepto.com/pn/x"],
      ["zepto", "https://www.zeptonow.com/pn/x"],
      ["instamart", "https://food.swiggy.com/instamart"],
      ["instamart", "https://www.swiggy.com.evil.com/instamart"],
      ["bookmyshow", "https://www.bookmyshow.com/events/x"],
      ["bookmyshow", "https://bookmyshow.com/events/x"],
      ["bookmyshow", "https://evil.in.bookmyshow.com/events/x"],
      ["bookmyshow", "http://in.bookmyshow.com/events/x"],
      ["district", "https://district.in/events/x"],
      ["district", "https://www.district.in.evil.com/events/x"],
      ["luma", "https://evil.luma.com/x"],
      ["luma", "https://luma.com.evil.com/x"],
      ["luma", "https://evil.lu.ma/x"],
    ] as const;
    for (const [app, link] of rejected) {
      assert.equal(isAppLink(app, link), false, link);
      const read = app === "blinkit" || app === "zepto" || app === "instamart"
        ? readDeviceCommand("app_cart_add", { items: [item(app, link)], allowSimilar: false }, NOW)
        : readDeviceCommand("app_event_book", booking(link, { app }), NOW);
      assert.equal(read.ok, false, link);
    }
    assert.equal(isAppLink("blinkit", "https://BLINKIT.COM/prn/x"), true);
    assert.equal(isAppLink("blinkit", "https://blinkit.com/s/?q=amul%20butter"), true);
    assert.equal(isAppLink("zepto", "https://www.zepto.com/search?query=amul%20butter"), true);
    assert.equal(isAppLink("blinkit", `https://blinkit.com/${"a".repeat(500)}`), false);
    for (const app of ["blinkit", "zepto", "instamart", "bookmyshow", "district", "luma"] as const) {
      assert.equal(isAppLink(app, appHome(app)), true, app);
    }
  });
});

describe("app action summaries", () => {
  it("describes the cart and the booking, and both always ask for Allow", () => {
    const cart = command("app_cart_add", {
      items: [item("blinkit", "https://blinkit.com/prn/amul-butter/prid/1"), item("blinkit", null, { name: "Milk", size: "1 L", price: 70, maxPrice: 80, quantity: 1 })],
      allowSimilar: true,
    });
    assert.equal(deviceSummary(cart), "Add 2 items to your Blinkit cart: 2 × Amul Butter 500 g (up to ₹290), 1 × Milk 1 L (up to ₹80)");
    assert.equal(needsConfirmation(cart), true);
    const one = command("app_cart_add", { items: [item("blinkit", null, { name: "Amul Butter 500 g", size: "500 g" })], allowSimilar: false });
    assert.equal(deviceSummary(one), "Add 2 × Amul Butter 500 g to your Blinkit cart (up to ₹290 each)");
    assert.equal(needsConfirmation(one), true);
    const longName = "a".repeat(100);
    const long = command("app_cart_add", {
      items: [item("blinkit", null, { name: longName }), item("blinkit", null, { name: longName, quantity: 1 })],
      allowSimilar: false,
    });
    assert.equal(deviceSummary(long).length, 200);
    assert.equal(deviceSummary(long).endsWith("…"), true);

    const booked = command("app_event_book", booking("https://in.bookmyshow.com/events/late-show/ET1"));
    assert.equal(deviceSummary(booked), "Open Late Show on BookMyShow and stop before payment");
    assert.equal(needsConfirmation(booked), true);
    const pick = command("app_event_book", booking("https://lu.ma/open-mic", { app: "luma", title: "Open Mic", venue: null, tickets: 1, maxPricePerTicket: null, seat: "user_picks", showtime: null, startsAt: null }));
    assert.equal(deviceSummary(pick), "Open Open Mic on Luma and stop before payment");
    assert.equal(needsConfirmation(command("set_alarm", { hour: 7, minute: 0, label: "" })), false);
    assert.equal(needsConfirmation(command("set_volume", { stream: "ring", percent: 0 })), true);
  });
});

describe("phone result parsers", () => {
  it("clamps prices, tickets, and text the phone reports", () => {
    const cart = readAppCartResult({
      store: "blinkit",
      pin: "1234",
      added: [
        { name: "<b>Amul Butter</b>", size: "500 g", quantity: 2.2, unitPrice: 285.129, lineTotal: 570 },
        { name: "x".repeat(200), quantity: 1_000, unitPrice: -5, lineTotal: 2_000_000 },
        ...Array.from({ length: 25 }, () => ({ name: "Extra", quantity: 1 })),
      ],
      cart: { itemsTotal: 570, handling: "4", delivery: -1, otherFees: Number.POSITIVE_INFINITY, grandTotal: 9e9, secret: "cvv" },
      stoppedAt: `pay\n<script>${"z".repeat(100)}`,
      reason: "pay_now",
      seen: { name: "Amul Butter", size: "100 g", price: 9e9, inStock: "yes" },
    });
    assert.ok(cart);
    assert.equal("pin" in cart, false);
    assert.equal(cart.added.length, 20);
    assert.deepEqual(cart.added[0], { name: "b Amul Butter /b", size: "500 g", quantity: 2, unitPrice: 285.13, lineTotal: 570 });
    assert.equal(cart.added[1]?.name.length, 120);
    assert.equal(cart.added[1]?.quantity, 99);
    assert.equal(cart.added[1]?.unitPrice, null);
    assert.equal(cart.added[1]?.lineTotal, 1_000_000);
    assert.deepEqual(cart.cart, { itemsTotal: 570, handling: null, delivery: null, otherFees: null, grandTotal: 1_000_000 });
    assert.equal(cart.cart && "secret" in cart.cart, false);
    assert.equal(cart.reason, null);
    assert.equal(cart.stoppedAt?.includes("<"), false);
    assert.equal(cart.stoppedAt?.length, 80);
    assert.deepEqual(cart.seen, { name: "Amul Butter", size: "100 g", price: 1_000_000, inStock: null });
    assert.notEqual(readAppCartResult({ store: "blinkit", seen: {} }), null);
    assert.equal(readAppCartResult({ store: "blinkit", seen: {} })?.seen, null);
    assert.equal(readAppCartResult({ store: "amazon", added: [] }), null);
    assert.equal(readAppCartResult({ store: "blinkit", reason: "out_of_stock" })?.reason, "out_of_stock");

    const seats = ["A1", "B".repeat(40), "<i>", ...Array.from({ length: 12 }, (_, index) => `S${index}`)];
    const event = readAppEventResult({
      app: "bookmyshow",
      tickets: 99.4,
      showtime: Number.MAX_VALUE,
      seats,
      total: -20,
      stoppedAt: "seat map",
      reason: "<script>alert(1)</script>",
      card: "4111",
    });
    assert.ok(event);
    assert.equal("card" in event, false);
    assert.equal(event.tickets, 10);
    assert.equal(event.showtime, null);
    assert.equal(event.seats?.length, 10);
    assert.equal(event.seats?.[1]?.length, 16);
    assert.equal(event.seats?.includes("<script>"), false);
    assert.equal(event.total, null);
    assert.equal(event.reason?.includes("<"), false);
    assert.equal(readAppEventResult({ app: "bookmyshow", tickets: 0.2, showtime: SHOW })?.tickets, 1);
    assert.equal(readAppEventResult({ app: "bookmyshow", showtime: SHOW })?.showtime, SHOW);
    assert.equal(readAppEventResult({ app: "bookmyshow", showtime: "2026-11-01T18:00:00+05:30" })?.showtime, null);
    assert.equal(readAppEventResult({ app: "blinkit", tickets: 2 }), null);
    assert.equal(readAppEventResult({ app: "luma", seats: "A1" })?.seats, null);
  });

  it("reads only a real automation report", () => {
    const phone = readPhoneAutomation({
      serviceOn: true,
      apps: {
        blinkit: { installed: true, version: "v".repeat(40) },
        zepto: { installed: false, version: null },
        amazon: { installed: true, version: "1" },
      },
    });
    assert.deepEqual(phone, { serviceOn: true, apps: { blinkit: { installed: true, version: "v".repeat(32) }, zepto: { installed: false, version: null } } });
    assert.equal(readPhoneAutomation({ serviceOn: "yes", apps: {} }), null);
    assert.equal(readPhoneAutomation({ flashlight: true }), null);
    assert.equal(appInstalled(phone, "blinkit"), true);
    assert.equal(appInstalled(phone, "zepto"), false);
    assert.equal(appInstalled({ serviceOn: false, apps: { district: { installed: true, version: "1" } } }, "district"), true);
    const off = { serviceOn: false, apps: {} };
    assert.equal(accessibilityReady(true, off), false);
    assert.equal(accessibilityReady(true, { serviceOn: true, apps: {} }), true);
    assert.equal(accessibilityReady(false, off), true);
    assert.equal(accessibilityReady(true, null), true);
  });
});

describe("phone run cards", () => {
  it("moves from waiting through added, needs your OK, stopped, and handed", () => {
    const action = {
      ...command("app_cart_add", { items: [item("blinkit", "https://blinkit.com/prn/amul-butter/prid/1")], allowSimilar: false }),
      id: ID,
      summary: "Add butter",
      confirm: true,
      expiresAt: NOW + 1,
    };
    const sent = phoneRunFromAction(action);
    assert.ok(sent);
    assert.equal(phoneRunState(sent), "waiting");
    assert.equal(isPhoneRun(sent), true);
    assert.equal(phoneRunState(applyPhoneResult(sent, { id: ID, status: "completed", message: "In the cart." })), "added");
    const mismatch = applyPhoneResult(sent, { id: ID, status: "needs_approval", message: "Price moved.", data: { store: "blinkit", reason: "price_above_limit", seen: { name: "Amul Butter", price: 299, inStock: true } } });
    assert.equal(phoneRunState(mismatch), "needs_ok");
    assert.equal(mismatch.cart?.seen?.price, 299);
    assert.equal(phoneRunState(applyPhoneResult(sent, { id: ID, status: "needs_approval", message: "Still looking.", data: { store: "blinkit", reason: "no_match" } })), "waiting");
    assert.equal(phoneRunState(applyPhoneResult(sent, { id: ID, status: "failed", message: "Stopped.", data: { store: "blinkit", reason: "not_signed_in", stoppedAt: "sign in" } })), "stopped");
    assert.equal(phoneRunState(applyPhoneResult(sent, { id: ID, status: "needs_permission", message: "Allow accessibility." })), "stopped");
    assert.equal(phoneRunState(applyPhoneResult(sent, { id: ID, status: "handoff_started", message: "Seat map is yours." })), "handed");
    assert.equal(applyPhoneResult(sent, { id: "b".repeat(24), status: "completed", message: "nope" }), sent);
    const wrongStore = applyPhoneResult(mismatch, { id: ID, status: "completed", message: "done", data: { store: "zepto", added: [{ name: "Other", quantity: 1 }] } });
    assert.equal(wrongStore.cart?.store, "blinkit");
    assert.equal(wrongStore.status, "completed");

    const show = phoneRunFromAction({
      ...command("app_event_book", booking("https://in.bookmyshow.com/events/late-show/ET1")),
      id: ID,
      summary: "Pick tickets",
      confirm: true,
      expiresAt: NOW + 1,
    });
    assert.ok(show);
    assert.equal(phoneRunState(applyPhoneResult(show, { id: ID, status: "needs_approval", message: "Sold out.", data: { app: "bookmyshow", reason: "Only a different show is left.", total: 900 } })), "needs_ok");
    assert.equal(phoneRunState(applyPhoneResult(show, { id: ID, status: "completed", message: "Tickets held.", data: { app: "bookmyshow", tickets: 2, total: 1000 } })), "added");
    for (const reason of REASONS) assert.equal(stopReasonLine(reason, "zepto").length > 0, true);
    assert.match(stopReasonLine("not_signed_in", "blinkit"), /Blinkit/);
    assert.equal(isPhoneRun({ ...sent, link: "https://www.blinkit.com/" }), false);
    assert.equal(isPhoneRun({ ...sent, app: "bookmyshow", link: "https://in.bookmyshow.com/" }), false);
    assert.equal(isPhoneRun({ ...sent, event: { app: "bookmyshow", tickets: 1, showtime: null, seats: null, total: null, stoppedAt: null, reason: null } }), false);
    assert.equal(isPhoneRun({ ...sent, message: "m".repeat(301) }), false);
  });
});

describe("agent gating", () => {
  it("offers the phone tool only when that app is installed and the service is on", () => {
    assert.deepEqual(toolNames(assistantTools(context("shop"))), ["ask_user", "phone_action"]);
    assert.match(assistantPrompt(context("shop")), /cannot drive the Blinkit, Zepto, Instamart/);
    assert.match(assistantPrompt(context("shop")), /buy_from_shop/);
    const blinkit = context("shop", phone({ blinkit: true }));
    assert.deepEqual(toolNames(assistantTools(blinkit)), ["ask_user", "phone_action", "app_cart_add"]);
    assert.deepEqual(storeEnum(assistantTools(blinkit)), ["blinkit"]);
    assert.match(assistantPrompt(blinkit), /call app_cart_add instead of buy_from_shop/);
    assert.match(assistantPrompt(blinkit), /cannot drive the Zepto, Instamart/);
    assert.deepEqual(storeEnum(assistantTools(context("shop", phone({ blinkit: true, zepto: true })))), ["blinkit", "zepto"]);
    assert.deepEqual(toolNames(assistantTools(context("shop", { serviceOn: false, apps: { blinkit: { installed: true, version: "1" } } }))), ["ask_user", "phone_action"]);
    assert.deepEqual(toolNames(assistantTools(context("event", phone({ luma: true, bookmyshow: true })))), ["ask_user", "phone_action", "app_event_book"]);
    assert.deepEqual(eventEnum(assistantTools(context("event", phone({ bookmyshow: true })))), ["bookmyshow"]);
    assert.match(assistantPrompt(context("event")), /give them the listing link/);
    assert.match(assistantPrompt(context("event", phone({ luma: true }))), /call app_event_book instead of register_event/);
    assert.deepEqual(toolNames(assistantTools(context("food", phone({ blinkit: true, luma: true })))), ["ask_user", "phone_action"]);
    assert.equal(toolNames(assistantTools(context("shop", phone({ luma: true })))).includes("app_event_book"), false);
    assert.equal(toolNames(assistantTools(context("event", phone({ blinkit: true })))).includes("app_cart_add"), false);
  });

  it("sends the action for Allow, or a hand-off link when the phone cannot drive the app", async () => {
    const ready = context("shop", phone({ blinkit: true }));
    const sent: ChatEvent[] = [];
    const ok = await runAssistantTool(ready, "app_cart_add", { items: [item("blinkit", "https://blinkit.com/prn/amul-butter/prid/1")], allowSimilar: false }, (event) => sent.push(event));
    assert.equal(ok.ok, true);
    assert.match(ok.content, /tap Allow/);
    assert.equal(sent[0]?.type, "device");
    if (sent[0]?.type !== "device") return;
    assert.equal(sent[0].action.name, "app_cart_add");
    assert.equal(sent[0].action.confirm, true);

    const handed: ChatEvent[] = [];
    const off = await runAssistantTool(context("shop", { serviceOn: false, apps: { blinkit: { installed: true, version: "1" } } }), "app_cart_add", { items: [item("blinkit", "https://blinkit.com/prn/amul-butter/prid/1")], allowSimilar: false }, (event) => handed.push(event));
    assert.equal(off.ok, false);
    assert.match(off.content, /https:\/\/blinkit\.com\/prn\/amul-butter\/prid\/1/);
    assert.equal(handed.length, 0);
    const missing = await runAssistantTool(ready, "app_cart_add", { items: [item("zepto", "https://www.zepto.com/pn/butter")], allowSimilar: false }, () => undefined);
    assert.match(missing.content, /https:\/\/www\.zepto\.com\/pn\/butter/);
    const hostile = await runAssistantTool(ready, "app_cart_add", { items: [item("blinkit", "https://www.blinkit.com/prn/x")], allowSimilar: false }, () => undefined);
    assert.equal(hostile.ok, false);
    assert.equal(hostile.content.includes("www.blinkit.com"), false);
    const wrongScout = await runAssistantTool(context("event", phone({ blinkit: true })), "app_cart_add", { items: [item("blinkit", "https://blinkit.com/prn/amul-butter/prid/1")], allowSimilar: false }, () => undefined);
    assert.equal(wrongScout.ok, false);
    assert.match(wrongScout.content, /cannot run that phone action/);
    const sneaked = await runAssistantTool(ready, "phone_action", { action: "app_cart_add", items: [] }, () => undefined);
    assert.equal(sneaked.ok, false);
    assert.match(sneaked.content, /Use the app_cart_add tool/);
  });

  it("keeps buy_from_shop on Shop Scout when the phone can add to a cart", async () => {
    let names: string[] = [];
    let system = "";
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        tools?: { function?: { name?: string } }[];
        messages?: { role?: string; content?: unknown }[];
      };
      names = (body.tools ?? []).map((tool) => tool.function?.name ?? "");
      const systemMessage = body.messages?.find((message) => message.role === "system");
      system = typeof systemMessage?.content === "string" ? systemMessage.content : "";
      return Response.json(sarvamReply({ stop_reason: "end_turn", content: [{ type: "text", text: "Blinkit can add it on your phone." }] }));
    };
    await runChat(turn("shop", fetchImpl, phone({ blinkit: true })), () => undefined);
    assert.deepEqual(names, ["compare_shops", "compare_basket", "order_basket", "buy_from_shop", "shop_catalog", "ask_user", "phone_action", "app_cart_add"]);
    assert.match(system, /buy_from_shop/);
    assert.match(system, /app_cart_add/);

    await runChat(turn("shop", fetchImpl, { serviceOn: true, apps: {} }), () => undefined);
    assert.deepEqual(names, ["compare_shops", "compare_basket", "order_basket", "buy_from_shop", "shop_catalog", "ask_user", "phone_action"]);
    assert.equal(names.includes("app_cart_add"), false);

    await runChat(turn("event", fetchImpl, phone({ bookmyshow: true })), () => undefined);
    assert.equal(names.includes("register_event"), true);
    assert.equal(names.includes("app_event_book"), true);
    assert.equal(names.includes("app_cart_add"), false);
  });
});

function item(store: "blinkit" | "zepto" | "instamart", link: string | null, patch: Record<string, unknown> = {}): Record<string, unknown> {
  const ref = {
    store,
    productId: "p1",
    link,
    name: "Amul Butter",
    size: "500 g",
    price: 285,
    seenAt: NOW,
    ...("name" in patch || "size" in patch || "price" in patch || "seenAt" in patch || "productId" in patch ? pickRef(patch) : {}),
  };
  return { ref, quantity: patch.quantity ?? 2, ...(patch.maxPrice === undefined ? { maxPrice: 290 } : { maxPrice: patch.maxPrice }) };
}

function pickRef(patch: Record<string, unknown>): Record<string, unknown> {
  const ref: Record<string, unknown> = {};
  for (const key of ["name", "size", "price", "seenAt", "productId"]) {
    if (key in patch) ref[key] = patch[key];
  }
  return ref;
}

function booking(link: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: {
      app: patch.app ?? "bookmyshow",
      eventId: "ET1",
      link: "link" in patch ? patch.link : link,
      title: patch.title ?? "Late Show",
      venue: "venue" in patch ? patch.venue : "Hall One",
      startsAt: "startsAt" in patch ? patch.startsAt : SHOW,
      price: "price" in patch ? patch.price : 500,
    },
    tickets: patch.tickets ?? 2,
    maxPricePerTicket: "maxPricePerTicket" in patch ? patch.maxPricePerTicket : 500,
    seat: patch.seat ?? "best_available",
    showtime: "showtime" in patch ? patch.showtime : SHOW,
  };
}

function command(name: DeviceCommand["name"], args: unknown): DeviceCommand {
  const read = readDeviceCommand(name, args, NOW);
  if (!read.ok) throw new Error(read.error);
  return read.command;
}

function context(agent: AgentId, phoneReport?: PhoneAutomation): AssistantContext {
  return { userId: "u".repeat(32), agent, now: () => NOW, timezone: "Asia/Kolkata", ...(phoneReport ? { phone: phoneReport } : {}) };
}

function phone(installed: Partial<Record<AutomationApp, boolean>>): PhoneAutomation {
  const apps: PhoneAutomation["apps"] = {};
  for (const [app, on] of Object.entries(installed)) apps[app as AutomationApp] = { installed: on === true, version: on ? "1" : null };
  return { serviceOn: true, apps };
}

function toolNames(tools: readonly Record<string, unknown>[]): string[] {
  return tools.map((tool) => String(tool.name));
}

function storeEnum(tools: readonly Record<string, unknown>[]): string[] | null {
  return nestedEnum(tools, "app_cart_add", ["properties", "items", "items", "properties", "ref", "properties", "store", "enum"]);
}

function eventEnum(tools: readonly Record<string, unknown>[]): string[] | null {
  return nestedEnum(tools, "app_event_book", ["properties", "ref", "properties", "app", "enum"]);
}

function nestedEnum(tools: readonly Record<string, unknown>[], name: string, path: readonly string[]): string[] | null {
  let cursor: unknown = (tools.find((tool) => tool.name === name) ?? {}).input_schema;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return Array.isArray(cursor) ? cursor.map(String) : null;
}

function turn(agent: ChatTurn["agent"], fetchImpl: typeof fetch, phoneReport: PhoneAutomation): ChatTurn {
  return {
    sessionId: "c".repeat(32),
    text: "add the butter",
    timezone: "Asia/Kolkata",
    pincode: "",
    lat: null,
    lon: null,
    timeoutMs: 1000,
    signal: new AbortController().signal,
    now: () => NOW,
    memory: new ChatMemoryStore(),
    cache: new ListingCache(60_000, () => NOW),
    fetchImpl,
    mapsApiKey: "",
    sarvamApiKey: "test-key",
    agent,
    phone: phoneReport,
  };
}
