import type { PageElement } from "./driver.ts";

export type SkillId = "blinkit" | "zepto" | "instamart" | "luma" | "district" | "bookmyshow";

export type SkillStage = "home" | "login" | "code" | "signed_in" | "search" | "cart" | "checkout" | "payment" | "confirmed";

export type LoginMethod = "phone" | "email";

export type WebsiteSkill = {
  id: SkillId;
  name: string;
  kind: "shop" | "event";
  domains: readonly string[];
  home: string;
  login: {
    /** When the site asks for a sign-in. */
    requiredFor: "search" | "checkout" | "register" | "booking";
    methods: readonly LoginMethod[];
    openLogin: RegExp;
    phoneField: RegExp;
    emailField: RegExp;
    sendCode: RegExp;
    codeField: RegExp;
    verify: RegExp;
    signedIn: RegExp;
  };
  search: {
    url: (query: string) => string;
    box: RegExp;
  };
  cart: {
    add: RegExp;
    increase: RegExp;
    decrease: RegExp;
    open: RegExp;
    url: string | null;
    summary: RegExp;
  };
  checkout: {
    proceed: RegExp;
    payInitiation: RegExp;
    /** Buttons Scout must never press for the user. */
    forbidden: RegExp;
  };
  success: {
    cart: RegExp;
    booking: RegExp;
    orderId: RegExp;
    ordersUrl: string | null;
  };
  failure: {
    /** The control that fills the delivery location from the browser's geolocation. */
    locate: RegExp;
    /** The text box where a delivery area can be typed instead. */
    locationBox: RegExp;
    captcha: RegExp;
    location: RegExp;
    blocked: RegExp;
    soldOut: RegExp;
  };
};

const COMMON_LOGIN = {
  openLogin: /^(?:log\s?in|sign\s?in|login|sign up|login\/sign up|continue with (?:phone|mobile|email))$/i,
  phoneField: /phone|mobile|number/i,
  emailField: /e-?mail/i,
  sendCode: /^(?:continue|next|send otp|get otp|send code|login with otp|proceed)$/i,
  codeField: /otp|code|verification|pin/i,
  verify: /^(?:verify|submit|continue|confirm|login|proceed)$/i,
  signedIn: /log\s?out|sign\s?out|my account|my orders|account settings|profile/i,
};

const COMMON_FORBIDDEN = /autopay|auto[- ]?pay|mandate|subscribe|save card|enter (?:upi )?pin|cvv/i;

const COMMON_FAILURE = {
  locate: /^(?:detect my location|use (?:my )?current location|locate me|use current location)$/i,
  locationBox: /delivery location|search (?:for )?(?:area|location)|enter (?:your )?(?:area|location|pincode)|search a new address/i,
  captcha: /captcha|are you a robot|verify you are human|press and hold/i,
  location: /select (?:your )?location|choose (?:your )?location|enter (?:your )?(?:delivery )?location|detect my location/i,
  blocked: /access denied|request blocked|403 forbidden|unusual traffic/i,
  soldOut: /sold out|out of stock|currently unavailable|notify me/i,
};

