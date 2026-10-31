import { randomBytes } from "node:crypto";
import {
  bookingFingerprint,
  cartFingerprint,
  formatAmount,
  outcomeLabel,
  providerLabel,
  type CommerceAgent,
  type CommerceEvent,
  type QuoteDetail,
  type QuoteSnapshot,
  type ReceiptSnapshot,
} from "../../shared/commerce.ts";
import { withEmoji } from "../../shared/emoji.ts";
import {
  createMockSalon,
  readBookingPhrase,
  serviceIdFromPhrase,
  servicePhrase,
  type Appointment,
  type MockSalon,
  type SalonService,
} from "../appointments/mock.ts";
import { inspectLiveLinks, liveHoldNote, type LiveLink } from "../liveAccess.ts";
import { PaymentGate, quoteExpiry } from "../payments/gate.ts";
import { SandboxPayments } from "../payments/sandbox.ts";
import type { ExecuteResult, GateRejection, PaymentAction } from "../payments/types.ts";
import { createMockCommerce, type CatalogProduct, type MockCommerce } from "./mock.ts";

export type CommerceRequest =
  | { sessionId: string; agent: CommerceAgent; action: "message"; text: string }
  | { sessionId: string; agent: CommerceAgent; action: "confirm"; quoteId: string };

type BookingDraft = {
  serviceId: string | null;
  time: string | null;
  customerName: string | null;
  stylist: string | null;
};

type StoredBooking = {
  serviceId: string;
  time: string;
  customerName: string;
  stylist: string | null;
  price: number | null;
};

type StoredQuote = {
  snapshot: QuoteSnapshot;
  sessionId: string;
  agent: CommerceAgent;
  fingerprint: string;
  merchant: string;
  idempotencyKey: string;
  expiresAt: number;
  amount: number | null;
  booking: StoredBooking | null;
};

type ProviderReport = {
  status: string;
  reference: string;
};

export class CommerceHub {
  private readonly shop = new Map<string, MockCommerce>();
  private readonly food = new Map<string, MockCommerce>();
  private readonly salons = new Map<string, MockSalon>();
  private readonly drafts = new Map<string, BookingDraft>();
  private readonly quotes = new Map<string, StoredQuote>();
  private readonly now: () => number;
  private readonly gate: PaymentGate;
  private readonly live: LiveLink[];
  private readonly ids: () => string;

  constructor(now: () => number, gate: PaymentGate, live: LiveLink[], ids: () => string) {
    this.now = now;
    this.gate = gate;
    this.live = live;
    this.ids = ids;
  }

  handle(input: CommerceRequest): CommerceEvent[] {
    switch (input.action) {
      case "confirm":
        return this.confirm(input.sessionId, input.agent, input.quoteId);
      case "message":
        return this.message(input.sessionId, input.agent, input.text);
      default: {
        const neverRequest: never = input;
        return neverRequest;
      }
    }
  }

  replacePrice(sessionId: string, agent: "shop" | "food", productId: string, unitPrice: number | null): void {
    this.commerceFor(sessionId, agent).setUnitPrice(productId, unitPrice);
  }

  replaceServicePrice(sessionId: string, serviceId: string, price: number | null): void {
    this.salonFor(sessionId).setPrice(serviceId, price);
  }

  salonCreated(sessionId: string): number {
    return this.salonFor(sessionId).createdCount;
  }

  private message(sessionId: string, agent: CommerceAgent, text: string): CommerceEvent[] {
    const trimmed = text.trim();
    if (trimmed.length === 0) return finish(textEvent("Tell Scout what you need."));
    if (isChatApproval(trimmed)) {
      return finish(textEvent("Confirm the review card to continue. A chat reply does not authorize payment."));
    }
    switch (agent) {
      case "shop":
      case "food":
        return this.orderMessage(sessionId, agent, trimmed);
      case "appointments":
        return this.appointmentMessage(sessionId, trimmed);
      default: {
        const neverAgent: never = agent;
        return neverAgent;
      }
    }
  }

