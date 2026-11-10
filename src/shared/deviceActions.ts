import type { EventApp, EventRef, ProductRef, ShopApp } from "./productRef.ts";

export const DEVICE_APPS = [
  "whatsapp",
  "gmail",
  "maps",
  "youtube",
  "spotify",
  "calendar",
  "clock",
  "camera",
  "uber",
  "ola",
  "zomato",
  "swiggy",
  "blinkit",
  "zepto",
  "phonepe",
  "gpay",
  "paytm",
] as const;

export type DeviceApp = (typeof DEVICE_APPS)[number];
export type VolumeStream = "media" | "ring" | "alarm";

export const SHOP_APPS: readonly ShopApp[] = ["blinkit", "zepto", "instamart"];
export const EVENT_APPS: readonly EventApp[] = ["bookmyshow", "district", "luma"];
export type AutomationApp = ShopApp | EventApp;

export type CartItem = { ref: ProductRef; quantity: number; maxPrice: number };
export type SeatChoice = "best_available" | "user_picks";

export type CartLine = { name: string; size: string | null; quantity: number; unitPrice: number | null; lineTotal: number | null };
export type CartBill = { itemsTotal: number | null; handling: number | null; delivery: number | null; otherFees: number | null; grandTotal: number | null };
export type CartStopReason =
  | "no_match"
  | "price_above_limit"
  | "out_of_stock"
  | "size_mismatch"
  | "not_signed_in"
  | "no_address"
  | "app_missing"
  | "service_off"
  | "screen_changed"
  | "timeout"
  | "captcha"
  | "location_off"
  | "user_stopped"
  | "payment_pin";
export type AppCartResult = {
  store: ShopApp;
  added: CartLine[];
  cart: CartBill | null;
  stoppedAt: string | null;
  reason: CartStopReason | null;
  seen: { name: string; size: string | null; price: number | null; inStock: boolean | null } | null;
  /** How long the phone run took after Allow. Older app builds do not send it. */
  elapsedMs: number | null;
};
export type AppEventResult = { app: EventApp; tickets: number | null; showtime: number | null; seats: string[] | null; total: number | null; stoppedAt: string | null; reason: string | null };

export type PhoneAutomation = { serviceOn: boolean; apps: Partial<Record<AutomationApp, { installed: boolean; version: string | null }>> };

export type DeviceCommand =
  | { name: "set_alarm"; args: { hour: number; minute: number; label: string } }
  | { name: "set_timer"; args: { seconds: number; label: string } }
  | { name: "create_reminder"; args: { title: string; at: number } }
  | { name: "list_reminders"; args: Record<string, never> }
  | { name: "cancel_reminder"; args: { reminderId: string } }
  | { name: "open_app"; args: { app: DeviceApp } }
  | { name: "open_maps"; args: { query: string } }
  | { name: "share_text"; args: { text: string } }
  | { name: "send_whatsapp"; args: { phone: string | null; name: string | null; text: string } }
  | { name: "toggle_flashlight"; args: { on: boolean } }
  | { name: "set_volume"; args: { stream: VolumeStream; percent: number } }
  | { name: "get_capabilities"; args: Record<string, never> }
  | { name: "app_cart_add"; args: { items: CartItem[]; allowSimilar: boolean; placeOrder: boolean } }
  | {
      name: "app_event_book";
      args: { ref: EventRef; tickets: number; maxPricePerTicket: number | null; seat: SeatChoice; showtime: number | null };
    };

export type AppActionName = "app_cart_add" | "app_event_book";
export type AppCommand = Extract<DeviceCommand, { name: AppActionName }>;

export type DeviceActionName = DeviceCommand["name"];

export type DeviceAction = DeviceCommand & {
  id: string;
  summary: string;
  confirm: boolean;
  expiresAt: number;
};

export type DeviceStatus = "completed" | "handoff_started" | "needs_permission" | "needs_approval" | "failed";

