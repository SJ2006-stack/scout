import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMockSalon } from "../src/server/appointments/mock.ts";
import { CommerceHub } from "../src/server/commerce/hub.ts";
import { createMockCommerce } from "../src/server/commerce/mock.ts";
import { inspectLiveLinks, liveHoldNote, type LiveLink } from "../src/server/liveAccess.ts";
import { PaymentGate } from "../src/server/payments/gate.ts";
import { SandboxPayments, type SandboxScenario } from "../src/server/payments/sandbox.ts";
import type { ApprovalRecord, GateExecuteInput } from "../src/server/payments/types.ts";
import { cartTotal, lineBadge, outcomeLabel, type CommerceEvent } from "../src/shared/commerce.ts";
import { agentFromHostname, hostFor, scoutAgent } from "../src/shared/hosts.ts";
import { roundMoney } from "../src/shared/offer.ts";
import { agentEndpoint } from "../src/web/agentRoute.ts";
import { conversationsFromStorage } from "../src/web/conversations.ts";
import { parseSse, withApi } from "./helpers.ts";

const session = "a".repeat(32);

describe("commerce mocks", () => {
  it("totals a cart from returned prices only", () => {
    const shop = createMockCommerce("instamart", createIds());
    shop.select("milk", 2);
    shop.select("bread", 1);
    const cart = shop.readCart();
    assert.equal(cart.provenance, "demo");
    assert.equal(cart.simulated, true);
    assert.equal(cart.deliveryFee, 25);
    for (const line of cart.lines) {
      assert.equal(line.lineTotal, line.unitPrice == null ? null : roundMoney(line.unitPrice * line.quantity));
    }
    assert.equal(cart.total, cartTotal(cart.lines, cart.deliveryFee));
    assert.equal(cart.total, 197);

    const tomatoes = createMockCommerce("instamart", createIds());
    tomatoes.select("tomato", 1);
    const unknown = tomatoes.readCart();
    assert.equal(unknown.lines[0]?.unitPrice, null);
    assert.equal(unknown.lines[0]?.lineTotal, null);
    assert.equal(unknown.deliveryFee, 25);
    assert.equal(unknown.total, null);

    const food = createMockCommerce("swiggy-food", createIds());
    food.select("dosa", 1);
    const meal = food.readCart();
    assert.deepEqual(meal.lines.map((line) => line.id), ["dosa"]);
    assert.equal(meal.total, cartTotal(meal.lines, meal.deliveryFee));
    assert.equal(meal.total, 150);
    assert.equal(shop.readCart().lines.some((line) => line.id === "dosa"), false);
    assert.notEqual(meal.deliveryFee, cart.deliveryFee);
  });

  it("requires a new confirmation after a price change", () => {
    const { hub, sandbox } = harness("success");
    hub.handle({ sessionId: session, agent: "shop", action: "message", text: "add 1 milk" });
    const quoted = hub.handle({ sessionId: session, agent: "shop", action: "message", text: "checkout" });
    const first = quoteOf(quoted);
    assert.equal(first.total, 91);
    assert.equal(first.provenance, "demo");
    assert.match(noteOf(quoted), /simulated/i);

    hub.replacePrice(session, "shop", "milk", 80);
    const stale = hub.handle({ sessionId: session, agent: "shop", action: "confirm", quoteId: first.id });
    assert.equal(stale.some((event) => event.type === "receipt"), false);
    assert.match(textOf(stale), /new total/);
    assert.equal(sandbox.executeCount, 0);

    const revised = hub.handle({ sessionId: session, agent: "shop", action: "message", text: "checkout" });
    const second = quoteOf(revised);
    assert.equal(second.total, 105);
    assert.notEqual(second.id, first.id);
    const paid = hub.handle({ sessionId: session, agent: "shop", action: "confirm", quoteId: second.id });
    const receipt = receiptOf(paid);
    assert.equal(receipt.status, "accepted");
    assert.equal(receipt.total, 105);
    assert.equal(receipt.provenance, "demo");
    assert.equal(receipt.label, "Simulated order");
    assert.equal(sandbox.executeCount, 1);
  });

  it("does not treat a chat yes as payment", () => {
    const { hub, sandbox, gate } = harness("success");
    hub.handle({ sessionId: session, agent: "shop", action: "message", text: "add 1 milk" });
    hub.handle({ sessionId: session, agent: "shop", action: "message", text: "checkout" });
    const yes = hub.handle({ sessionId: session, agent: "shop", action: "message", text: "yes" });
    assert.match(textOf(yes), /review card/);
    assert.equal(yes.some((event) => event.type === "receipt"), false);
    assert.equal(sandbox.executeCount, 0);
    assert.equal(gate.issuedCount(), 0);
  });
});