  private orderMessage(sessionId: string, agent: "shop" | "food", text: string): CommerceEvent[] {
    const adapter = this.commerceFor(sessionId, agent);
    const seller = providerLabel(adapter.provider);
    if (/^(?:show\s+(?:my\s+)?)?cart\.?$/i.test(text)) {
      return finish(statusEvent(`Reading the simulated ${seller} cart.`), { type: "cart", cart: adapter.readCart() });
    }
    if (/^(?:checkout|check out|quote)\.?$/i.test(text)) return this.checkout(sessionId, agent);
    const add = /^(?:add|select)\s+(?:(\d+)\s+)?(.+)$/i.exec(text);
    if (add) return this.addItem(adapter, seller, Number(add[1] ?? "1"), cleanQuery(add[2] ?? ""));
    const update = /^(?:set|update|change)\s+(.+?)\s+(?:to\s+)?(\d+)$/i.exec(text);
    if (update) return this.setQuantity(adapter, seller, cleanQuery(update[1] ?? ""), Number(update[2]));
    const remove = /^(?:remove|delete)\s+(.+)$/i.exec(text);
    if (remove) return this.setQuantity(adapter, seller, cleanQuery(remove[1] ?? ""), 0);
    const query = cleanQuery(text.replace(/^(?:find|search|look up|show me|show)\s+/i, ""));
    return finish(statusEvent(`Searching the simulated ${seller} catalog.`), textEvent(describeProducts(seller, adapter.search(query))));
  }

  private addItem(adapter: MockCommerce, seller: string, quantity: number, query: string): CommerceEvent[] {
    if (!Number.isInteger(quantity) || quantity < 1) return finish(textEvent("Tell Scout a quantity of at least 1."));
    const matches = adapter.search(query);
    const product = onlyProduct(matches);
    if (!product) return finish(textEvent(describeProducts(seller, matches)));
    const cart = adapter.select(product.id, quantity);
    return finish(
      statusEvent(`Updating the simulated ${seller} cart.`),
      { type: "cart", cart },
      textEvent(`Added ${quantity} ${product.name}. This line is simulated.`),
    );
  }

  private setQuantity(adapter: MockCommerce, seller: string, query: string, quantity: number): CommerceEvent[] {
    const matches = adapter.search(query);
    const product = onlyProduct(matches);
    if (!product) return finish(textEvent(describeProducts(seller, matches)));
    const cart = adapter.updateCart(product.id, quantity);
    const verb = quantity <= 0 ? `Removed ${product.name}.` : `Updated ${product.name} to ${quantity}.`;
    return finish(statusEvent(`Updating the simulated ${seller} cart.`), { type: "cart", cart }, textEvent(`${verb} This line is simulated.`));
  }

  private checkout(sessionId: string, agent: "shop" | "food"): CommerceEvent[] {
    const adapter = this.commerceFor(sessionId, agent);
    const cart = adapter.readCart();
    if (cart.lines.length === 0) return finish(textEvent("The cart is empty."));
    const snapshot = adapter.quote();
    this.rememberQuote(sessionId, agent, snapshot, cartFingerprint(cart), cart.total, null);
    return finish(
      statusEvent("Preparing the simulated checkout."),
      { type: "quote", quote: snapshot },
      noteEvent(liveHoldNote(this.live)),
    );
  }

  private appointmentMessage(sessionId: string, text: string): CommerceEvent[] {
    const salon = this.salonFor(sessionId);
    const scripted = /^(confirm|reject|cancel)\s+booking\s+(\S+)$/i.exec(text);
    if (scripted) return this.bookingCommand(salon, scripted[1] ?? "", scripted[2] ?? "");
    const status = /^(?:status|booking status)\s+(\S+)$/i.exec(text);
    if (status) return this.reportedBooking(salon, status[1] ?? "");
    if (/^(?:find|search|look up|show)\b/i.test(text)) {
      const query = cleanQuery(text.replace(/^(?:find|search|look up|show me|show)\s+(?:a\s+)?/i, ""));
      return finish(statusEvent("Searching the simulated salon."), textEvent(describeServices(salon.search(query))));
    }
    return this.book(sessionId, salon, text);
  }

  private bookingCommand(salon: MockSalon, verb: string, externalId: string): CommerceEvent[] {
    const appointment = applyBookingVerb(salon, verb, externalId);
    if (!appointment) return finish(textEvent("That booking was not found."));
    return this.reportedBooking(salon, appointment.externalId);
  }

  private reportedBooking(salon: MockSalon, externalId: string): CommerceEvent[] {
    const reported = salon.status(externalId);
    if (!reported) return finish(textEvent("The salon did not return a status."));
    return finish(statusEvent("Reading the salon status."), bookingReceipt(reported));
  }

