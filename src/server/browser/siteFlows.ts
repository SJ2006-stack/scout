import type { CartFee, CartLine, CartReview } from "./checkoutLedger.ts";
import type { IsolatedPage, PageElement } from "./driver.ts";
import type { AccountLogin } from "./signIn.ts";
import { validateStage, type PageRead, type SkillStage, type StageCheck, type WebsiteSkill } from "./skills.ts";

export type Step = <T>(run: (signal: AbortSignal) => Promise<T>) => Promise<T>;

export type SignInOutcome =
  | { kind: "signed_in" }
  | { kind: "needs_user"; detail: string }
  | { kind: "failed"; detail: string };

export type CodeRequest = (channel: "sms" | "email") => Promise<string>;

const TEXT_ROLES = new Set(["textbox", "searchbox", "combobox"]);
const PRESS_ROLES = new Set(["button", "link"]);
const PASSWORD = /password/i;
const RUPEES = /₹\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/;
/** Store pages draw their login controls after load, later still through the phone relay. */
const SIGN_IN_SETTLE_ROUNDS = 8;

export async function readPage(page: IsolatedPage, step: Step): Promise<PageRead> {
  const elements = await step((signal) => page.elements(signal));
  const html = await step((signal) => page.html(signal));
  const where = await step((signal) => page.location(signal));
  return { url: where.url, elements, text: plainText(html) };
}

export async function checkStage(page: IsolatedPage, skill: WebsiteSkill, stage: SkillStage, step: Step): Promise<{ read: PageRead; check: StageCheck }> {
  const read = await readPage(page, step);
  return { read, check: validateStage(skill, stage, read) };
}

/**
 * Signs in with the user's phone number or email using the skill's controls.
 * When a code field appears it asks for an authorised code and waits.
 * Passwords, passkeys, QR codes, and CAPTCHAs are left to the user.
 */
export async function signInWithSkill(page: IsolatedPage, skill: WebsiteSkill, account: AccountLogin, step: Step, requestCode: CodeRequest, settleMs = 1_000): Promise<SignInOutcome> {
  const filled = new Set<string>();
  const pressed = new Set<string>();
  let usedCode = false;
  let channel: "sms" | "email" = "sms";
  let settles = 0;
  for (let round = 0; round < 10 + SIGN_IN_SETTLE_ROUNDS; round += 1) {
    const read = await readPage(page, step);
    if (validateStage(skill, "signed_in", read).ok) return { kind: "signed_in" };
    if (skill.failure.captcha.test(read.text)) return { kind: "needs_user", detail: `${skill.name} is showing a CAPTCHA. Solve it on the site, then try again.` };
    if (skill.failure.blocked.test(read.text)) return { kind: "failed", detail: `${skill.name} blocked the automated browser.` };
    const fields = read.elements.filter((element) => TEXT_ROLES.has(element.role));
    const buttons = read.elements.filter((element) => PRESS_ROLES.has(element.role));
    if (fields.some((element) => PASSWORD.test(element.name))) {
      return { kind: "needs_user", detail: `${skill.name} asks for a password. Scout never stores passwords, so sign in on the site yourself once.` };
    }
    const codeBox = fields.find((element) => skill.login.codeField.test(element.name) && !skill.login.phoneField.test(element.name));
    if (codeBox && filled.size > 0) {
      if (usedCode) {
        const verify = buttons.find((element) => skill.login.verify.test(element.name) && !pressed.has(key(element)));
        if (verify) {
          pressed.add(key(verify));
          await press(page, read.elements, verify, step);
          continue;
        }
        return { kind: "failed", detail: `${skill.name} did not accept the code.` };
      }
      const code = await requestCode(channel);
      usedCode = true;
      await step((signal) => page.fill({ role: codeBox.role, name: codeBox.name, nth: 0 }, code, signal));
      const verify = buttons.find((element) => skill.login.verify.test(element.name));
      if (verify) {
        pressed.add(key(verify));
        await press(page, read.elements, verify, step);
      }
      continue;
    }
    const phoneBox = account.phone && skill.login.methods.includes("phone")
      ? fields.find((element) => skill.login.phoneField.test(element.name) && !filled.has(key(element)))
      : undefined;
    if (phoneBox && account.phone) {
      filled.add(key(phoneBox));
      channel = "sms";
      await step((signal) => page.fill({ role: phoneBox.role, name: phoneBox.name, nth: 0 }, localPhone(account.phone ?? ""), signal));
      await sendCode(page, read.elements, skill, pressed, step);
      continue;
    }
    const emailBox = skill.login.methods.includes("email")
      ? fields.find((element) => skill.login.emailField.test(element.name) && !filled.has(key(element)))
      : undefined;
    if (emailBox) {
      filled.add(key(emailBox));
      channel = "email";
      await step((signal) => page.fill({ role: emailBox.role, name: emailBox.name, nth: 0 }, account.email, signal));
      await sendCode(page, read.elements, skill, pressed, step);
      continue;
    }
    if (filled.size > 0) {
      const send = buttons.find((element) => skill.login.sendCode.test(element.name) && !pressed.has(key(element)));
      if (send) {
        pressed.add(key(send));
        await press(page, read.elements, send, step);
        continue;
      }
    }
    const open = buttons.find((element) => skill.login.openLogin.test(element.name.trim()) && !pressed.has(key(element)))
      ?? read.elements.find((element) => element.role === "text" && skill.login.openLogin.test(element.name.trim()) && !pressed.has(key(element)));
    if (open) {
      pressed.add(key(open));
      await press(page, read.elements, open, step);
      continue;
    }
    if (filled.size === 0 && !account.phone && skill.login.methods.every((method) => method === "phone")) {
      return { kind: "needs_user", detail: `${skill.name} signs in with a phone number. Add one in Settings.` };
    }
    if (settles < SIGN_IN_SETTLE_ROUNDS) {
      settles += 1;
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      continue;
    }
    return { kind: "failed", detail: `${skill.name} showed no sign-in step Scout recognises.` };
  }
  return { kind: "failed", detail: `${skill.name} sign-in did not finish.` };
}