describe("payment gate", () => {
  it("declines in the sandbox and does not charge again", () => {
    const { hub, sandbox } = harness("decline");
    const quote = payQuote(hub);
    const receipt = receiptOf(hub.handle({ sessionId: session, agent: "shop", action: "confirm", quoteId: quote.id }));
    assert.equal(receipt.status, "declined");
    assert.equal(receipt.provenance, "demo");
    assert.equal(receipt.simulated, true);
    assert.equal(receipt.label, "Simulated order");
    assert.equal(sandbox.executeCount, 1);
    hub.handle({ sessionId: session, agent: "shop", action: "confirm", quoteId: quote.id });
    assert.equal(sandbox.executeCount, 1);
  });

  it("rejects an out-of-scope amount before execute", () => {
    const ids = createIds();
    const sandbox = new SandboxPayments("success", ids);
    const gate = new PaymentGate(sandbox, () => 5_000, ids);
    const approval = gate.issueApproval(approvalInput(15_000, 50));
    const result = gate.execute(executeInput(approval, 51));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "scope");
    assert.equal(sandbox.executeCount, 0);
  });

  it("keeps a timeout ambiguous and does not create a second charge", () => {
    const ids = createIds();
    const sandbox = new SandboxPayments("timeout", ids);
    const gate = new PaymentGate(sandbox, () => 5_000, ids);
    const approval = gate.issueApproval(approvalInput(15_000, 40));
    const first = gate.execute(executeInput(approval, 40, "one"));
    const second = gate.execute(executeInput(approval, 40, "two"));
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (first.ok && second.ok) {
      assert.equal(first.result.outcome, "timeout");
      assert.equal(first.result.simulated, true);
      assert.equal(second.result.transactionId, first.result.transactionId);
      assert.equal(second.result.idempotencyKey, "one");
    }
    assert.equal(sandbox.executeCount, 1);
    assert.equal(sandbox.getStatus("one")?.outcome, "timeout");
    assert.equal(sandbox.getStatus("one")?.resolved, false);
    assert.equal(sandbox.getStatus("two"), null);

    const { hub, sandbox: checkout } = harness("timeout");
    const quoted = payQuote(hub);
    const opened = hub.handle({ sessionId: session, agent: "shop", action: "confirm", quoteId: quoted.id });
    const again = hub.handle({ sessionId: session, agent: "shop", action: "confirm", quoteId: quoted.id });
    assert.equal(receiptOf(opened).status, "timeout");
    assert.match(noteOf(again), /not charged again/);
    assert.equal(receiptOf(again).id, receiptOf(opened).id);
    assert.equal(checkout.executeCount, 1);
  });

  it("returns expiry from the sandbox and from an expired approval", () => {
    const ids = createIds();
    const sandbox = new SandboxPayments("expiry", ids);
    const expired = sandbox.execute({ authorizationId: "auth", idempotencyKey: "same", amount: 10 });
    sandbox.execute({ authorizationId: "auth", idempotencyKey: "same", amount: 10 });
    assert.equal(expired.outcome, "expired");
    assert.equal(expired.simulated, true);
    assert.equal(sandbox.executeCount, 1);
    assert.equal(sandbox.verifyReceipt(expired).ok, false);

    const gateSandbox = new SandboxPayments("success", ids);
    const gate = new PaymentGate(gateSandbox, () => 5_000, ids);
    const approval = gate.issueApproval(approvalInput(4_000, 10));
    const result = gate.execute(executeInput(approval, 10));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "expired");
    assert.equal(gateSandbox.executeCount, 0);
  });
});