export const SKILLS: Readonly<Record<SkillId, WebsiteSkill>> = {
  blinkit: {
    id: "blinkit",
    name: "Blinkit",
    kind: "shop",
    domains: ["blinkit.com"],
    home: "https://blinkit.com/",
    login: { ...COMMON_LOGIN, requiredFor: "checkout", methods: ["phone"] },
    search: { url: (q) => `https://blinkit.com/s/?q=${encodeURIComponent(q)}`, box: /search/i },
    cart: { add: /^add$/i, increase: /^(?:\+|increase|add one more)$/i, decrease: /^(?:-|−|decrease|remove one)$/i, open: /^(?:my cart|cart|view cart)$|\b\d+ items? ₹/i, url: null, summary: /bill details|item total|grand total/i },
    checkout: { proceed: /^(?:proceed(?: to pay)?|checkout)$/i, payInitiation: /^(?:pay(?: now)?|proceed to pay|pay ₹)/i, forbidden: COMMON_FORBIDDEN },
    success: { cart: /item total|bill details/i, booking: /order (?:placed|confirmed)|order id/i, orderId: /order (?:id|#)\s*[:#]?\s*([A-Z0-9-]{6,})/i, ordersUrl: "https://blinkit.com/account/orders" },
    failure: COMMON_FAILURE,
  },
  zepto: {
    id: "zepto",
    name: "Zepto",
    kind: "shop",
    domains: ["zepto.com", "zeptonow.com"],
    home: "https://www.zepto.com/",
    login: { ...COMMON_LOGIN, requiredFor: "checkout", methods: ["phone"] },
    search: { url: (q) => `https://www.zepto.com/search?query=${encodeURIComponent(q)}`, box: /search/i },
    cart: { add: /^add$/i, increase: /^(?:\+|increase quantity)$/i, decrease: /^(?:-|−|decrease quantity)$/i, open: /^(?:cart|view cart)/i, url: null, summary: /item total|to pay|bill summary/i },
    checkout: { proceed: /^(?:proceed|checkout|click to pay)$/i, payInitiation: /^(?:pay(?: now)?|place order|click to pay)/i, forbidden: COMMON_FORBIDDEN },
    success: { cart: /item total|to pay/i, booking: /order (?:placed|confirmed)/i, orderId: /order (?:id|#)\s*[:#]?\s*([A-Z0-9-]{6,})/i, ordersUrl: "https://www.zepto.com/account/orders" },
    failure: COMMON_FAILURE,
  },
  instamart: {
    id: "instamart",
    name: "Instamart",
    kind: "shop",
    domains: ["swiggy.com"],
    home: "https://www.swiggy.com/instamart",
    login: {
      ...COMMON_LOGIN,
      openLogin: /^(?:log\s?in|sign\s?in|login|sign up|log in with phone number|double tap to go to user account)$/i,
      requiredFor: "search",
      methods: ["phone"],
    },
    search: { url: (q) => `https://www.swiggy.com/instamart/search?query=${encodeURIComponent(q)}`, box: /search/i },
    cart: { add: /^add$/i, increase: /^(?:\+|increase)$/i, decrease: /^(?:-|−|decrease)$/i, open: /^(?:view cart|cart|go to cart)/i, url: "https://www.swiggy.com/instamart/cart", summary: /item total|to pay|bill details/i },
    checkout: { proceed: /^(?:proceed to pay|checkout|make payment)$/i, payInitiation: /^(?:pay|proceed to pay|pay ₹)/i, forbidden: COMMON_FORBIDDEN },
    success: { cart: /item total|to pay/i, booking: /order (?:placed|confirmed)/i, orderId: /order (?:id|#)\s*[:#]?\s*([A-Z0-9-]{6,})/i, ordersUrl: "https://www.swiggy.com/my-account/orders" },
    failure: COMMON_FAILURE,
  },
  luma: {
    id: "luma",
    name: "Luma",
    kind: "event",
    domains: ["luma.com", "lu.ma"],
    home: "https://luma.com/",
    login: { ...COMMON_LOGIN, requiredFor: "register", methods: ["email"] },
    search: { url: (q) => `https://luma.com/discover?q=${encodeURIComponent(q)}`, box: /search/i },
    cart: { add: /^(?:register|rsvp|request to join|get tickets?)$/i, increase: /^(?:\+|increase)$/i, decrease: /^(?:-|−|decrease)$/i, open: /^(?:register|request to join)$/i, url: null, summary: /ticket|total/i },
    checkout: { proceed: /^(?:register|request to join|rsvp|continue)$/i, payInitiation: /^(?:pay|continue to payment|get tickets?)/i, forbidden: COMMON_FORBIDDEN },
    success: { cart: /name \*|email \*/i, booking: /you(?:'|’)re (?:going|registered|on the waitlist)|registration (?:complete|pending)|request (?:sent|submitted)|pending approval/i, orderId: /ticket (?:id|#)\s*[:#]?\s*([A-Z0-9-]{6,})/i, ordersUrl: "https://luma.com/home" },
    failure: COMMON_FAILURE,
  },
  district: {
    id: "district",
    name: "District",
    kind: "event",
    domains: ["district.in"],
    home: "https://www.district.in/",
    login: { ...COMMON_LOGIN, requiredFor: "booking", methods: ["phone"] },
    search: { url: (q) => `https://www.district.in/search?q=${encodeURIComponent(q)}`, box: /search/i },
    cart: { add: /^(?:book(?: now)?|buy tickets?|add)$/i, increase: /^(?:\+|increase)$/i, decrease: /^(?:-|−|decrease)$/i, open: /^(?:proceed|continue)$/i, url: null, summary: /order summary|total|convenience fee/i },
    checkout: { proceed: /^(?:proceed|continue|checkout)$/i, payInitiation: /^(?:pay(?: now)?|proceed to pay|pay ₹)/i, forbidden: COMMON_FORBIDDEN },
    success: { cart: /order summary|ticket total/i, booking: /booking (?:confirmed|successful)|order confirmed|enjoy the show/i, orderId: /booking (?:id|#)\s*[:#]?\s*([A-Z0-9-]{6,})/i, ordersUrl: "https://www.district.in/my-bookings" },
    failure: COMMON_FAILURE,
  },
  bookmyshow: {
    id: "bookmyshow",
    name: "BookMyShow",
    kind: "event",
    domains: ["bookmyshow.com"],
    home: "https://in.bookmyshow.com/",
    login: { ...COMMON_LOGIN, requiredFor: "booking", methods: ["phone", "email"] },
    search: { url: (q) => `https://in.bookmyshow.com/explore/home?q=${encodeURIComponent(q)}`, box: /search/i },
    cart: { add: /^(?:book(?: tickets?)?|book now)$/i, increase: /^(?:\+|increase)$/i, decrease: /^(?:-|−|decrease)$/i, open: /^(?:proceed|continue)$/i, url: null, summary: /order summary|sub total|convenience fee/i },
    checkout: { proceed: /^(?:proceed|continue|book)$/i, payInitiation: /^(?:pay(?: now)?|proceed to pay|make payment)/i, forbidden: COMMON_FORBIDDEN },
    success: { cart: /order summary|sub total/i, booking: /booking (?:confirmed|successful)|your booking is confirmed/i, orderId: /booking (?:id|#)\s*[:#]?\s*([A-Z0-9-]{6,})/i, ordersUrl: "https://in.bookmyshow.com/my-profile/booking-history" },
    failure: COMMON_FAILURE,
  },
};

export function skillById(value: string): WebsiteSkill | null {
  return value in SKILLS ? SKILLS[value as SkillId] : null;
}

export function skillForHost(hostname: string): WebsiteSkill | null {
  const host = hostname.toLowerCase();
  return Object.values(SKILLS).find((skill) => skill.domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) ?? null;
}

export type PageRead = { url: string; elements: readonly PageElement[]; text: string };

export type StageCheck = { ok: true } | { ok: false; reason: "captcha" | "blocked" | "location" | "sold_out" | "off_site" | "missing"; detail: string };

/**
 * Checks the live page before a stage runs. A skill only acts on a page that
 * is on its own domain, shows no CAPTCHA or block, and shows what the stage needs.
 */
export function validateStage(skill: WebsiteSkill, stage: SkillStage, page: PageRead): StageCheck {
  let host = "";
  try {
    host = new URL(page.url).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: "off_site", detail: "The page address could not be read." };
  }
  if (!skill.domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return { ok: false, reason: "off_site", detail: `The page left ${skill.name}.` };
  }
  if (skill.failure.captcha.test(page.text)) return { ok: false, reason: "captcha", detail: `${skill.name} is showing a CAPTCHA. Solve it yourself; Scout does not.` };
  if (skill.failure.blocked.test(page.text)) return { ok: false, reason: "blocked", detail: `${skill.name} blocked the automated browser.` };
  const names = page.elements.map((element) => element.name);
  const has = (pattern: RegExp, roles?: readonly string[]) => page.elements.some((element) => (!roles || roles.includes(element.role)) && pattern.test(element.name));
  switch (stage) {
    case "home":
    case "search":
      if (skill.kind === "shop" && has(skill.failure.locate, ["button", "link"])) return { ok: false, reason: "location", detail: `${skill.name} needs a delivery location first.` };
      return { ok: true };
    case "login":
      return has(skill.login.openLogin, ["button", "link"]) || has(skill.login.phoneField, TEXT_ROLES) || has(skill.login.emailField, TEXT_ROLES)
        ? { ok: true }
        : { ok: false, reason: "missing", detail: `${skill.name} shows no sign-in control.` };
    case "code":
      return has(skill.login.codeField, TEXT_ROLES) ? { ok: true } : { ok: false, reason: "missing", detail: `${skill.name} shows no code field.` };
    case "signed_in":
      return has(skill.login.signedIn) || skill.login.signedIn.test(page.text) ? { ok: true } : { ok: false, reason: "missing", detail: `${skill.name} does not show a signed-in page.` };
    case "cart":
      if (skill.failure.soldOut.test(names.join(" ")) && !skill.success.cart.test(page.text)) return { ok: false, reason: "sold_out", detail: "That item is out of stock." };
      return skill.success.cart.test(page.text) || skill.cart.summary.test(page.text) ? { ok: true } : { ok: false, reason: "missing", detail: `${skill.name} does not show a cart total.` };
    case "checkout":
      return has(skill.checkout.proceed, ["button", "link"]) || has(skill.checkout.payInitiation, ["button", "link"])
        ? { ok: true }
        : { ok: false, reason: "missing", detail: `${skill.name} shows no checkout button.` };
    case "payment":
      return { ok: true };
    case "confirmed":
      return skill.success.booking.test(page.text) ? { ok: true } : { ok: false, reason: "missing", detail: `${skill.name} shows no confirmation yet.` };
    default: {
      const neverStage: never = stage;
      return neverStage;
    }
  }
}

const TEXT_ROLES = ["textbox", "searchbox", "combobox"] as const;