/**
 * Sets the delivery location with the site's own "detect my location" control,
 * which reads the geolocation the browser context was opened with.
 */
export async function ensureLocation(page: IsolatedPage, skill: WebsiteSkill, step: Step, area: string | null = null): Promise<boolean> {
  const locateIn = (read: PageRead) => read.elements.find((element) => PRESS_ROLES.has(element.role) && skill.failure.locate.test(element.name.trim()));
  const boxIn = (read: PageRead) => read.elements.find((element) => TEXT_ROLES.has(element.role) && skill.failure.locationBox.test(element.name));
  const settled = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const read = await readPage(page, step);
      if (!locateIn(read) && !boxIn(read)) return true;
    }
    return false;
  };
  let read = await readPage(page, step);
  if (!locateIn(read) && !boxIn(read)) return true;
  const typed = area?.trim() ?? "";
  const box = boxIn(read);
  if (typed.length >= 3 && box) {
    await step((signal) => page.fill({ role: box.role, name: box.name, nth: 0 }, typed, signal));
    const first = typed.split(/[\s,]+/)[0]?.toLowerCase() ?? "";
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      read = await readPage(page, step);
      const suggestion = read.elements.find((element) => element.name !== box.name && !TEXT_ROLES.has(element.role) && element.name.toLowerCase().includes(first) && element.name.length > typed.length);
      if (!suggestion) continue;
      await step((signal) => page.click({ role: suggestion.role, name: suggestion.name, nth: 0 }, signal));
      if (await settled()) return true;
      break;
    }
  }
  for (let presses = 0; presses < 2; presses += 1) {
    read = await readPage(page, step);
    const locate = locateIn(read);
    if (!locate) return !boxIn(read);
    await press(page, read.elements, locate, step);
    if (await settled()) return true;
  }
  return false;
}

export type PickedProduct = { title: string; rupees: number; index: number };

