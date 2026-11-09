import type { ShopCompareOffer } from "../../shared/commerce.ts";
import { paymentTarget, paymentUrlInText, payPageUrl, type PayLink } from "../../shared/payLink.ts";
import type { ProductRef, ShopApp } from "../../shared/productRef.ts";
import { normalisedSize, withoutTrailingSize } from "../../shared/quantity.ts";
import type { IsolatedPage, PageElement } from "./driver.ts";
import { decodeQrPng } from "./qrPng.ts";
import type { AccountLogin } from "./signIn.ts";

export type ShopMerchant = "Blinkit" | "Zepto" | "Instamart";

export type ShopOffer = {
  merchant: ShopMerchant;
  title: string;
  rupees: number;
  pageUrl: string;
  /** Set on every offer the shelf reads. Link and product id stay null when the page does not show them. */
  ref?: ProductRef;
};

type Priced = {
  title: string;
  rupees: number;
  link: string | null;
  productId: string | null;
  size: string | null;
};

export type ShopRun = {
  offers: ShopOffer[];
  cheapest: ShopOffer | null;
  pay: PayLink | null;
  summary: string;
  signIn: string | null;
  /** The first listing from the search when none of them matched the asked words. */
  guess?: ShopOffer | null;
  /** Other packs on those pages, the asked brand first, when nothing matched exactly. */
  choices?: ShopOffer[];
};

/** Matching shelf offers for each basket item, from every store that opened. */
export type BasketRun = {
  lines: { query: string; offers: ShopOffer[] }[];
  opened: number;
  signIn: string | null;
};

type Step = <T>(run: (signal: AbortSignal) => Promise<T>) => Promise<T>;

export const SHOP_SITES: readonly { merchant: ShopMerchant; home: string }[] = [
  { merchant: "Blinkit", home: "https://blinkit.com/" },
  { merchant: "Zepto", home: "https://www.zepto.com/" },
  { merchant: "Instamart", home: "https://www.swiggy.com/instamart" },
];

const PRICE = /₹\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/;

const NOT_AN_ITEM = /\b(who are you|about yourself|about you|what can you do|what do you do|how are you|thank you|thanks|your name)\b/i;
const GREETING = /^(?:yo|hey|hi|hello|thanks|thank you)[.!\s]*$/i;

/** A greeting or a question about Scout itself. */
export function isChatter(text: string): boolean {
  const trimmed = text.trim();
  return NOT_AN_ITEM.test(trimmed) || GREETING.test(trimmed);
}

/** A grocery lookup. A greeting or a question about Scout is not one. */
export function isLiveShopQuery(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > 80) return false;
  if (isChatter(trimmed)) return false;
  if (/^(?:checkout|check out|quote)\b/i.test(trimmed)) return false;
  if (/^(?:show\s+(?:my\s+)?)?cart\b/i.test(trimmed)) return false;
  if (/^(?:add|select|set|update|change|remove|delete)\b/i.test(trimmed)) return false;
  return true;
}

/**
 * Reads "title ₹price" pairs from accessible names. One name can hold a whole
 * grid of products, as on Instamart, so every pair in it counts.
 */
export function pricedTitles(elements: readonly PageElement[]): { title: string; rupees: number }[] {
  const found: { title: string; rupees: number }[] = [];
  for (const element of elements) {
    if (element.role !== "link" && element.role !== "button" && element.role !== "text") continue;
    if (!PRICE.test(element.name)) continue;
    let start = 0;
    for (const match of element.name.matchAll(/₹\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g)) {
      const before = element.name.slice(start, match.index);
      start = (match.index ?? 0) + match[0].length;
      const rupees = Number((match[1] ?? "").replace(/,/g, ""));
      if (!Number.isFinite(rupees) || rupees <= 0) continue;
      const title = cleanTitle(before);
      if (title.length < 2 || /^(?:fee|tax|charge|mrp)\b/i.test(title) || /delivery fee|handling|platform fee/i.test(title)) continue;
      found.push({ title, rupees });
    }
  }
  return found;
}