  private book(sessionId: string, salon: MockSalon, text: string): CommerceEvent[] {
    const phrase = readBookingPhrase(text);
    const draft = this.drafts.get(sessionId) ?? emptyDraft();
    const hasField = phrase.service != null || phrase.time != null || phrase.customerName != null || phrase.stylist != null;
    if (!/^book\b/i.test(text) && !hasField) {
      return finish(textEvent("Tell Scout the service, a preferred time, and your name. This salon is simulated."));
    }
    if (phrase.service) {
      const named = servicePhrase(phrase.service);
      draft.serviceId = named ? serviceIdFromPhrase(named) : null;
    }
    if (phrase.time) draft.time = phrase.time;
    if (phrase.customerName) draft.customerName = phrase.customerName;
    if (phrase.stylist) draft.stylist = phrase.stylist;
    this.drafts.set(sessionId, draft);
    return this.reviewBooking(sessionId, salon, draft);
  }

  private reviewBooking(sessionId: string, salon: MockSalon, draft: BookingDraft): CommerceEvent[] {
    if (!draft.serviceId || !draft.time || !draft.customerName) return finish(textEvent(missingBooking(draft, false)));
    const service = salon.service(draft.serviceId);
    if (!service) return finish(textEvent("That service is not on the simulated salon menu."));
    const stylist = chosenStylist(salon, service, draft.stylist);
    if (stylist === "missing") {
      return finish(textEvent(`${missingBooking(draft, true)} Stylists: ${service.stylists.join(", ")}.`));
    }
    if (stylist === "unknown") {
      return finish(textEvent(`That stylist is not available. Choose ${service.stylists.join(" or ")}.`));
    }
    const booking: StoredBooking = {
      serviceId: service.id,
      time: draft.time,
      customerName: draft.customerName,
      stylist,
      price: service.price,
    };
    const snapshot: QuoteSnapshot = {
      id: this.ids(),
      domain: "booking",
      provider: "Demo Salon",
      provenance: "demo",
      simulated: true,
      title: "Booking review",
      lines: [{ label: service.name, quantity: 1, amount: service.price }],
      deliveryFee: null,
      total: service.price,
      details: bookingDetails(service.name, draft.time, draft.customerName, stylist),
    };
    this.rememberQuote(sessionId, "appointments", snapshot, bookingFingerprint(booking), service.price, booking);
    return finish(
      statusEvent("Preparing the simulated booking review."),
      { type: "quote", quote: snapshot },
      noteEvent(liveHoldNote(this.live)),
    );
  }

  private confirm(sessionId: string, agent: CommerceAgent, quoteId: string): CommerceEvent[] {
    const stored = this.quotes.get(quoteId);
    if (!stored || stored.sessionId !== sessionId || stored.agent !== agent) {
      return finish(textEvent("That review is not open on this chat."));
    }
    if (this.now() >= stored.expiresAt) return finish(textEvent("That review expired. Ask for a new checkout."));
    if (this.fingerprintFor(stored) !== stored.fingerprint) {
      return finish(textEvent("That quote changed. Review the new total before confirming."));
    }
    if (stored.amount == null) return finish(textEvent("The total is unknown, so Scout will not charge."));
    const existing = this.gate.status(stored.idempotencyKey);
    if (existing) return this.paymentEvents(stored, existing, true);
    const action: PaymentAction = stored.snapshot.domain === "booking" ? "book" : "pay";
    const approval = this.gate.issueApproval({
      sessionId,
      merchant: stored.merchant,
      quoteId: stored.snapshot.id,
      fingerprint: stored.fingerprint,
      maxAmount: stored.amount,
      expiresAt: stored.expiresAt,
      action,
    });
    const executed = this.gate.execute({
      approvalId: approval.id,
      sessionId,
      amount: stored.amount,
      fingerprint: stored.fingerprint,
      idempotencyKey: stored.idempotencyKey,
      merchant: stored.merchant,
      quoteId: stored.snapshot.id,
      action,
    });
    if (!executed.ok) return finish(textEvent(refusal(executed.reason)));
    return this.paymentEvents(stored, executed.result, false);
  }