export type DeviceResult = { id: string; status: DeviceStatus; message: string; data?: unknown };

export const DEVICE_ACTION_NAMES: readonly DeviceActionName[] = [
  "set_alarm",
  "set_timer",
  "create_reminder",
  "list_reminders",
  "cancel_reminder",
  "open_app",
  "open_maps",
  "share_text",
  "send_whatsapp",
  "toggle_flashlight",
  "set_volume",
  "get_capabilities",
  "app_cart_add",
  "app_event_book",
];

export const DEVICE_ACTION_TTL_MS = 2 * 60_000;
const TEXT_LIMIT = 500;
const LABEL_LIMIT = 80;
const NAME_LIMIT = 120;
const SIZE_LIMIT = 40;
const LINK_LIMIT = 500;
const SUMMARY_LIMIT = 200;
const MAX_RUPEES = 100_000;
const MAX_BILL = 1_000_000;
const CART_ITEMS = 10;
const RESULT_LINES = 20;
const YEAR_MS = 366 * 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const MIN_SHOWTIME = Date.UTC(2020, 0, 1);
const MAX_SHOWTIME = Date.UTC(2100, 0, 1);
const ACTION_ID = /^[a-f0-9]{24}$/;
const REF_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const UNSAFE_SCHEME = /(javascript|intent|data|file|content|vbscript):/i;

/** Exact hosts the phone may open. A lookalike, a port, or the wrong www is rejected. */
const APP_HOSTS: Readonly<Record<AutomationApp, readonly string[]>> = {
  blinkit: ["blinkit.com"],
  zepto: ["www.zepto.com"],
  instamart: ["swiggy.com", "www.swiggy.com", "instamart.in", "www.instamart.in"],
  bookmyshow: ["in.bookmyshow.com"],
  district: ["www.district.in"],
  luma: ["luma.com", "www.luma.com", "lu.ma", "www.lu.ma"],
};

const APP_NAMES: Readonly<Record<AutomationApp, string>> = {
  blinkit: "Blinkit",
  zepto: "Zepto",
  instamart: "Instamart",
  bookmyshow: "BookMyShow",
  district: "District",
  luma: "Luma",
};

const APP_HOMES: Readonly<Record<AutomationApp, string>> = {
  blinkit: "https://blinkit.com/",
  zepto: "https://www.zepto.com/",
  instamart: "https://www.swiggy.com/instamart",
  bookmyshow: "https://in.bookmyshow.com/",
  district: "https://www.district.in/",
  luma: "https://luma.com/",
};

const CART_REASONS: readonly CartStopReason[] = [
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
  "location_off",
  "user_stopped",
  "payment_pin",
];

export function isDeviceActionName(value: unknown): value is DeviceActionName {
  return typeof value === "string" && DEVICE_ACTION_NAMES.some((name) => name === value);
}

export function isDeviceStatus(value: unknown): value is DeviceStatus {
  return value === "completed" || value === "handoff_started" || value === "needs_permission" || value === "needs_approval" || value === "failed";
}

export function isActionId(value: unknown): value is string {
  return typeof value === "string" && ACTION_ID.test(value);
}