function cleanTitle(text: string): string {
  return text
    .replace(/^.*\b(?:Customer Ratings|Sort By|Quick filters|Your cart is empty)\b/i, " ")
    .replace(/^.*\bShowing results for\s*["“][^"”]*["”]/i, " ")
    .replace(/\b\d{1,3}% OFF\b/gi, " ")
    .replace(/\b(?:Ad|ADD|\d+ MINS?|\d+ mins)\b|\S+\.(?:png|jpe?g|webp|svg)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-90)
    .trim();
}

export function cheapestOffer(offers: readonly ShopOffer[]): ShopOffer | null {
  return offers.reduce<ShopOffer | null>((best, offer) => (best == null || offer.rupees < best.rupees ? offer : best), null);
}

export function shelfSummary(offers: readonly ShopOffer[]): string {
  const cheapest = cheapestOffer(offers);
  if (!cheapest) return "Scout opened Blinkit, Zepto, and Instamart. None of them showed a matching price.";
  const others = SHOP_SITES
    .map((site) => cheapestOffer(offers.filter((offer) => offer.merchant === site.merchant)))
    .filter((offer): offer is ShopOffer => offer != null && offer.merchant !== cheapest.merchant)
    .map((offer) => `${offer.merchant} from ₹${offer.rupees} (${offer.title})`);
  const missing = SHOP_SITES.filter((site) => !offers.some((offer) => offer.merchant === site.merchant)).map((site) => site.merchant);
  const lead = `${cheapest.merchant} is cheapest: ${cheapest.title} at ₹${cheapest.rupees}.`;
  const rest = others.length > 0 ? ` ${others.join(". ")}.` : "";
  const gap = missing.length > 0 ? ` ${missing.join(" and ")} showed no match.` : "";
  return `${lead}${rest}${gap}`;
}

/** The same search pages the shop check opens, kept so they can be opened again. */
export function shopSearchPlaces(query: string): { app: ShopMerchant; label: string; url: string }[] {
  const item = query.trim().slice(0, 40);
  return SHOP_SITES.map((site) => ({
    app: site.merchant,
    label: `Open ${item} on ${site.merchant}`,
    url: searchUrl(site.merchant, item),
  }));
}

export function searchUrl(merchant: ShopMerchant, query: string): string {
  const q = encodeURIComponent(query.trim().slice(0, 80));
  switch (merchant) {
    case "Blinkit":
      return `https://blinkit.com/s/?q=${q}`;
    case "Zepto":
      return `https://www.zepto.com/search?query=${q}`;
    case "Instamart":
      return `https://www.swiggy.com/instamart/search?query=${q}`;
    default: {
      const neverMerchant: never = merchant;
      return neverMerchant;
    }
  }
}

export function pricedText(html: string): { title: string; rupees: number }[] {
  const plain = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#8377;|&rupee;/gi, (token) => (/rupee|8377/i.test(token) ? "₹" : " "))
    .replace(/\s+/g, " ");
  const found: { title: string; rupees: number }[] = [];
  for (const match of plain.matchAll(/([A-Za-z][^₹]{1,70}?)\s*₹\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g)) {
    const title = cleanTitle(match[1] ?? "");
    const rupees = Number((match[2] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(rupees) || rupees <= 0 || title.length < 2 || /fee|tax|charge/i.test(title)) continue;
    found.push({ title, rupees });
    if (found.length >= 8) break;
  }
  return found;
}

export function asksForLocation(html: string): boolean {
  return /select your location|choose your location|enter your (?:delivery )?location|add your location|where do you want the delivery/i.test(html);
}

export type ShelfRead = { offers: ShopOffer[]; needsLocation: boolean; guess: ShopOffer | null; choices: ShopOffer[] };

/** Exact title matches stay. When none match, confirm a listing that shares the brand, not the first unrelated product. */
export function pickShelf(found: readonly ShopOffer[], query: string): { offers: ShopOffer[]; guess: ShopOffer | null } {
  const offers = matching(found, query);
  if (offers.length > 0) return { offers, guess: null };
  const words = contentWords(query);
  const guess = words.length === 0 ? found[0] ?? null : found.find((offer) => sharesBrand(offer.title, words)) ?? null;
  return { offers: [], guess };
}

/** What to show when the first search listing is not an exact match. */
export function shelfGuessLine(offer: ShopOffer): string {
  return `${offer.merchant} listed ${offer.title} at ₹${offer.rupees}. Is that what you're looking for?`;
}

/** The asked brand first, then other brands of the same product. An unrelated listing stays out. */
export function shelfChoices(found: readonly ShopOffer[], query: string): ShopOffer[] {
  const words = contentWords(query);
  const exact = new Set(matching(found, query));
  const related = words.length === 0 ? [...found] : found.filter((offer) => exact.has(offer) || sharesAny(offer.title, words));
  const brand = related.filter((offer) => exact.has(offer) || sharesBrand(offer.title, words));
  const ordered = [...brand, ...related.filter((offer) => !brand.includes(offer))];
  const seen = new Set<string>();
  const choices: ShopOffer[] = [];
  for (const offer of ordered) {
    const key = offer.title.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push(offer);
    if (choices.length === 4) break;
  }
  return choices;
}

export function shelfChoiceLine(offers: readonly ShopOffer[]): string {
  const names = offers.map((offer) => `${offer.title} at ₹${offer.rupees} on ${offer.merchant}`);
  return `I found ${names.join("; ")}. Which pack?`;
}

/** Zepto finds nothing for "amul butter 100 g", so stores get the words without a size and the size filters the results. */
const SIZE_UNIT = "kgs?|gms?|grams?|g|ml|ltrs?|litres?|liters?|l";

/** Stores are searched without the size. A form answer like "Gowardhan Ghee (500 g)" must not keep the empty brackets. */
export function searchTerms(query: string): string {
  const words = query
    .replace(new RegExp(`\\(\\s*\\d+(?:\\.\\d+)?\\s*(?:${SIZE_UNIT})\\s*\\)`, "gi"), " ")
    .replace(new RegExp(`\\b\\d+(?:\\.\\d+)?\\s*(?:${SIZE_UNIT})\\b`, "gi"), " ")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return words.length >= 2 ? words : query.trim();
}

export async function readShelf(page: IsolatedPage, query: string, merchant: ShopMerchant, step: Step): Promise<ShelfRead> {
  const terms = searchTerms(query);
  await step((signal) => page.goto(searchUrl(merchant, terms), signal));
  let offers: ShopOffer[] = [];
  let guess: ShopOffer | null = null;
  let listed: ShopOffer[] = [];
  let needsLocation = false;
  let searched = false;
  const seenAt = Date.now();
  for (let attempt = 0; attempt < 8 && offers.length === 0; attempt += 1) {
    if (attempt > 0) await pause(1_000);
    let elements = await step((signal) => page.elements(signal));
    const html = await step((signal) => page.html(signal));
    const landed = await step((signal) => page.location(signal));
    needsLocation = needsLocation || asksForLocation(html);
    const found = collectShelfOffers(merchant, landed.url, elements, html, seenAt);
    listed = [...listed, ...found];
    const picked = pickShelf(found, query);
    if (picked.guess) guess = picked.guess;
    offers = picked.offers;
    if (offers.length > 0) break;
    if (attempt < 5) continue;
    const box = elements.find((element) => element.role === "searchbox" || element.role === "combobox" || (element.role === "textbox" && /search/i.test(element.name)));
    if (box && !searched) {
      await step((signal) => page.fill({ role: box.role, name: box.name, nth: 0 }, terms, signal));
      searched = true;
      elements = await step((signal) => page.elements(signal));
    }
    const search = elements.find((element) => element.role === "button" && /search/i.test(element.name));
    if (!search) continue;
    await step((signal) => page.click({ role: search.role, name: search.name, nth: 0 }, signal));
  }
  const choices = shelfChoices(listed, query);
  return { offers, needsLocation, guess: offers.length > 0 ? null : choices[0] ?? guess, choices };
}

function offersFrom(merchant: ShopMerchant, pageUrl: string, items: readonly Priced[], seenAt: number): ShopOffer[] {
  const seen = new Set<string>();
  const offers: ShopOffer[] = [];
  for (const item of items) {
    const key = item.productId ? `${merchant}\0${item.productId}` : `${item.title.toLowerCase()}\0${item.rupees}`;
    if (seen.has(key)) continue;
    seen.add(key);
    offers.push({
      merchant,
      title: item.title,
      rupees: item.rupees,
      pageUrl,
      ref: productRefFor(merchant, item, seenAt),
    });
  }
  return offers;
}

/** The compare row the chat already reads. Existing fields stay; `ref` is added when the shelf stored one. */
export function shopCompareView(offer: ShopOffer): ShopCompareOffer {
  const view: ShopCompareOffer = { merchant: offer.merchant, title: offer.title, rupees: offer.rupees };
  if (offer.ref) view.ref = offer.ref;
  return view;
}

/**
 * Prices from the accessibility tree, plus a product link when the page HTML has one.
 * Blinkit search cards are buttons whose id is the product id; the link is the same path the site builds.
 * Zepto cards are anchors. Instamart's item id is not in the search HTML, so those stay null unless an item href is present.
 */
export function collectShelfOffers(
  merchant: ShopMerchant,
  pageUrl: string,
  elements: readonly PageElement[],
  html: string,
  seenAt: number,
): ShopOffer[] {
  const textItems = [...pricedTitles(elements), ...pricedText(html)];
  const cards = productCardsFromHtml(merchant, html);
  const used = new Set<number>();
  const items: Priced[] = textItems.map((item) => {
    const index = cards.findIndex((card, cardIndex) => !used.has(cardIndex) && card.rupees === item.rupees && titlesClose(card.title, item.title));
    if (index < 0) return { title: item.title, rupees: item.rupees, link: null, productId: null, size: normalisedSize(item.title) };
    used.add(index);
    const card = cards[index];
    if (!card) return { title: item.title, rupees: item.rupees, link: null, productId: null, size: normalisedSize(item.title) };
    return {
      title: item.title,
      rupees: item.rupees,
      link: card.link,
      productId: card.productId,
      size: normalisedSize(item.title) ?? card.size,
    };
  });
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    if (card && !used.has(index)) items.push(card);
  }
  return offersFrom(merchant, pageUrl, items, seenAt);
}

function titlesClose(left: string, right: string): boolean {
  const a = withUnits(left);
  const b = withUnits(right);
  return a.includes(b) || b.includes(a);
}

function productRefFor(merchant: ShopMerchant, item: Priced, seenAt: number): ProductRef {
  return {
    store: shopApp(merchant),
    productId: item.productId,
    link: item.link,
    name: item.title,
    size: item.size ?? normalisedSize(item.title),
    price: item.rupees,
    seenAt,
  };
}

function shopApp(merchant: ShopMerchant): ShopApp {
  switch (merchant) {
    case "Blinkit":
      return "blinkit";
    case "Zepto":
      return "zepto";
    case "Instamart":
      return "instamart";
    default: {
      const neverMerchant: never = merchant;
      return neverMerchant;
    }
  }
}

/** A product href for this store, or null when the URL is a search page or a different host. */
export function parseShopLink(merchant: ShopMerchant, href: string): { link: string | null; productId: string | null } | null {
  const url = shopUrl(merchant, href);
  if (!url) return null;
  switch (merchant) {
    case "Blinkit":
      return blinkitLink(url);
    case "Zepto":
      return zeptoLink(url);
    case "Instamart":
      return instamartLink(url);
    default: {
      const neverMerchant: never = merchant;
      return neverMerchant;
    }
  }
}

export function productCardsFromHtml(merchant: ShopMerchant, html: string): Priced[] {
  const source = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const byId = new Map<string, Priced>();
  const loose: Priced[] = [];
  if (merchant === "Blinkit") {
    for (const card of blinkitIdCards(source)) {
      if (card.productId && !byId.has(card.productId)) byId.set(card.productId, card);
    }
  }
  for (const anchor of source.matchAll(/<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = anchor[1] ?? anchor[2] ?? "";
    const parsed = parseShopLink(merchant, href);
    if (!parsed?.productId && !parsed?.link) continue;
    const body = anchor[3] ?? "";
    const title = cardTitle(body);
    const rupees = firstPrice(body);
    if (!title || rupees == null || !parsed) continue;
    const card: Priced = {
      title,
      rupees,
      link: parsed.link,
      productId: parsed.productId,
      size: normalisedSize(title),
    };
    if (card.productId && card.link) byId.set(card.productId, card);
    else if (card.productId && !byId.has(card.productId)) byId.set(card.productId, card);
    else if (!card.productId) loose.push(card);
  }
  return [...byId.values(), ...loose];
}

function blinkitIdCards(html: string): Priced[] {
  const ids = [...html.matchAll(/\bid="(\d{4,})"/g)];
  const cards: Priced[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index]?.[1];
    const attrAt = ids[index]?.index ?? 0;
    const contentStart = html.indexOf(">", attrAt);
    const start = contentStart >= 0 ? contentStart + 1 : attrAt;
    const nextAttr = ids[index + 1]?.index;
    const nextTag = nextAttr == null ? html.length : html.lastIndexOf("<", nextAttr);
    const end = nextTag > start ? nextTag : (nextAttr ?? html.length);
    if (!id) continue;
    const slice = html.slice(start, Math.min(end, start + 8_000));
    const title = cardTitle(slice);
    const rupees = firstPrice(slice);
    if (!title || rupees == null) continue;
    const slug = blinkitSlug(withoutTrailingSize(title));
    cards.push({
      title,
      rupees,
      link: slug && slug !== "x" ? `https://blinkit.com/prn/${slug}/prid/${id}` : null,
      productId: id,
      size: normalisedSize(title),
    });
  }
  return cards;
}

/** Blinkit's own product path: lowercase, drop punctuation, collapse spaces. A slug of "x" does not open the app. */
function blinkitSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s.-]/g, "").replace(/(?:-|\s)+/g, "-").replace(/^-+|-+$/g, "");
}