  private paymentEvents(stored: StoredQuote, result: ExecuteResult, replay: boolean): CommerceEvent[] {
    const events: CommerceEvent[] = [
      statusEvent(replay ? "Reading the earlier payment status." : "Checking the approval before charging."),
    ];
    if (result.outcome !== "succeeded") {
      events.push(paymentReceipt(stored, result, result.outcome, result.transactionId));
      if (result.outcome === "timeout") {
        events.push(noteEvent(replay
          ? "The earlier attempt timed out and was not charged again."
          : "The payment timed out. Scout left it unresolved."));
      }
      return finish(...events);
    }
    const reported = this.providerReport(stored, result.transactionId);
    if (!reported) {
      events.push(noteEvent("The provider did not return a status."));
      events.push(paymentReceipt(stored, result, result.outcome, result.transactionId));
      return finish(...events);
    }
    events.push(statusEvent("Reading the provider status."));
    events.push(paymentReceipt(stored, result, reported.status, reported.reference));
    return finish(...events);
  }

  private providerReport(stored: StoredQuote, transactionId: string): ProviderReport | null {
    switch (stored.agent) {
      case "shop":
      case "food": {
        const adapter = this.commerceFor(stored.sessionId, stored.agent);
        const order = adapter.recordOrder(transactionId);
        const reported = adapter.orderStatus(order.id);
        return reported ? { status: reported.status, reference: reported.id } : null;
      }
      case "appointments": {
        if (!stored.booking) return null;
        const appointment = this.salonFor(stored.sessionId).request({
          ...stored.booking,
          clientRequestId: stored.idempotencyKey,
        });
        if (!appointment) return null;
        const reported = this.salonFor(stored.sessionId).status(appointment.externalId);
        return reported ? { status: reported.status, reference: reported.externalId } : null;
      }
      default: {
        const neverAgent: never = stored.agent;
        return neverAgent;
      }
    }
  }

  private fingerprintFor(stored: StoredQuote): string {
    switch (stored.agent) {
      case "shop":
      case "food":
        return cartFingerprint(this.commerceFor(stored.sessionId, stored.agent).readCart());
      case "appointments": {
        if (!stored.booking) return "";
        const price = this.salonFor(stored.sessionId).service(stored.booking.serviceId)?.price ?? null;
        return bookingFingerprint({ ...stored.booking, price });
      }
      default: {
        const neverAgent: never = stored.agent;
        return neverAgent;
      }
    }
  }

  private rememberQuote(
    sessionId: string,
    agent: CommerceAgent,
    snapshot: QuoteSnapshot,
    fingerprint: string,
    amount: number | null,
    booking: StoredBooking | null,
  ): void {
    this.quotes.set(snapshot.id, {
      snapshot,
      sessionId,
      agent,
      fingerprint,
      merchant: snapshot.provider,
      idempotencyKey: `pay:${sessionId}:${snapshot.provider}:${fingerprint}`,
      expiresAt: quoteExpiry(this.now()),
      amount,
      booking,
    });
  }

  private commerceFor(sessionId: string, agent: "shop" | "food"): MockCommerce {
    const table = agent === "shop" ? this.shop : this.food;
    const existing = table.get(sessionId);
    if (existing) return existing;
    const created = createMockCommerce(agent === "shop" ? "instamart" : "swiggy-food", this.ids);
    table.set(sessionId, created);
    return created;
  }

  private salonFor(sessionId: string): MockSalon {
    const existing = this.salons.get(sessionId);
    if (existing) return existing;
    const created = createMockSalon(this.ids);
    this.salons.set(sessionId, created);
    return created;
  }
}

export function createCommerceHub(now: () => number, env: Record<string, string | undefined> = process.env): CommerceHub {
  const ids = (): string => randomBytes(8).toString("hex");
  return new CommerceHub(now, new PaymentGate(new SandboxPayments("success", ids), now, ids), inspectLiveLinks(env), ids);
}

function emptyDraft(): BookingDraft {
  return { serviceId: null, time: null, customerName: null, stylist: null };
}

function isChatApproval(text: string): boolean {
  return /^(?:yes|yep|yeah|ok|okay|confirm|confirmed|pay|approve)(?:\s+please)?\.?$/i.test(text);
}

function cleanQuery(value: string): string {
  return value.replace(/[.?!]+$/g, "").trim();
}

function onlyProduct(products: CatalogProduct[]): CatalogProduct | null {
  return products.length === 1 ? products[0] ?? null : null;
}