export function readDeviceCommand(name: unknown, raw: unknown, now: number): { ok: true; command: DeviceCommand } | { ok: false; error: string } {
  if (!isDeviceActionName(name)) return { ok: false, error: "That is not a phone action Scout can run." };
  const args = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  switch (name) {
    case "set_alarm": {
      const hour = integer(args.hour, 0, 23);
      const minute = integer(args.minute, 0, 59);
      if (hour == null || minute == null) return { ok: false, error: "An alarm needs an hour from 0 to 23 and a minute from 0 to 59." };
      return { ok: true, command: { name, args: { hour, minute, label: label(args.label) } } };
    }
    case "set_timer": {
      const seconds = integer(args.seconds, 1, 24 * 60 * 60);
      if (seconds == null) return { ok: false, error: "A timer runs from 1 second to 24 hours." };
      return { ok: true, command: { name, args: { seconds, label: label(args.label) } } };
    }
    case "create_reminder": {
      const title = text(args.title, LABEL_LIMIT);
      const at = moment(args.at);
      if (!title) return { ok: false, error: "A reminder needs a title." };
      if (at == null || at <= now || at > now + YEAR_MS) return { ok: false, error: "A reminder needs a future time within a year, as an ISO time with offset." };
      return { ok: true, command: { name, args: { title, at } } };
    }
    case "cancel_reminder": {
      const reminderId = typeof args.reminderId === "string" && /^[A-Za-z0-9-]{1,64}$/.test(args.reminderId) ? args.reminderId : null;
      if (!reminderId) return { ok: false, error: "Say which reminder to cancel." };
      return { ok: true, command: { name, args: { reminderId } } };
    }
    case "open_app": {
      const app = DEVICE_APPS.find((item) => item === args.app);
      if (!app) return { ok: false, error: `Scout can open ${DEVICE_APPS.join(", ")}.` };
      return { ok: true, command: { name, args: { app } } };
    }
    case "open_maps": {
      const query = text(args.query, 200);
      if (!query) return { ok: false, error: "Say where to look on the map." };
      return { ok: true, command: { name, args: { query } } };
    }
    case "share_text": {
      const shared = text(args.text, TEXT_LIMIT);
      if (!shared || /(file|content|intent|javascript):/i.test(shared)) return { ok: false, error: "Share plain text under 500 characters." };
      return { ok: true, command: { name, args: { text: shared } } };
    }
    case "send_whatsapp": {
      const phone = args.phone == null || args.phone === "" ? null : whatsAppPhone(args.phone);
      const chatName = whatsAppName(args.name);
      if (args.phone != null && args.phone !== "" && !phone) return { ok: false, error: "A WhatsApp number needs a country code and 8 to 15 digits." };
      if (args.name != null && args.name !== "" && !chatName) return { ok: false, error: "A WhatsApp name needs 2 to 40 letters." };
      if (!phone && !chatName) return { ok: false, error: "A WhatsApp message needs a number or the chat's exact name." };
      const message = text(args.text, TEXT_LIMIT);
      if (!message || /(file|content|intent|javascript):/i.test(message)) return { ok: false, error: "The WhatsApp message must be plain text under 500 characters." };
      return { ok: true, command: { name, args: { phone, name: chatName, text: message } } };
    }
    case "toggle_flashlight": {
      if (typeof args.on !== "boolean") return { ok: false, error: "Say whether the flashlight goes on or off." };
      return { ok: true, command: { name, args: { on: args.on } } };
    }
    case "set_volume": {
      const stream = args.stream === "media" || args.stream === "ring" || args.stream === "alarm" ? args.stream : null;
      const percent = integer(args.percent, 0, 100);
      if (!stream || percent == null) return { ok: false, error: "Volume needs media, ring, or alarm and a percent from 0 to 100." };
      return { ok: true, command: { name, args: { stream, percent } } };
    }
    case "list_reminders":
    case "get_capabilities":
      return { ok: true, command: { name, args: {} } };
    case "app_cart_add": {
      const raw = args.items;
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > CART_ITEMS) return { ok: false, error: `A cart add needs 1 to ${CART_ITEMS} items.` };
      if (typeof args.allowSimilar !== "boolean") return { ok: false, error: "Say whether a similar item is fine (allowSimilar true or false)." };
      const items: CartItem[] = [];
      for (const value of raw) {
        const item = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
        const ref = productRef(item.ref, now);
        if (!ref) return { ok: false, error: "Each item needs the product reference Scout found: store, name, price, and a store link if any." };
        const quantity = integer(item.quantity, 1, 20);
        if (quantity == null) return { ok: false, error: "Each item's quantity runs from 1 to 20." };
        const maxPrice = rupees(item.maxPrice);
        if (maxPrice == null || maxPrice <= 0) return { ok: false, error: "Each item needs a price limit per unit in rupees." };
        items.push({ ref, quantity, maxPrice });
      }
      const store = items[0]?.ref.store;
      if (!items.every((item) => item.ref.store === store)) return { ok: false, error: "One cart add covers one store. Send a separate one per store." };
      return { ok: true, command: { name, args: { items, allowSimilar: args.allowSimilar, placeOrder: args.placeOrder === true } } };
    }
    case "app_event_book": {
      const ref = eventRef(args.ref);
      if (!ref) return { ok: false, error: "A booking needs the event reference Scout found: app, title, and its link on that app." };
      const tickets = integer(args.tickets, 1, 10);
      if (tickets == null) return { ok: false, error: "Book 1 to 10 tickets." };
      const maxPricePerTicket = args.maxPricePerTicket == null ? null : rupees(args.maxPricePerTicket);
      if (args.maxPricePerTicket != null && (maxPricePerTicket == null || maxPricePerTicket <= 0)) {
        return { ok: false, error: "A ticket price limit must be above zero, or null for none." };
      }
      const seat = args.seat === "best_available" || args.seat === "user_picks" ? args.seat : null;
      if (!seat) return { ok: false, error: "Seats are best_available or user_picks." };
      const showtime = args.showtime == null ? null : moment(args.showtime);
      if (args.showtime != null && (showtime == null || showtime < now - HOUR_MS || showtime > now + YEAR_MS)) {
        return { ok: false, error: "A showtime must be an upcoming time within a year, as an ISO time with offset." };
      }
      return { ok: true, command: { name, args: { ref, tickets, maxPricePerTicket, seat, showtime } } };
    }
    default: {
      const neverName: never = name;
      return neverName;
    }
  }
}