describe("appointments mock", () => {
  it("stays pending until a scripted confirm, reject, or cancel", () => {
    const salon = createMockSalon(createIds());
    const request = {
      serviceId: "haircut",
      time: "tomorrow 4pm",
      customerName: "Ada",
      stylist: "Noor",
      clientRequestId: "req-1",
    };
    const first = salon.request(request);
    const second = salon.request(request);
    assert.ok(first);
    assert.equal(first?.status, "pending");
    assert.equal(first?.simulated, true);
    assert.equal(first?.provenance, "demo");
    assert.equal(second?.externalId, first?.externalId);
    assert.equal(salon.createdCount, 1);
    assert.equal(salon.script(first?.externalId ?? "", "confirm")?.status, "confirmed");
    assert.equal(salon.status(first?.externalId ?? "")?.status, "confirmed");

    const other = salon.request({ ...request, clientRequestId: "req-2" });
    assert.equal(salon.script(other?.externalId ?? "", "reject")?.status, "rejected");
    assert.equal(salon.status(other?.externalId ?? "")?.status, "rejected");
    assert.equal(salon.cancel(first?.externalId ?? "")?.status, "cancelled");
    assert.equal(salon.status(first?.externalId ?? "")?.status, "cancelled");
  });

  it("reviews a simulated booking and omits stylist when the salon has none", () => {
    const { hub, sandbox } = harness("success");
    const quoted = hub.handle({
      sessionId: session,
      agent: "appointments",
      action: "message",
      text: "Book a haircut tomorrow at 4pm for Ada with Noor",
    });
    const quote = quoteOf(quoted);
    assert.equal(quote.domain, "booking");
    assert.equal(quote.total, 500);
    assert.equal(quote.details.find((detail) => detail.label === "Stylist")?.value, "Noor");
    assert.equal(quote.details.find((detail) => detail.label === "Booking")?.value, "Simulated booking");
    const paid = hub.handle({ sessionId: session, agent: "appointments", action: "confirm", quoteId: quote.id });
    const receipt = receiptOf(paid);
    assert.equal(receipt.status, "pending");
    assert.equal(receipt.label, "Simulated booking");
    assert.equal(receipt.provenance, "demo");
    assert.equal(hub.salonCreated(session), 1);
    hub.handle({ sessionId: session, agent: "appointments", action: "confirm", quoteId: quote.id });
    assert.equal(hub.salonCreated(session), 1);
    assert.equal(sandbox.executeCount, 1);

    const confirmed = hub.handle({
      sessionId: session,
      agent: "appointments",
      action: "message",
      text: `confirm booking ${receipt.id}`,
    });
    assert.equal(receiptOf(confirmed).status, "confirmed");

    const blowdry = hub.handle({
      sessionId: session,
      agent: "appointments",
      action: "message",
      text: "Book a blowdry tomorrow at 5pm for Ada",
    });
    assert.equal(quoteOf(blowdry).details.some((detail) => detail.label === "Stylist"), false);

    const color = hub.handle({
      sessionId: session,
      agent: "appointments",
      action: "message",
      text: "Book a color tomorrow at 5pm for Ada with Asha",
    });
    assert.equal(quoteOf(color).total, null);
    const unpaid = hub.handle({ sessionId: session, agent: "appointments", action: "confirm", quoteId: quoteOf(color).id });
    assert.match(textOf(unpaid), /unknown/);
    assert.equal(sandbox.executeCount, 1);
  });
});

describe("commerce routes and saved chats", () => {
  it("sends event chat only to /api/chat", () => {
    assert.equal(agentEndpoint("event"), "/api/chat");
    assert.equal(agentEndpoint("shop"), "/api/commerce");
    assert.equal(agentEndpoint("food"), "/api/commerce");
    assert.equal(agentEndpoint("appointments"), "/api/commerce");
    assert.equal(agentEndpoint("travel"), null);
    assert.equal(agentEndpoint("main"), null);
    assert.equal(agentEndpoint("home"), null);
    assert.equal(hostFor("appointments"), "https://sj-appointments-scout.azurewebsites.net");
    assert.equal(agentFromHostname("appointments-scout.example.com"), "appointments");
    assert.equal(scoutAgent("appointments"), "appointments");
    assert.notEqual(outcomeLabel("demo", "order"), outcomeLabel("live", "order"));
    assert.equal(lineBadge("demo"), "Simulated");
    assert.equal(lineBadge("live"), "Live");
    assert.equal(outcomeLabel("demo", "booking"), "Simulated booking");
    assert.equal(outcomeLabel("live", "booking"), "Live booking");
  });

  it("loads a stored conversation from before cart, quote, and receipt turns", () => {
    const loaded = conversationsFromStorage([
      {
        id: "old",
        sessionId: "session-old",
        agent: "event",
        title: "comedy",
        turns: [
          { kind: "user", text: "comedy in delhi" },
          { kind: "text", text: "Here are some." },
          { kind: "note", text: "District is slow." },
          { kind: "card", listing: { id: "evt", title: "Roast", kind: "comedy" } },
        ],
        activity: ["Message sent."],
        updatedAt: 1,
      },
    ]);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.agent, "event");
    assert.deepEqual(loaded[0]?.turns.map((turn) => turn.kind), ["user", "text", "note", "card"]);
  });

  it("serves shop on /api/commerce and refuses event chat on that route", async () => {
    const { hub } = harness("success");
    await withApi({ commerce: hub, now: () => 10_000 }, async (base) => {
      const denied = await fetch(`${base}/api/commerce`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-scout-session": "ab".repeat(16) },
        body: JSON.stringify({ agent: "event", text: "comedy in delhi" }),
      });
      assert.equal(denied.status, 400);
      const body = (await denied.json()) as { error?: string };
      assert.equal(body.error, "Event Scout uses chat.");

      const shop = await fetch(`${base}/api/commerce`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-scout-session": "cd".repeat(16) },
        body: JSON.stringify({ agent: "shop", text: "add 1 milk" }),
      });
      assert.equal(shop.status, 200);
      assert.match(shop.headers.get("content-type") ?? "", /text\/event-stream/);
      const events = parseSse<CommerceEvent>(await shop.text());
      assert.equal(events.some((event) => event.type === "cart"), true);
      assert.equal(events.some((event) => event.type === "done"), true);
    });
  });
});

