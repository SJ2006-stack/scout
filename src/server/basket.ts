import { BASKET_LIMIT, quoteBasket, type BasketLine, type CartQuote, type StoreBill } from "../shared/cartQuote.ts";
import type { ProductRef, ShopApp } from "../shared/productRef.ts";
import { normalisedSize } from "../shared/quantity.ts";
import { isLiveShopQuery, type BasketRun, type ShopOffer } from "./browser/shelf.ts";

export type BasketItem = { query: string; quantity: number };

/** What the phone gets for one store: the app_cart_add arguments for every item that store had. */
export type StoreCart = { items: { ref: ProductRef; quantity: number; maxPrice: number }[]; allowSimilar: false };

export type BasketPlan = {
  label: string;
  quote: CartQuote;
  picks: Partial<Record<ShopApp, { query: string; offer: ShopOffer; quantity: number }[]>>;
  carts: Partial<Record<ShopApp, StoreCart>>;
};

const SHOPS: readonly ShopApp[] = ["blinkit", "zepto", "instamart"];
const PRICE_ROOM = 1.1;
const PLAN_TTL_MS = 30 * 60 * 1000;
const PLAN_LIMIT = 200;

const ASKING = /^(?:please\s+)?(?:(?:can|could) you\s+)?(?:find|compare|check|get|buy|order|search(?: for)?|i need|i want|need|want)\s+/i;
const SPLIT = /\s*(?:,|;|\+|&|\n|\band\b)\s*/i;
const UNIT = /^(?:kgs?|gms?|grams?|g|ml|l|ltrs?|litres?|liters?)\b/i;
const NOT_A_PART = /^(?:ok(?:ay)?|yes|yeah|no|sure|cool|great|nice|done|it|that|this|them|please|also)$/i;
const STORE_WORD = /\b(?:blinkit|zepto|instamart|swiggy)\b/i;

/** Two to six groceries named in one message, such as "Tata Salt 1 kg, Amul butter 100 g, 2 Maggi, bread". */
export function readBasket(text: string): BasketItem[] | null {
  const body = text.trim().replace(ASKING, "").replace(/[.!]+$/, "").replace(/\s+(?:for (?:me|us)|please|pls|asap)$/i, "");
  if (body.length > 240 || body.includes("?") || STORE_WORD.test(body)) return null;
  const parts = body.split(SPLIT).map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length < 2 || parts.length > BASKET_LIMIT) return null;
  const items: BasketItem[] = [];
  for (const part of parts) {
    const item = basketLine(part);
    if (!item || NOT_A_PART.test(item.query) || !isLiveShopQuery(item.query)) return null;
    if (!items.some((seen) => seen.query.toLowerCase() === item.query.toLowerCase())) items.push(item);
  }
  return items.length >= 2 ? items : null;
}

function basketLine(part: string): BasketItem | null {
  const ahead = part.match(/^(\d{1,2})\s*(?:x|×|packs?|packets?|pcs?)?\s+(.+)$/i);
  if (ahead?.[1] && ahead[2] && !UNIT.test(ahead[2])) return { query: ahead[2].trim(), quantity: Math.max(1, Number(ahead[1])) };
  const after = part.match(/^(.+?)\s*(?:x|×)\s*(\d{1,2})$/i);
  if (after?.[1] && after[2]) return { query: after[1].trim(), quantity: Math.max(1, Number(after[2])) };
  return part.length >= 2 ? { query: part, quantity: 1 } : null;
}

const YES = /^(?:(?:ok(?:ay)?|yes|yeah|yep|sure|please|go ahead|do it|go)[,!\s]*)+$/;
const BUY = /^(?:(?:ok(?:ay)?|yes|yeah|sure|please|go ahead)[,!\s]+)?(?:buy|order|get|add|fill|place)(?:\s+(?:it|them|this|that|these|those|all|everything|the (?:basket|cart|order|items)))?(?:\s+(?:to|in)\s+(?:my |the )?cart)?(?:\s+please)?$/;
const TAIL = /(?:\s+(?:then|now|instead|please|pls))+$/;

/** A go-ahead for the basket just compared, such as "buy it", "yes", or "order from Zepto then". */
export function readBuy(text: string): { store: ShopApp | "best" } | null {
  const said = text.trim().toLowerCase().replace(/[.!]+$/, "").replace(TAIL, "").trim();
  if (said.length === 0 || said.length > 60) return null;
  const store = said.match(/\b(blinkit|zepto|instamart)\b/)?.[1];
  const rest = said.replace(/\b(?:(?:on|from|in|at|with)\s+)?(?:blinkit|zepto|instamart)\b/g, " ").replace(/\s+/g, " ").trim();
  const named = store === "blinkit" || store === "zepto" || store === "instamart" ? store : null;
  if (YES.test(rest) || BUY.test(rest) || (named && rest.length === 0)) return { store: named ?? "best" };
  return null;
}

/** The cheapest offer a store showed for the item, of the size they named when the store has that size. */
export function pickOffer(offers: readonly ShopOffer[], query: string, store: ShopApp): ShopOffer | null {
  const own = offers.filter((offer) => offer.merchant.toLowerCase() === store && offer.ref);
  const size = normalisedSize(query);
  const sized = size ? own.filter((offer) => offer.ref?.size === size) : [];
  const pool = sized.length > 0 ? sized : own;
  return pool.reduce<ShopOffer | null>((best, offer) => (best == null || offer.rupees < best.rupees ? offer : best), null);
}

export function planBasket(items: readonly BasketItem[], run: BasketRun, bills: readonly StoreBill[]): BasketPlan {
  const picks: BasketPlan["picks"] = {};
  const lines: BasketLine[] = [];
  for (const item of items) {
    const offers = run.lines.find((line) => line.query === item.query)?.offers ?? [];
    const prices: BasketLine["prices"] = {};
    for (const store of SHOPS) {
      const offer = pickOffer(offers, item.query, store);
      if (!offer) continue;
      prices[store] = offer.rupees;
      (picks[store] ??= []).push({ query: item.query, offer, quantity: item.quantity });
    }
    lines.push({ query: item.query, quantity: item.quantity, prices });
  }
  const carts: BasketPlan["carts"] = {};
  for (const store of SHOPS) {
    const chosen = picks[store];
    if (!chosen || chosen.length === 0) continue;
    carts[store] = {
      items: chosen.flatMap(({ offer, quantity }) => (offer.ref ? [{ ref: offer.ref, quantity, maxPrice: Math.ceil(offer.rupees * PRICE_ROOM) }] : [])),
      allowSimilar: false,
    };
  }
  return { label: items.map((item) => (item.quantity > 1 ? `${item.quantity} × ${item.query}` : item.query)).join(", "), quote: quoteBasket(lines, bills), picks, carts };
}

/** The last basket compared in each chat, so ordering it does not depend on the model copying product links. */
export class BasketMemory {
  private readonly plans = new Map<string, { at: number; plan: BasketPlan }>();
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  save(sessionId: string, plan: BasketPlan): void {
    this.plans.delete(sessionId);
    this.plans.set(sessionId, { at: this.now(), plan });
    while (this.plans.size > PLAN_LIMIT) {
      const oldest = this.plans.keys().next().value;
      if (oldest === undefined) break;
      this.plans.delete(oldest);
    }
  }

  get(sessionId: string): BasketPlan | null {
    const saved = this.plans.get(sessionId);
    if (!saved || this.now() - saved.at > PLAN_TTL_MS) return null;
    return saved.plan;
  }

  forget(sessionId: string): void {
    this.plans.delete(sessionId);
  }
}