export function isAppAction(command: DeviceCommand): command is AppCommand {
  return command.name === "app_cart_add" || command.name === "app_event_book";
}

export function isAppActionName(value: unknown): value is AppActionName {
  return value === "app_cart_add" || value === "app_event_book";
}

/** The app an app action drives. */
export function commandApp(command: AppCommand): AutomationApp {
  switch (command.name) {
    case "app_cart_add":
      return command.args.items[0]?.ref.store ?? "blinkit";
    case "app_event_book":
      return command.args.ref.app;
    default: {
      const neverCommand: never = command;
      return neverCommand;
    }
  }
}

/** The page the user opens to finish by hand: the product or event link, else the app's home. */
export function handoffLink(command: AppCommand): string {
  switch (command.name) {
    case "app_cart_add":
      return command.args.items.find((item) => item.ref.link)?.ref.link ?? APP_HOMES[commandApp(command)];
    case "app_event_book":
      return command.args.ref.link;
    default: {
      const neverCommand: never = command;
      return neverCommand;
    }
  }
}

export function appName(app: AutomationApp): string {
  return APP_NAMES[app];
}

export function appHome(app: AutomationApp): string {
  return APP_HOMES[app];
}

export function isShopApp(value: unknown): value is ShopApp {
  return SHOP_APPS.some((app) => app === value);
}

export function isEventApp(value: unknown): value is EventApp {
  return EVENT_APPS.some((app) => app === value);
}

