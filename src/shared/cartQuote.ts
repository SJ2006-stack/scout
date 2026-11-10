import type { ShopApp } from "./productRef.ts";

/** One bill the phone read in a store's cart, and how long that run took. */
export type StoreBill = {
  store: ShopApp;
  itemsTotal: number | null;
  handling: number | null;
  delivery: number | null;
  otherFees: number | null;
  grandTotal: number | null;
  elapsedMs: number | null;
  /** Items the run added, so a basket run's time can be scaled back to one item. */
  lines: number | null;
  at: number;
};

/** What a store adds on top of the items, worked out from its bills. */
export type FeeRule = {
  store: ShopApp;
  handling: number;
  delivery: number;
  /** The smallest items total seen with free delivery, above every items total that paid for it. */
  freeDeliveryFrom: number | null;
  otherFees: number;
  /** Bills the rule was learned from. Zero means the starting guess below. */
  bills: number;
};

export type StoreEstimate = {
  store: ShopApp;
  itemsTotal: number;
  fees: number;
  total: number;
  /** "learned" when this user's bills set the fees, "rough" when the starting guess did. */
  basis: "learned" | "rough";
  phoneSeconds: number;
  /** Units the estimate covers, summed over the items the store has. */
  units: number;
  /** Items the store did not show. A basket is only comparable across stores that have every item. */
  missing: string[];
};

/** One basket item: what was asked, how many, and the price each store showed for it. */
export type BasketLine = { query: string; quantity: number; prices: Partial<Record<ShopApp, number>> };

export type CartQuote = { estimates: StoreEstimate[]; best: ShopApp | null };

/** The estimate card in chat: what was compared, and the quote for one of it. */
export type CartEstimate = { item: string; quote: CartQuote; lines: number };

/**
 * Starting guesses from bills read on the test phone (Nov 4 to 6, 2026): Blinkit ₹6 handling and ₹35
 * delivery, free from ₹149; Zepto ₹30 delivery, free above ₹149, handling waived; Instamart ₹12
 * handling and ₹35.70 delivery on a ₹29 cart, free-delivery level not seen. Every bill a user's
 * phone reads replaces these for that user.
 */
export const STARTING_FEES: Readonly<Record<ShopApp, FeeRule>> = {
  blinkit: { store: "blinkit", handling: 6, delivery: 35, freeDeliveryFrom: 149, otherFees: 0, bills: 0 },
  zepto: { store: "zepto", handling: 0, delivery: 30, freeDeliveryFrom: 149, otherFees: 0, bills: 0 },
  instamart: { store: "instamart", handling: 12, delivery: 35.7, freeDeliveryFrom: null, otherFees: 0, bills: 0 },
};

/** Cold phone cart runs measured on Nov 6, 2026, used until a user's own runs replace them. */
export const STARTING_PHONE_MS: Readonly<Record<ShopApp, number>> = { blinkit: 17_000, zepto: 12_000, instamart: 17_000 };

const SHOPS: readonly ShopApp[] = ["blinkit", "zepto", "instamart"];

export function learnFees(store: ShopApp, bills: readonly StoreBill[]): FeeRule {
  const start = STARTING_FEES[store];
  const usable = bills.filter((bill) => bill.store === store && bill.itemsTotal != null && bill.grandTotal != null);
  if (usable.length === 0) return start;
  const handling = median(usable.map((bill) => bill.handling).filter(isNumber)) ?? start.handling;
  const other = median(usable.map((bill) => bill.otherFees ?? 0)) ?? 0;
  const paid = usable.filter((bill) => (bill.delivery ?? 0) > 0);
  const free = usable.filter((bill) => bill.delivery === 0);
  const delivery = median(paid.map((bill) => bill.delivery).filter(isNumber)) ?? start.delivery;
  const highestPaid = Math.max(0, ...paid.map((bill) => bill.itemsTotal ?? 0));
  const freeAbove = free.map((bill) => bill.itemsTotal ?? 0).filter((total) => total > highestPaid);
  const startFree = start.freeDeliveryFrom != null && start.freeDeliveryFrom > highestPaid ? start.freeDeliveryFrom : null;
  const levels = startFree == null ? freeAbove : [...freeAbove, startFree];
  const freeDeliveryFrom = levels.length > 0 ? Math.min(...levels) : null;
  return { store, handling, delivery, freeDeliveryFrom, otherFees: other, bills: usable.length };
}

export function estimateTotal(rule: FeeRule, itemsTotal: number): { fees: number; total: number } {
  const delivery = rule.freeDeliveryFrom != null && itemsTotal >= rule.freeDeliveryFrom ? 0 : rule.delivery;
  const fees = round(rule.handling + delivery + rule.otherFees);
  return { fees, total: round(itemsTotal + fees) };
}

/** The usual time for a one-item phone cart run in that store: the median of the last runs, else the measured start. */
export function phoneMs(store: ShopApp, bills: readonly StoreBill[]): number {
  const runs = bills
    .filter((bill) => bill.store === store && isNumber(bill.elapsedMs))
    .map((bill) => Math.max(1_000, (bill.elapsedMs ?? 0) - Math.max(0, (bill.lines ?? 1) - 1) * EXTRA_ITEM_MS))
    .slice(-5);
  return median(runs) ?? STARTING_PHONE_MS[store];
}

/** Each extra basket item is one more search and add on the phone. Not yet measured; a guess from single runs. */
export const EXTRA_ITEM_MS = 6_000;

export const BASKET_LIMIT = 12;

/** Ranks the stores by estimated total for one unit of the items each one would sell, cheapest first. */
export function quoteCarts(itemsByStore: Partial<Record<ShopApp, number>>, bills: readonly StoreBill[]): CartQuote {
  return quoteBasket([{ query: "", quantity: 1, prices: itemsByStore }], bills);
}