describe("live connectors", () => {
  it("leaves the labeled mock in place when credentials or schemas are missing", () => {
    const missing = inspectLiveLinks({});
    assert.equal(missing.length, 3);
    assert.equal(missing.every((link) => link.authorized), false);
    assert.match(missing[0]?.reason ?? "", /Credentials are not available/);
    const named = inspectLiveLinks({
      SWIGGY_ACCESS_TOKEN: "present",
      RAZORPAY_KEY_ID: "present",
      RAZORPAY_KEY_SECRET: "present",
      SALONING_API_KEY: "present",
      SALONING_SALON_ID: "salon-1",
    });
    assert.equal(named.every((link) => link.authorized), false);
    assert.match(named[0]?.reason ?? "", /schema is not available/);

    const links: LiveLink[] = [
      { provider: "swiggy", authorized: true, reason: "Account confirmed." },
      { provider: "razorpay", authorized: true, reason: "Account confirmed." },
      { provider: "saloning", authorized: true, reason: "Account confirmed." },
    ];
    const ids = createIds();
    const sandbox = new SandboxPayments("success", ids);
    const hub = new CommerceHub(() => 10_000, new PaymentGate(sandbox, () => 10_000, ids), links, ids);
    hub.handle({ sessionId: session, agent: "food", action: "message", text: "add 1 dosa" });
    const quoted = hub.handle({ sessionId: session, agent: "food", action: "message", text: "checkout" });
    assert.match(noteOf(quoted), /Live orders stay off/);
    assert.equal(liveHoldNote(links), "Live orders stay off until an operation is confirmed for this account.");
    const receipt = receiptOf(hub.handle({
      sessionId: session,
      agent: "food",
      action: "confirm",
      quoteId: quoteOf(quoted).id,
    }));
    assert.equal(receipt.provenance, "demo");
    assert.equal(receipt.label, "Simulated order");
    assert.equal(sandbox.executeCount, 1);
  });
});

function harness(scenario: SandboxScenario, now = () => 10_000) {
  const ids = createIds();
  const sandbox = new SandboxPayments(scenario, ids);
  const gate = new PaymentGate(sandbox, now, ids);
  const hub = new CommerceHub(now, gate, inspectLiveLinks({}), ids);
  return { sandbox, gate, hub };
}

function createIds(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `id-${count}`;
  };
}

function payQuote(hub: CommerceHub) {
  hub.handle({ sessionId: session, agent: "shop", action: "message", text: "add 1 milk" });
  return quoteOf(hub.handle({ sessionId: session, agent: "shop", action: "message", text: "checkout" }));
}

function quoteOf(events: CommerceEvent[]) {
  const found = events.find((event) => event.type === "quote");
  assert.equal(found?.type, "quote");
  if (found?.type !== "quote") throw new Error("missing quote");
  return found.quote;
}

function receiptOf(events: CommerceEvent[]) {
  const found = events.find((event) => event.type === "receipt");
  assert.equal(found?.type, "receipt");
  if (found?.type !== "receipt") throw new Error("missing receipt");
  return found.receipt;
}

function textOf(events: CommerceEvent[]): string {
  const found = events.find((event) => event.type === "text");
  assert.equal(found?.type, "text");
  if (found?.type !== "text") throw new Error("missing text");
  return found.message;
}

function noteOf(events: CommerceEvent[]): string {
  const found = events.find((event) => event.type === "note");
  assert.equal(found?.type, "note");
  if (found?.type !== "note") throw new Error("missing note");
  return found.message;
}

function approvalInput(expiresAt: number, maxAmount: number): Omit<ApprovalRecord, "id"> {
  return {
    sessionId: session,
    merchant: "Instamart",
    quoteId: "quote-1",
    fingerprint: "same",
    maxAmount,
    expiresAt,
    action: "pay",
  };
}

function executeInput(approval: ApprovalRecord, amount: number, idempotencyKey = "charge-1"): GateExecuteInput {
  return {
    approvalId: approval.id,
    sessionId: session,
    amount,
    fingerprint: approval.fingerprint,
    idempotencyKey,
    merchant: approval.merchant,
    quoteId: approval.quoteId,
    action: approval.action,
  };
}