/** True only for an https link on that app's own host, with no user, password, or port. */
export function isAppLink(app: AutomationApp, value: unknown): value is string {
  if (typeof value !== "string" || value.length > LINK_LIMIT || UNSAFE_SCHEME.test(value) || /[\s\\]/.test(value)) return false;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  if (UNSAFE_SCHEME.test(decoded)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  return APP_HOSTS[app].includes(url.hostname.toLowerCase());
}

export function deviceSummary(command: DeviceCommand, timeZone = "Asia/Kolkata"): string {
  switch (command.name) {
    case "set_alarm":
      return `Set an alarm for ${String(command.args.hour).padStart(2, "0")}:${String(command.args.minute).padStart(2, "0")}${command.args.label ? ` — ${command.args.label}` : ""}`;
    case "set_timer":
      return `Start a ${duration(command.args.seconds)} timer${command.args.label ? ` — ${command.args.label}` : ""}`;
    case "create_reminder":
      return `Remind you "${command.args.title}" at ${new Date(command.args.at).toLocaleString("en-IN", { timeZone, dateStyle: "medium", timeStyle: "short" })}`;
    case "list_reminders":
      return "List your Scout reminders";
    case "cancel_reminder":
      return "Cancel a Scout reminder";
    case "open_app":
      return `Open ${command.args.app}`;
    case "open_maps":
      return `Open maps for ${command.args.query}`;
    case "share_text":
      return "Share text";
    case "send_whatsapp":
      return command.args.phone
        ? `Send a WhatsApp message to a number ending ${command.args.phone.slice(-4)}`
        : `Send a WhatsApp message to ${command.args.name}`;
    case "toggle_flashlight":
      return `Turn the flashlight ${command.args.on ? "on" : "off"}`;
    case "set_volume":
      return `Set ${command.args.stream} volume to ${command.args.percent}%`;
    case "get_capabilities":
      return "Check what this phone allows";
    case "app_cart_add":
      return clip(`${cartSummary(command.args.items)}${command.args.placeOrder ? ". Then place the order" : ""}`);
    case "app_event_book":
      return clip(bookSummary(command.args, timeZone));
    default: {
      const neverCommand: never = command;
      return neverCommand;
    }
  }
}

export function needsConfirmation(command: DeviceCommand): boolean {
  switch (command.name) {
    case "open_app":
    case "share_text":
    case "send_whatsapp":
    case "app_cart_add":
    case "app_event_book":
      return true;
    case "set_volume":
      return command.args.stream === "ring" && command.args.percent === 0;
    case "set_alarm":
    case "set_timer":
    case "create_reminder":
    case "list_reminders":
    case "cancel_reminder":
    case "open_maps":
    case "toggle_flashlight":
    case "get_capabilities":
      return false;
    default: {
      const neverCommand: never = command;
      return neverCommand;
    }
  }
}

export function readDeviceResult(raw: unknown): DeviceResult | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { op?: unknown; id?: unknown; status?: unknown; message?: unknown; data?: unknown };
  if (row.op !== undefined && row.op !== "action") return null;
  if (!isActionId(row.id) || !isDeviceStatus(row.status)) return null;
  const message = typeof row.message === "string" ? row.message.slice(0, 300) : "";
  return { id: row.id, status: row.status, message, ...(row.data === undefined ? {} : { data: row.data }) };
}

/** Reads what the phone reports after app_cart_add. The phone is untrusted: numbers are clamped and text is capped. */
export function readAppCartResult(raw: unknown): AppCartResult | null {
  const row = record(raw);
  if (!row || !isShopApp(row.store)) return null;
  const added = Array.isArray(row.added) ? row.added.slice(0, RESULT_LINES).map(cartLine).filter((line): line is CartLine => line !== null) : [];
  const bill = record(row.cart);
  const seen = record(row.seen);
  return {
    store: row.store,
    added,
    cart: bill
      ? { itemsTotal: amount(bill.itemsTotal), handling: amount(bill.handling), delivery: amount(bill.delivery), otherFees: amount(bill.otherFees), grandTotal: amount(bill.grandTotal) }
      : null,
    stoppedAt: shown(row.stoppedAt, LABEL_LIMIT),
    reason: CART_REASONS.find((reason) => reason === row.reason) ?? null,
    seen: seenName(seen),
    elapsedMs: typeof row.elapsedMs === "number" && Number.isFinite(row.elapsedMs) && row.elapsedMs > 0 && row.elapsedMs < 600_000 ? Math.round(row.elapsedMs) : null,
  };
}