/**
 * Ranks the stores for a whole basket bought in one cart, so the fees count once and a basket can cross the
 * free-delivery level. Stores missing fewer items come first, then the lower total, then the quicker phone run.
 */
export function quoteBasket(lines: readonly BasketLine[], bills: readonly StoreBill[]): CartQuote {
  const estimates: StoreEstimate[] = [];
  for (const store of SHOPS) {
    let itemsTotal = 0;
    let units = 0;
    let found = 0;
    const missing: string[] = [];
    for (const line of lines) {
      const price = line.prices[store];
      if (price == null || !Number.isFinite(price) || price <= 0) {
        missing.push(line.query);
        continue;
      }
      itemsTotal += price * line.quantity;
      units += line.quantity;
      found += 1;
    }
    if (found === 0) continue;
    const rule = learnFees(store, bills);
    const { fees, total } = estimateTotal(rule, itemsTotal);
    const ms = phoneMs(store, bills) + (found - 1) * EXTRA_ITEM_MS;
    estimates.push({ store, itemsTotal: round(itemsTotal), fees, total, basis: rule.bills > 0 ? "learned" : "rough", phoneSeconds: Math.round(ms / 1000), units, missing });
  }
  estimates.sort((left, right) => left.missing.length - right.missing.length || left.total - right.total || left.phoneSeconds - right.phoneSeconds);
  return { estimates, best: estimates[0]?.store ?? null };
}

/** Quotes one unit of the cheapest shelf offer in each store. Merchant names are matched case-insensitively. */
export function quoteOffers(offers: readonly { merchant: string; rupees: number }[], bills: readonly StoreBill[]): CartQuote {
  const cheapest: Partial<Record<ShopApp, number>> = {};
  for (const offer of offers) {
    const store = SHOPS.find((shop) => shop === offer.merchant.toLowerCase());
    if (!store || !isMoney(offer.rupees) || offer.rupees <= 0) continue;
    const seen = cheapest[store];
    if (seen == null || offer.rupees < seen) cheapest[store] = offer.rupees;
  }
  return quoteCarts(cheapest, bills);
}

export function storeName(store: ShopApp): string {
  switch (store) {
    case "blinkit":
      return "Blinkit";
    case "zepto":
      return "Zepto";
    case "instamart":
      return "Instamart";
    default: {
      const neverStore: never = store;
      return neverStore;
    }
  }
}

/** One line for the chat: the predicted winner, its estimated total, and the phone time. */
export function quoteLine(quote: CartQuote): string | null {
  const best = quote.estimates[0];
  if (!best) return null;
  const others = quote.estimates.slice(1).map((estimate) => `${storeName(estimate.store)} ₹${estimate.total}${estimate.missing.length > 0 ? ` without ${estimate.missing.join(", ")}` : ""}`);
  const rest = others.length > 0 ? ` (${others.join(", ")})` : "";
  const gap = best.missing.length > 0 ? ` No store had everything; ${storeName(best.store)} is missing ${best.missing.join(", ")}.` : "";
  return `${storeName(best.store)} should come to about ₹${best.total} with fees${rest}. The phone fills it in about ${best.phoneSeconds} s.${gap}`;
}

/** Another store with every item whose estimate beats the bill the phone read, when there is one. */
export function cheaperElsewhere(quote: CartQuote, store: ShopApp, grandTotal: number | null): StoreEstimate | null {
  if (grandTotal == null) return null;
  return quote.estimates.find((estimate) => estimate.store !== store && estimate.missing.length === 0 && estimate.total < grandTotal) ?? null;
}

export function readCartQuote(raw: unknown): CartQuote | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { estimates?: unknown; best?: unknown };
  if (!Array.isArray(row.estimates)) return null;
  const estimates: StoreEstimate[] = [];
  for (const item of row.estimates.slice(0, SHOPS.length)) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    const store = SHOPS.find((shop) => shop === value.store);
    if (!store || !isMoney(value.itemsTotal) || !isMoney(value.fees) || !isMoney(value.total)) continue;
    if (value.basis !== "learned" && value.basis !== "rough") continue;
    const seconds = typeof value.phoneSeconds === "number" && Number.isFinite(value.phoneSeconds) ? Math.min(300, Math.max(1, Math.round(value.phoneSeconds))) : Math.round(STARTING_PHONE_MS[store] / 1000);
    const units = typeof value.units === "number" && Number.isInteger(value.units) && value.units > 0 ? Math.min(value.units, 200) : 1;
    const missing = Array.isArray(value.missing) ? value.missing.filter((entry): entry is string => typeof entry === "string").slice(0, BASKET_LIMIT).map((entry) => entry.slice(0, 80)) : [];
    estimates.push({ store, itemsTotal: value.itemsTotal, fees: value.fees, total: value.total, basis: value.basis, phoneSeconds: seconds, units, missing });
  }
  const best = SHOPS.find((shop) => shop === row.best) ?? estimates[0]?.store ?? null;
  return estimates.length > 0 ? { estimates, best } : null;
}

export function readCartEstimate(raw: unknown): CartEstimate | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { item?: unknown; quote?: unknown; lines?: unknown };
  const quote = readCartQuote(row.quote);
  if (typeof row.item !== "string" || !quote) return null;
  const lines = typeof row.lines === "number" && Number.isInteger(row.lines) ? Math.min(BASKET_LIMIT, Math.max(1, row.lines)) : 1;
  return { item: row.item.slice(0, 240), quote, lines };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] ?? null : round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

function isNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1_000_000;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
