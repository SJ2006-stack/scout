import type { AgentId } from "./hosts.ts";
import { roundMoney } from "./offer.ts";
import type { PayLink } from "./payLink.ts";

export type CommerceAgent = Extract<AgentId, "shop" | "food" | "appointments">;

export type CommerceProvider = "instamart" | "swiggy-food";

export type CommerceProvenance = "demo" | "live";

export type CartLine = {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number | null;
  lineTotal: number | null;
};

export type CartSnapshot = {
  provider: CommerceProvider;
  provenance: CommerceProvenance;
  simulated: boolean;
  lines: CartLine[];
  deliveryFee: number | null;
  total: number | null;
};

export type QuoteLine = {
  label: string;
  quantity: number;
  amount: number | null;
};

export type QuoteDetail = {
  label: string;
  value: string;
};

export type QuoteSnapshot = {
  id: string;
  domain: "order" | "booking";
  provider: string;
  provenance: CommerceProvenance;
  simulated: boolean;
  title: string;
  lines: QuoteLine[];
  deliveryFee: number | null;
  total: number | null;
  details: QuoteDetail[];
};

export type ReceiptSnapshot = {
  id: string;
  domain: "order" | "booking";
  provider: string;
  provenance: CommerceProvenance;
  simulated: boolean;
  status: string;
  total: number | null;
  label: string;
  lines: QuoteDetail[];
};

export type CommerceEvent =
  | { type: "status"; message: string }
  | { type: "text"; message: string }
  | { type: "note"; message: string }
  | { type: "cart"; cart: CartSnapshot }
  | { type: "quote"; quote: QuoteSnapshot }
  | { type: "receipt"; receipt: ReceiptSnapshot }
  | { type: "pay"; pay: PayLink }
  | { type: "done" };

export function lineTotal(unitPrice: number | null, quantity: number): number | null {
  if (unitPrice == null || !Number.isFinite(unitPrice) || !Number.isFinite(quantity) || quantity < 1) return null;
  return roundMoney(unitPrice * quantity);
}

export function cartTotal(lines: CartLine[], deliveryFee: number | null): number | null {
  if (deliveryFee == null || !Number.isFinite(deliveryFee)) return null;
  let sum = 0;
  for (const line of lines) {
    if (line.lineTotal == null || !Number.isFinite(line.lineTotal)) return null;
    sum += line.lineTotal;
  }
  return roundMoney(sum + deliveryFee);
}

export function cartFingerprint(cart: Pick<CartSnapshot, "lines" | "deliveryFee" | "total">): string {
  return JSON.stringify({
    lines: cart.lines.map((line) => ({
      id: line.id,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
    })),
    deliveryFee: cart.deliveryFee,
    total: cart.total,
  });
}

export function bookingFingerprint(input: {
  serviceId: string;
  time: string;
  customerName: string;
  stylist: string | null;
  price: number | null;
}): string {
  return JSON.stringify({
    serviceId: input.serviceId,
    time: input.time,
    customerName: input.customerName,
    stylist: input.stylist,
    price: input.price,
  });
}

export function outcomeLabel(provenance: CommerceProvenance, domain: "order" | "booking"): string {
  switch (provenance) {
    case "demo":
      return domain === "order" ? "Simulated order" : "Simulated booking";
    case "live":
      return domain === "order" ? "Live order" : "Live booking";
    default: {
      const neverProvenance: never = provenance;
      return neverProvenance;
    }
  }
}

export function lineBadge(provenance: CommerceProvenance): string {
  switch (provenance) {
    case "demo":
      return "Simulated";
    case "live":
      return "Live";
    default: {
      const neverProvenance: never = provenance;
      return neverProvenance;
    }
  }
}

export function providerLabel(provider: CommerceProvider): string {
  switch (provider) {
    case "instamart":
      return "Instamart";
    case "swiggy-food":
      return "Swiggy Food";
    default: {
      const neverProvider: never = provider;
      return neverProvider;
    }
  }
}

export function formatAmount(amount: number | null): string {
  if (amount == null || !Number.isFinite(amount)) return "Unknown";
  return `₹${amount}`;
}

export function isCartSnapshot(value: unknown): value is CartSnapshot {
  if (!value || typeof value !== "object") return false;
  const cart = value as Partial<CartSnapshot>;
  return (cart.provider === "instamart" || cart.provider === "swiggy-food")
    && (cart.provenance === "demo" || cart.provenance === "live")
    && typeof cart.simulated === "boolean"
    && Array.isArray(cart.lines)
    && cart.lines.every(isCartLine)
    && isAmount(cart.deliveryFee)
    && isAmount(cart.total);
}

export function isQuoteSnapshot(value: unknown): value is QuoteSnapshot {
  if (!value || typeof value !== "object") return false;
  const quote = value as Partial<QuoteSnapshot>;
  return typeof quote.id === "string"
    && (quote.domain === "order" || quote.domain === "booking")
    && typeof quote.provider === "string"
    && (quote.provenance === "demo" || quote.provenance === "live")
    && typeof quote.simulated === "boolean"
    && typeof quote.title === "string"
    && Array.isArray(quote.lines)
    && quote.lines.every(isQuoteLine)
    && isAmount(quote.deliveryFee)
    && isAmount(quote.total)
    && Array.isArray(quote.details)
    && quote.details.every(isQuoteDetail);
}

export function isReceiptSnapshot(value: unknown): value is ReceiptSnapshot {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<ReceiptSnapshot>;
  return typeof receipt.id === "string"
    && (receipt.domain === "order" || receipt.domain === "booking")
    && typeof receipt.provider === "string"
    && (receipt.provenance === "demo" || receipt.provenance === "live")
    && typeof receipt.simulated === "boolean"
    && typeof receipt.status === "string"
    && isAmount(receipt.total)
    && typeof receipt.label === "string"
    && Array.isArray(receipt.lines)
    && receipt.lines.every(isQuoteDetail);
}

function isCartLine(value: unknown): value is CartLine {
  if (!value || typeof value !== "object") return false;
  const line = value as Partial<CartLine>;
  return typeof line.id === "string"
    && typeof line.name === "string"
    && typeof line.quantity === "number"
    && Number.isFinite(line.quantity)
    && isAmount(line.unitPrice)
    && isAmount(line.lineTotal);
}

function isQuoteLine(value: unknown): value is QuoteLine {
  if (!value || typeof value !== "object") return false;
  const line = value as Partial<QuoteLine>;
  return typeof line.label === "string"
    && typeof line.quantity === "number"
    && Number.isFinite(line.quantity)
    && isAmount(line.amount);
}

function isQuoteDetail(value: unknown): value is QuoteDetail {
  if (!value || typeof value !== "object") return false;
  const detail = value as Partial<QuoteDetail>;
  return typeof detail.label === "string" && typeof detail.value === "string";
}

function isAmount(value: unknown): value is number | null {
  return value == null || (typeof value === "number" && Number.isFinite(value));
}