/** Picks the cheapest priced product whose name contains every query word. */
export function pickProduct(elements: readonly PageElement[], query: string): PickedProduct | null {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 1);
  let best: PickedProduct | null = null;
  elements.forEach((element, index) => {
    if (element.role !== "link" && element.role !== "text" && element.role !== "heading" && element.role !== "button") return;
    const match = element.name.match(RUPEES);
    if (!match?.[1]) return;
    const title = element.name.replace(/₹\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?/g, " ").replace(/\s+/g, " ").trim();
    const lower = title.toLowerCase();
    if (title.length < 2 || !words.every((word) => lower.includes(word))) return;
    const rupees = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(rupees) || rupees <= 0) return;
    if (!best || rupees < best.rupees) best = { title, rupees, index };
  });
  return best;
}

/** Clicks the add button that follows the picked product, then raises the quantity. */
export async function addToCart(page: IsolatedPage, skill: WebsiteSkill, product: PickedProduct, quantity: number, step: Step): Promise<boolean> {
  const read = await readPage(page, step);
  const add = controlAfter(read.elements, product.index, skill.cart.add);
  if (!add) return false;
  await step((signal) => page.click(add.target, signal));
  for (let count = 1; count < quantity; count += 1) {
    const after = await readPage(page, step);
    const anchor = after.elements.findIndex((element) => element.name.replace(RUPEES, "").replace(/\s+/g, " ").trim().toLowerCase().startsWith(product.title.toLowerCase()));
    const plus = controlAfter(after.elements, Math.max(0, anchor), skill.cart.increase);
    if (!plus) return false;
    await step((signal) => page.click(plus.target, signal));
  }
  return true;
}