function blinkitLink(url: URL): { link: string | null; productId: string | null } | null {
  const host = url.hostname.toLowerCase();
  if (host !== "blinkit.com" && host !== "www.blinkit.com") return null;
  const match = /^\/prn\/([^/]+)\/prid\/(\d+)\/?$/.exec(url.pathname);
  const slug = match?.[1] ?? "";
  const productId = match?.[2] ?? "";
  if (!slug || !productId) return null;
  const link = slug.toLowerCase() === "x" ? null : `https://blinkit.com/prn/${slug}/prid/${productId}`;
  return { link, productId };
}

function zeptoLink(url: URL): { link: string | null; productId: string | null } | null {
  const host = url.hostname.toLowerCase();
  if (host !== "zepto.com" && host !== "www.zepto.com") return null;
  const match = /^\/pn\/([^/]+)\/pvid\/([0-9a-f-]{36})\/?$/i.exec(url.pathname);
  const slug = match?.[1] ?? "";
  const productId = (match?.[2] ?? "").toLowerCase();
  if (!slug || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(productId)) return null;
  return { link: `https://www.zepto.com/pn/${slug}/pvid/${productId}`, productId };
}

function instamartLink(url: URL): { link: string | null; productId: string | null } | null {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/$/, "");
  if (host === "www.swiggy.com" || host === "swiggy.com") {
    const match = /^\/instamart\/item\/([A-Za-z0-9]{4,32})$/.exec(path);
    const productId = match?.[1] ?? "";
    if (!productId) return null;
    return { link: `https://www.swiggy.com/instamart/item/${productId}`, productId };
  }
  if (host === "instamart.in" || host === "www.instamart.in") {
    const match = /^\/item\/([A-Za-z0-9]{4,32})$/.exec(path);
    const productId = match?.[1] ?? "";
    if (!productId) return null;
    return { link: `https://instamart.in/item/${productId}`, productId };
  }
  return null;
}