function describeProducts(seller: string, products: CatalogProduct[]): string {
  if (products.length === 0) return `Nothing matched that search in the simulated ${seller} catalog.`;
  const lines = products.map((product) => `${product.name}: ${formatAmount(product.unitPrice)} (Simulated)`);
  const hint = products.length > 1 ? "Say which item to add." : "Say add 1 and the item name.";
  return `${lines.join("\n")}\n${hint} This catalog is simulated.`;
}

function describeServices(services: SalonService[]): string {
  if (services.length === 0) return "Nothing matched that search at the simulated salon.";
  const lines = services.map((service) => {
    const stylists = service.stylists.length > 0 ? ` Stylists: ${service.stylists.join(", ")}.` : "";
    return `${service.name}: ${formatAmount(service.price)}.${stylists} Simulated.`;
  });
  return `${lines.join("\n")}\nSay book, the service, a time, and your name.`;
}

function missingBooking(draft: BookingDraft, needStylist: boolean): string {
  const missing: string[] = [];
  if (!draft.serviceId) missing.push("a service");
  if (!draft.time) missing.push("a preferred time");
  if (!draft.customerName) missing.push("your name");
  if (needStylist && !draft.stylist) missing.push("a stylist");
  return `This booking is simulated. Still need ${missing.join(", ")}.`;
}

function chosenStylist(salon: MockSalon, service: SalonService, requested: string | null): string | null | "missing" | "unknown" {
  if (!salon.supportsStylist(service.id)) return null;
  if (!requested) return "missing";
  return salon.matchStylist(service.id, requested) ?? "unknown";
}

function bookingDetails(service: string, time: string, customerName: string, stylist: string | null): QuoteDetail[] {
  const details: QuoteDetail[] = [
    { label: "Service", value: service },
    { label: "Time", value: time },
    { label: "Customer", value: customerName },
  ];
  if (stylist) details.push({ label: "Stylist", value: stylist });
  details.push({ label: "Booking", value: outcomeLabel("demo", "booking") });
  return details;
}

function applyBookingVerb(salon: MockSalon, verb: string, externalId: string): Appointment | null {
  switch (verb.toLowerCase()) {
    case "confirm":
      return salon.script(externalId, "confirm");
    case "reject":
      return salon.script(externalId, "reject");
    case "cancel":
      return salon.cancel(externalId);
    default:
      return null;
  }
}

function bookingReceipt(appointment: Appointment): CommerceEvent {
  const lines: QuoteDetail[] = [
    { label: "Service", value: appointment.service },
    { label: "Time", value: appointment.time },
    { label: "Status", value: appointment.status },
  ];
  if (appointment.stylist) lines.push({ label: "Stylist", value: appointment.stylist });
  return {
    type: "receipt",
    receipt: {
      id: appointment.externalId,
      domain: "booking",
      provider: "Demo Salon",
      provenance: appointment.provenance,
      simulated: appointment.simulated,
      status: appointment.status,
      total: appointment.price,
      label: outcomeLabel(appointment.provenance, "booking"),
      lines,
    },
  };
}

function paymentReceipt(stored: StoredQuote, result: ExecuteResult, status: string, reference: string): CommerceEvent {
  const provenance = result.simulated ? "demo" : "live";
  const receipt: ReceiptSnapshot = {
    id: reference,
    domain: stored.snapshot.domain,
    provider: stored.snapshot.provider,
    provenance,
    simulated: result.simulated,
    status,
    total: stored.amount,
    label: outcomeLabel(provenance, stored.snapshot.domain),
    lines: [
      { label: "Payment", value: result.outcome },
      { label: "Reference", value: result.transactionId },
      { label: "Status", value: status },
    ],
  };
  return { type: "receipt", receipt };
}

function refusal(reason: GateRejection): string {
  switch (reason) {
    case "missing":
    case "session":
      return "That approval is not on this session, so it was not charged.";
    case "scope":
      return "That amount is outside the approved quote, so it was not charged.";
    case "expired":
      return "That review expired, so it was not charged.";
    case "mismatch":
      return "That quote changed. Review the new total before confirming.";
    default: {
      const neverReason: never = reason;
      return neverReason;
    }
  }
}

function statusEvent(message: string): CommerceEvent {
  return { type: "status", message };
}

function textEvent(message: string): CommerceEvent {
  return { type: "text", message: withEmoji(message) };
}

function noteEvent(message: string): CommerceEvent {
  return { type: "note", message };
}

function finish(...events: CommerceEvent[]): CommerceEvent[] {
  return [...events, { type: "done" }];
}