export async function openCart(page: IsolatedPage, skill: WebsiteSkill, step: Step): Promise<StageCheck> {
  if (skill.cart.url) {
    await step((signal) => page.goto(skill.cart.url ?? "", signal));
  } else {
    const read = await readPage(page, step);
    const cart = read.elements.find((element) => PRESS_ROLES.has(element.role) && skill.cart.open.test(element.name.trim()))
      ?? read.elements.find((element) => element.role === "text" && skill.cart.open.test(element.name.trim()));
    if (cart) await press(page, read.elements, cart, step);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const staged = await checkStage(page, skill, "cart", step);
      if (staged.check.ok) return staged.check;
      const retry = staged.read.elements.find((element) => PRESS_ROLES.has(element.role) && /^(?:try again|retry)$/i.test(element.name.trim()));
      if (retry) await press(page, staged.read.elements, retry, step);
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  return (await checkStage(page, skill, "cart", step)).check;
}

/** Reads lines, fees, and the payable total from a cart or checkout page. */
const AMOUNT = /₹\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g;
const BILL_START = /bill details|items? total|sub ?total/i;
const CART_START = /\b(?:my cart|your cart|shipment of \d+ items?)\b/gi;
const TOTAL_LABEL = /(?:grand total|to pay|total amount|order total|amount payable|total payable)\s*$/i;

/**
 * Reads the cart drawer or page: item rows between the cart heading and the
 * bill, then the bill's label and amount pairs up to the payable total.
 */
export function readCart(skill: WebsiteSkill, read: PageRead): CartReview | null {
  const flat = read.text.replace(/\s+/g, " ");
  const billAt = flat.search(BILL_START);
  if (billAt < 0) return null;
  let start = 0;
  for (const heading of flat.slice(0, billAt).matchAll(CART_START)) start = (heading.index ?? 0) + heading[0].length;
  const lines: CartLine[] = [];
  for (const pair of amountPairs(flat.slice(start, billAt))) {
    const quantity = Number(pair.label.match(/×\s*(\d{1,2})/)?.[1] ?? pair.after.match(/^\s*[-−]?\s*(\d{1,2})\b/)?.[1] ?? "1");
    const title = pair.label.replace(/×\s*\d{1,2}/g, " ").replace(/^(?:\d{1,2}\s+)?[-−+]?\s*/, "").replace(/\s+/g, " ").trim();
    if (title.length < 3 || /^(?:mrp|save|off)\b/i.test(title)) continue;
    lines.push({ title, quantity: Math.max(1, quantity), paise: pair.paise });
  }
  const fees: CartFee[] = [];
  let total: number | null = null;
  for (const pair of amountPairs(flat.slice(billAt, billAt + 800))) {
    if (TOTAL_LABEL.test(pair.label)) {
      total = pair.paise;
      break;
    }
    if (/items? total|sub ?total|savings|discount|you save/i.test(pair.label)) continue;
    if (/delivery|handling|platform|convenience|small cart|packaging|gst|tax|fee|charge|tip/i.test(pair.label)) {
      fees.push({ label: pair.label.replace(/^.*?((?:\w+ )?(?:delivery|handling|platform|convenience|small cart|packaging|gst|tax|tip)\b)/i, "$1").trim(), paise: pair.paise });
    }
  }
  if (total == null || lines.length === 0) return null;
  return { skill: skill.id, merchant: skill.name, pageUrl: read.url, lines, fees, totalPaise: total };
}

function amountPairs(text: string): { label: string; paise: number; after: string }[] {
  const pairs: { label: string; paise: number; after: string }[] = [];
  let from = 0;
  for (const match of text.matchAll(AMOUNT)) {
    const at = match.index ?? 0;
    const label = text.slice(from, at).replace(/[ⓘ!]/g, " ").replace(/\s+/g, " ").trim();
    from = at + match[0].length;
    const paise = Math.round(Number((match[1] ?? "").replace(/,/g, "")) * 100);
    if (Number.isFinite(paise)) pairs.push({ label, paise, after: text.slice(from, from + 12) });
  }
  return pairs;
}

/** The next permitted checkout or payment-initiation control. Never presses a forbidden one. */
export function checkoutControl(skill: WebsiteSkill, elements: readonly PageElement[], pressed: ReadonlySet<string>): { element: PageElement; pays: boolean } | null {
  const usable = elements.filter((element) => PRESS_ROLES.has(element.role) && !skill.checkout.forbidden.test(element.name) && !pressed.has(key(element)));
  const pay = usable.find((element) => skill.checkout.payInitiation.test(element.name.trim()));
  if (pay) return { element: pay, pays: true };
  const proceed = usable.find((element) => skill.checkout.proceed.test(element.name.trim()));
  return proceed ? { element: proceed, pays: false } : null;
}

export function confirmationId(skill: WebsiteSkill, read: PageRead): string | null {
  return read.text.match(skill.success.orderId)?.[1] ?? null;
}

export async function press(page: IsolatedPage, elements: readonly PageElement[], element: PageElement, step: Step): Promise<void> {
  const nth = elements.filter((item) => item.role === element.role && item.name === element.name).length - 1;
  await step((signal) => page.click({ role: element.role, name: element.name, nth: Math.max(0, nth) }, signal));
}

export function key(element: PageElement): string {
  return `${element.role}\0${element.name}`;
}

async function sendCode(page: IsolatedPage, elements: readonly PageElement[], skill: WebsiteSkill, pressed: Set<string>, step: Step): Promise<void> {
  const send = elements.find((element) => PRESS_ROLES.has(element.role) && skill.login.sendCode.test(element.name.trim()) && !pressed.has(key(element)));
  if (!send) return;
  pressed.add(key(send));
  await press(page, elements, send, step);
}

function controlAfter(elements: readonly PageElement[], index: number, pattern: RegExp): { target: { role: string; name: string; nth: number } } | null {
  for (let at = index; at < elements.length; at += 1) {
    const element = elements[at];
    if (!element || !PRESS_ROLES.has(element.role) || !pattern.test(element.name.trim())) continue;
    const nth = elements.slice(0, at).filter((item) => item.role === element.role && item.name === element.name).length;
    return { target: { role: element.role, name: element.name, nth } };
  }
  return null;
}

function localPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
}

export function plainText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/header|\/footer|\/dt|\/dd)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#8377;|&rupee;/gi, "₹")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*/g, "\n")
    .trim();
}