function shopUrl(merchant: ShopMerchant, href: string): URL | null {
  const trimmed = href.trim();
  if (!trimmed || /^(?:javascript|data|file):/i.test(trimmed)) return null;
  const base = merchant === "Blinkit" ? "https://blinkit.com" : merchant === "Zepto" ? "https://www.zepto.com" : "https://www.swiggy.com";
  try {
    return new URL(trimmed, base);
  } catch {
    return null;
  }
}

function cardTitle(html: string): string {
  return cleanTitle(textOf(html).replace(/₹\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?/g, " "));
}

function firstPrice(html: string): number | null {
  const match = /₹\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/.exec(textOf(html));
  if (!match?.[1]) return null;
  const rupees = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(rupees) && rupees > 0 ? rupees : null;
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#8377;|&rupee;/gi, (token) => (/rupee|8377/i.test(token) ? "₹" : " "))
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Keeps offers whose title names every query word. Store pages mix in ads and suggestions.
 * Instamart's web search shows no sizes, so a size they asked for only rules out an offer that shows a different one.
 */
const WORD_ALIAS: Record<string, string> = { gowardhan: "govardhan" };

function canonWord(word: string): string {
  return WORD_ALIAS[word] ?? word;
}

function contentWords(query: string): string[] {
  return withUnits(query).split(/[^a-z0-9]+/).filter((word) => word.length > 1 && !SIZE_WORD.test(word)).map(canonWord);
}

function titleWords(title: string): Set<string> {
  return new Set(withUnits(title).split(/[^a-z0-9]+/).map(canonWord));
}

function sharesBrand(title: string, words: readonly string[]): boolean {
  const names = titleWords(title);
  const brand = [...words].sort((left, right) => right.length - left.length)[0];
  return brand != null && names.has(brand);
}

function sharesAny(title: string, words: readonly string[]): boolean {
  const names = titleWords(title);
  return words.some((word) => names.has(word));
}

export function matching(offers: readonly ShopOffer[], query: string): ShopOffer[] {
  const words = withUnits(query).split(/[^a-z0-9]+/).filter((word) => word.length > 1).map(canonWord);
  return offers.filter((offer) => {
    const size = offer.ref?.size ?? normalisedSize(offer.title);
    const title = new Set(withUnits(`${offer.title} ${size ?? ""}`).split(/[^a-z0-9]+/).map(canonWord));
    const has = (word: string) => title.has(word) || title.has(`${word}s`) || title.has(`${word}es`);
    return words.every((word) => has(word) || (word.endsWith("s") && has(word.slice(0, -1))) || (size == null && SIZE_WORD.test(word)));
  });
}

const SIZE_WORD = /^\d+(?:\.\d+)?(?:kg|g|ml|l|pc)$/;

/** Stores write sizes as "500 g", "500 gm", or "500g"; one spelling lets a sized query match any of them. */
function withUnits(text: string): string {
  return text
    .toLowerCase()
    .replace(/(\d+(?:\.\d+)?)\s*(kgs?|gms?|grams?|g|ml|ltrs?|litres?|liters?|l|pcs?|pieces?)\b/g, (_, amount: string, unit: string) => {
      const short = /^k/.test(unit) ? "kg" : /^g/.test(unit) ? "g" : unit === "ml" ? "ml" : /^l/.test(unit) ? "l" : "pc";
      return `${amount}${short}`;
    });
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function checkoutShelf(page: IsolatedPage, offer: ShopOffer, step: Step): Promise<PayLink | null> {
  await readShelf(page, offer.title, offer.merchant, step);
  return clickThroughPay(page, offer.merchant, offer.title, `₹${offer.rupees}`, step);
}

export type AttendResult = { pay: PayLink | null; message: string };

export async function attendListing(
  page: IsolatedPage,
  pageUrl: string,
  merchant: string,
  title: string,
  account: AccountLogin | null,
  step: Step,
): Promise<AttendResult> {
  const here = await step((signal) => page.location(signal));
  if (here.url !== pageUrl) await step((signal) => page.goto(pageUrl, signal));
  const opened = await step((signal) => page.elements(signal));
  if (registerControl(opened)) {
    const message = await completeRegistration(page, title, account, step);
    const pay = await clickPayOnly(page, merchant, title, step);
    return { pay, message: pay ? payOutcome(merchant, pay) : message };
  }
  const pay = await clickThroughPay(page, merchant, title, null, step);
  if (pay?.source === "page" && merchant === "Luma") {
    return { pay: null, message: `Registration did not finish for ${title}.` };
  }
  return { pay, message: pay ? payOutcome(merchant, pay) : "The pay link was not on the page." };
}

export async function payFromListing(page: IsolatedPage, pageUrl: string, merchant: string, title: string, step: Step): Promise<PayLink | null> {
  const result = await attendListing(page, pageUrl, merchant, title, null, step);
  return result.pay;
}

export function registerControl(elements: readonly PageElement[]): PageElement | null {
  return elements.find((element) => (element.role === "button" || element.role === "link") && isRegisterButton(element.name)) ?? null;
}

export function registrationField(elements: readonly PageElement[], account: AccountLogin | null): { name: string; value: string } | null {
  if (!account) return null;
  const phone = account.phone?.replace(/^\+91/, "") ?? null;
  const fields: { pattern: RegExp; value: string | null }[] = [
    { pattern: /full name|^name$/i, value: account.name ?? null },
    { pattern: /e-?mail/i, value: account.email },
    { pattern: /phone|mobile/i, value: phone },
  ];
  for (const field of fields) {
    if (!field.value) continue;
    const box = elements.find((element) => element.role === "textbox" && field.pattern.test(element.name));
    if (box) return { name: box.name, value: field.value };
  }
  return null;
}

async function completeRegistration(page: IsolatedPage, title: string, account: AccountLogin | null, step: Step): Promise<string> {
  const seen = new Set<string>();
  let submitted = false;
  let clicks = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const elements = await step((signal) => page.elements(signal));
    if (elements.some((element) => element.role === "textbox" && /code|otp/i.test(element.name))) {
      return "A registration code was sent. Approve it on your phone and Scout finishes the signup.";
    }
    const field = registrationField(elements, account);
    if (field && !seen.has(`fill\0${field.name}`)) {
      seen.add(`fill\0${field.name}`);
      await step((signal) => page.fill({ role: "textbox", name: field.name, nth: 0 }, field.value, signal));
      continue;
    }
    const button = elements.find((element) => (element.role === "button" || element.role === "link") && isRegisterSubmit(element.name));
    if (!button || clicks >= 3) break;
    clicks += 1;
    const nth = elements.filter((element) => element.role === button.role && element.name === button.name).length - 1;
    await step((signal) => page.click({ role: button.role, name: button.name, nth }, signal));
    submitted = true;
  }
  const html = await step((signal) => page.html(signal));
  if (/you(?:'|’)re going|you(?:'|’)re registered|registration complete|rsvp confirmed/i.test(html)) {
    return `Registered for ${title}.`;
  }
  return submitted ? `Scout submitted the registration for ${title}.` : `Registration did not finish for ${title}.`;
}

function isRegisterButton(name: string): boolean {
  return /^register$|^rsvp$|request to join|get tickets/i.test(name.trim());
}

function isRegisterSubmit(name: string): boolean {
  return isRegisterButton(name) || /^submit$|^continue$/i.test(name.trim());
}

const CLICKS = 8;

async function clickThroughPay(page: IsolatedPage, merchant: string, title: string, amount: string | null, step: Step): Promise<PayLink | null> {
  const seen = new Set<string>();
  for (let attempt = 0; attempt < CLICKS; attempt += 1) {
    const elements = await step((signal) => page.elements(signal));
    const next = nextCheckoutClick(elements, title, seen);
    if (!next) break;
    seen.add(`${next.role}\0${next.name}`);
    await step((signal) => page.click({ role: next.role, name: next.name, nth: 0 }, signal));
  }
  return payFromPage(page, merchant, title, amount, step);
}

async function clickPayOnly(page: IsolatedPage, merchant: string, title: string, step: Step): Promise<PayLink | null> {
  const seen = new Set<string>();
  let clicked = false;
  for (let attempt = 0; attempt < CLICKS; attempt += 1) {
    const elements = await step((signal) => page.elements(signal));
    const next = nextPayClick(elements, seen);
    if (!next) break;
    seen.add(`${next.role}\0${next.name}`);
    clicked = true;
    await step((signal) => page.click({ role: next.role, name: next.name, nth: 0 }, signal));
  }
  if (!clicked) return null;
  return payFromPage(page, merchant, title, null, step);
}

export function nextCheckoutClick(elements: readonly PageElement[], title: string, seen: ReadonlySet<string>): PageElement | null {
  const needle = title.trim().toLowerCase();
  const fresh = (element: PageElement): boolean => !seen.has(`${element.role}\0${element.name}`);
  const product = elements.find((element) => element.role === "link" && needle.length > 0 && element.name.toLowerCase().includes(needle) && fresh(element));
  if (product) return product;
  const add = elements.find((element) => element.role === "button" && /add to cart|^add$/i.test(element.name) && fresh(element));
  if (add) return add;
  const offer = elements.find((element) => element.role === "button" && /apply|coupon|offer|discount/i.test(element.name) && fresh(element));
  if (offer) return offer;
  const cart = elements.find((element) => (element.role === "button" || element.role === "link") && isCartButton(element.name) && fresh(element));
  if (cart) return cart;
  return nextPayClick(elements, seen);
}

export function nextPayClick(elements: readonly PageElement[], seen: ReadonlySet<string>): PageElement | null {
  const fresh = (element: PageElement): boolean => !seen.has(`${element.role}\0${element.name}`);
  return elements.find((element) => (element.role === "button" || element.role === "link") && isPayButton(element.name) && fresh(element)) ?? null;
}

export function payResultLine(pay: PayLink): string {
  return payOutcome(pay.merchant, pay);
}

function payOutcome(merchant: string, pay: PayLink): string {
  switch (pay.source) {
    case "deeplink":
      return `${merchant} opened a UPI link.`;
    case "qr":
      return `${merchant} showed a payment QR.`;
    case "page":
      return `${merchant} opened the pay page.`;
    default: {
      const neverSource: never = pay.source;
      return neverSource;
    }
  }
}

export async function payFromPage(page: IsolatedPage, merchant: string, title: string, amount: string | null, step: Step): Promise<PayLink | null> {
  const requested = paymentTarget(page.takePayment() ?? "");
  if (requested) return { url: requested, source: "deeplink", merchant, title, amount };
  const html = await step((signal) => page.html(signal));
  const written = paymentUrlInText(html);
  if (written) return { url: written, source: "deeplink", merchant, title, amount };
  const shot = await step((signal) => page.screenshot(signal));
  const scanned = decodeQrPng(shot);
  if (scanned) {
    return {
      url: scanned,
      source: paymentTarget(scanned) ? "qr" : "page",
      merchant,
      title,
      amount,
    };
  }
  const landed = await step((signal) => page.location(signal));
  const pageUrl = payPageUrl(landed.url);
  if (!pageUrl) return null;
  return { url: pageUrl, source: "page", merchant, title, amount };
}

function isCartButton(name: string): boolean {
  return /checkout|proceed|continue to pay|^continue$/i.test(name.trim());
}

function isPayButton(name: string): boolean {
  return /pay|upi|gpay|phonepe|paytm|bhim|google pay|book ticket|buy ticket|^book$|^buy$/i.test(name.trim());
}