/** Reads what the phone reports after app_event_book, with the same limits as the cart result. */
export function readAppEventResult(raw: unknown): AppEventResult | null {
  const row = record(raw);
  if (!row || !isEventApp(row.app)) return null;
  const seats = Array.isArray(row.seats)
    ? row.seats.slice(0, 10).map((seat) => shown(seat, 16)).filter((seat): seat is string => seat !== null)
    : null;
  return {
    app: row.app,
    tickets: typeof row.tickets === "number" && Number.isFinite(row.tickets) ? Math.min(10, Math.max(1, Math.round(row.tickets))) : null,
    showtime: showtime(row.showtime),
    seats,
    total: amount(row.total),
    stoppedAt: shown(row.stoppedAt, LABEL_LIMIT),
    reason: shown(row.reason, LABEL_LIMIT),
  };
}

/** Reads the `automation` field of get_capabilities data, or the copy the web app sends with a chat message. */
export function readPhoneAutomation(raw: unknown): PhoneAutomation | null {
  const row = record(raw);
  if (!row || typeof row.serviceOn !== "boolean") return null;
  const apps: PhoneAutomation["apps"] = {};
  const listed = record(row.apps);
  for (const app of [...SHOP_APPS, ...EVENT_APPS]) {
    const entry = listed ? record(listed[app]) : null;
    if (entry && typeof entry.installed === "boolean") apps[app] = { installed: entry.installed, version: shown(entry.version, 32) };
  }
  return { serviceOn: row.serviceOn, apps };
}

/** The phone can drive this app only when Scout's Accessibility service is on and the app is installed. */
export function canAutomate(automation: PhoneAutomation | null | undefined, app: AutomationApp): boolean {
  return automation?.serviceOn === true && appInstalled(automation, app);
}

/** The event app is on the phone, so Book can open it even when the accessibility service is off. */
export function appInstalled(automation: PhoneAutomation | null | undefined, app: AutomationApp): boolean {
  return automation?.apps[app]?.installed === true;
}

/** On the phone, onboarding stays up until Scout's accessibility service is on. A browser, or a phone that did not report, is not blocked. */
export function accessibilityReady(insideApp: boolean, automation: PhoneAutomation | null | undefined): boolean {
  if (!insideApp) return true;
  if (automation == null) return true;
  return automation.serviceOn;
}

export function automatableApps<App extends AutomationApp>(automation: PhoneAutomation | null | undefined, apps: readonly App[]): App[] {
  return apps.filter((app) => canAutomate(automation, app));
}

function productRef(raw: unknown, now: number): ProductRef | null {
  const row = record(raw);
  if (!row || !isShopApp(row.store)) return null;
  const name = text(row.name, NAME_LIMIT);
  const price = rupees(row.price);
  const seenAt = moment(row.seenAt);
  const size = optionalText(row.size, SIZE_LIMIT);
  const productId = row.productId == null ? null : typeof row.productId === "string" && REF_ID.test(row.productId) ? row.productId : undefined;
  const link = row.link == null ? null : isAppLink(row.store, row.link) ? row.link : undefined;
  if (!name || !plain(name) || price == null || price <= 0 || seenAt == null || seenAt <= 0 || seenAt > now + 5 * 60_000) return null;
  if (size === undefined || productId === undefined || link === undefined) return null;
  return { store: row.store, productId, link, name, size, price, seenAt };
}

