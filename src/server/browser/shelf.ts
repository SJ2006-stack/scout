import { paymentTarget, paymentUrlInText, payPageUrl, type PayLink } from "../../shared/payLink.ts";
import type { IsolatedPage, PageElement } from "./driver.ts";
import { decodeQrPng } from "./qrPng.ts";
import type { AccountLogin } from "./signIn.ts";

export type ShopMerchant = "Blinkit" | "Zepto" | "Instamart";

export type ShopOffer = {
  merchant: ShopMerchant;
  title: string;
  rupees: number;
  pageUrl: string;
};

export type ShopRun = {
  offers: ShopOffer[];
  cheapest: ShopOffer | null;
  pay: PayLink | null;
  summary: string;
  signIn: string | null;
};

type Step = <T>(run: (signal: AbortSignal) => Promise<T>) => Promise<T>;

export const SHOP_SITES: readonly { merchant: ShopMerchant; home: string }[] = [
  { merchant: "Blinkit", home: "https://blinkit.com/" },
  { merchant: "Zepto", home: "https://www.zepto.com/" },
  { merchant: "Instamart", home: "https://www.swiggy.com/instamart" },
];

const PRICE = /₹\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/;

export function isLiveShopQuery(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > 80) return false;
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
    .replace(/^.*\b(?:Customer Ratings|Sort By|Quick filters)\b/i, " ")
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
    const title = (match[1] ?? "").replace(/\s+/g, " ").trim();
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

export type ShelfRead = { offers: ShopOffer[]; needsLocation: boolean };

export async function readShelf(page: IsolatedPage, query: string, merchant: ShopMerchant, step: Step): Promise<ShelfRead> {
  await step((signal) => page.goto(searchUrl(merchant, query), signal));
  let offers: ShopOffer[] = [];
  let needsLocation = false;
  let searched = false;
  for (let attempt = 0; attempt < 8 && offers.length === 0; attempt += 1) {
    if (attempt > 0) await pause(1_000);
    let elements = await step((signal) => page.elements(signal));
    const html = await step((signal) => page.html(signal));
    const landed = await step((signal) => page.location(signal));
    needsLocation = needsLocation || asksForLocation(html);
    offers = matching(offersFrom(merchant, landed.url, [...pricedTitles(elements), ...pricedText(html)]), query);
    if (offers.length > 0) break;
    if (attempt < 5) continue;
    const box = elements.find((element) => element.role === "searchbox" || element.role === "combobox" || (element.role === "textbox" && /search/i.test(element.name)));
    if (box && !searched) {
      await step((signal) => page.fill({ role: box.role, name: box.name, nth: 0 }, query, signal));
      searched = true;
      elements = await step((signal) => page.elements(signal));
    }
    const search = elements.find((element) => element.role === "button" && /search/i.test(element.name));
    if (!search) continue;
    await step((signal) => page.click({ role: search.role, name: search.name, nth: 0 }, signal));
  }
  return { offers, needsLocation };
}

function offersFrom(merchant: ShopMerchant, pageUrl: string, items: readonly { title: string; rupees: number }[]): ShopOffer[] {
  const seen = new Set<string>();
  const offers: ShopOffer[] = [];
  for (const item of items) {
    const key = `${item.title.toLowerCase()}\0${item.rupees}`;
    if (seen.has(key)) continue;
    seen.add(key);
    offers.push({ merchant, title: item.title, rupees: item.rupees, pageUrl });
  }
  return offers;
}

/** Keeps offers whose title names every query word. Store pages mix in ads and suggestions. */
export function matching(offers: readonly ShopOffer[], query: string): ShopOffer[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1);
  return offers.filter((offer) => {
    const title = offer.title.toLowerCase();
    return words.every((word) => title.includes(word) || (word.endsWith("s") && title.includes(word.slice(0, -1))));
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