function eventRef(raw: unknown): EventRef | null {
  const row = record(raw);
  if (!row || !isEventApp(row.app) || !isAppLink(row.app, row.link)) return null;
  const title = text(row.title, 160);
  const venue = optionalText(row.venue, 160);
  const eventId = row.eventId == null ? null : typeof row.eventId === "string" && REF_ID.test(row.eventId) ? row.eventId : undefined;
  const startsAt = row.startsAt == null ? null : moment(row.startsAt);
  const price = row.price == null ? null : rupees(row.price);
  if (!title || !plain(title) || venue === undefined || eventId === undefined) return null;
  if ((row.startsAt != null && startsAt == null) || (row.price != null && (price == null || price < 0))) return null;
  return { app: row.app, eventId, link: row.link, title, venue, startsAt, price };
}

function seenName(seen: Record<string, unknown> | null): AppCartResult["seen"] {
  const name = seen ? shown(seen.name, NAME_LIMIT) : null;
  if (!seen || !name) return null;
  return {
    name,
    size: shown(seen.size, SIZE_LIMIT),
    price: amount(seen.price),
    inStock: typeof seen.inStock === "boolean" ? seen.inStock : null,
  };
}

function showtime(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < MIN_SHOWTIME || rounded > MAX_SHOWTIME) return null;
  return rounded;
}

function cartLine(raw: unknown): CartLine | null {
  const row = record(raw);
  const name = row ? shown(row.name, NAME_LIMIT) : null;
  if (!row || !name) return null;
  const quantity = typeof row.quantity === "number" && Number.isFinite(row.quantity) ? Math.min(99, Math.max(1, Math.round(row.quantity))) : 1;
  return { name, size: shown(row.size, SIZE_LIMIT), quantity, unitPrice: amount(row.unitPrice), lineTotal: amount(row.lineTotal) };
}

function cartSummary(items: readonly CartItem[]): string {
  const store = appName(items[0]?.ref.store ?? "blinkit");
  const first = items[0];
  if (items.length === 1 && first) return `Add ${first.quantity} × ${product(first.ref)} to your ${store} cart (up to ${money(first.maxPrice)} each)`;
  return `Add ${items.length} items to your ${store} cart: ${items.map((item) => `${item.quantity} × ${product(item.ref)} (up to ${money(item.maxPrice)})`).join(", ")}`;
}

function bookSummary(args: Extract<DeviceCommand, { name: "app_event_book" }>["args"], timeZone: string): string {
  void timeZone;
  return `Open ${args.ref.title} on ${appName(args.ref.app)} and stop before payment`;
}

function product(ref: ProductRef): string {
  return ref.size && !ref.name.toLowerCase().includes(ref.size.toLowerCase()) ? `${ref.name} ${ref.size}` : ref.name;
}

function money(value: number): string {
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function clip(value: string): string {
  return value.length <= SUMMARY_LIMIT ? value : `${value.slice(0, SUMMARY_LIMIT - 1)}…`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function plain(value: string): boolean {
  return !UNSAFE_SCHEME.test(value) && !/[<>\u0000-\u001f\u007f]/.test(value);
}

function optionalText(value: unknown, limit: number): string | null | undefined {
  if (value == null || value === "") return null;
  const read = text(value, limit);
  return read && plain(read) ? read : undefined;
}

function rupees(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_RUPEES) return null;
  return Math.round(value * 100) / 100;
}

function amount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(Math.min(value, MAX_BILL) * 100) / 100;
}

function shown(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
  return cleaned.length > 0 ? cleaned : null;
}

function integer(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

/** Country code plus subscriber number, digits only. A leading + is dropped. */
function whatsAppName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 40) return null;
  if (/[0-9@/\\]/.test(name) || /(file|content|intent|javascript):/i.test(name)) return null;
  return name;
}

function whatsAppPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.trim().replace(/^\+/, "").replace(/[\s-]/g, "");
  if (!/^[1-9][0-9]{7,14}$/.test(digits)) return null;
  return digits;
}

function text(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= limit ? trimmed : null;
}

function label(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, LABEL_LIMIT) : "";
}

function moment(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function duration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour`;
  if (seconds % 60 === 0) return `${seconds / 60} minute`;
  return `${seconds} second`;
}
