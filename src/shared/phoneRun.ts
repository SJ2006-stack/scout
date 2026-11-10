import {
  appName,
  commandApp,
  handoffLink,
  isAppAction,
  isAppActionName,
  isAppLink,
  isDeviceStatus,
  isEventApp,
  isShopApp,
  readAppCartResult,
  readAppEventResult,
  type AppActionName,
  type AppCartResult,
  type AppEventResult,
  type AutomationApp,
  type CartStopReason,
  type DeviceAction,
  type DeviceResult,
  type DeviceStatus,
} from "./deviceActions.ts";

/** One app_cart_add or app_event_book run, as the chat card shows it. */
export type PhoneRun = {
  id: string;
  action: AppActionName;
  app: AutomationApp;
  summary: string;
  link: string;
  status: DeviceStatus | "sent";
  message: string;
  cart: AppCartResult | null;
  event: AppEventResult | null;
};

export type PhoneRunState = "waiting" | "added" | "needs_ok" | "stopped" | "handed";

const NEEDS_OK: readonly CartStopReason[] = ["price_above_limit", "out_of_stock", "size_mismatch"];

export function phoneRunFromAction(action: DeviceAction): PhoneRun | null {
  if (!isAppAction(action)) return null;
  return {
    id: action.id,
    action: action.name,
    app: commandApp(action),
    summary: action.summary,
    link: handoffLink(action),
    status: "sent",
    message: "",
    cart: null,
    event: null,
  };
}

export function applyPhoneResult(run: PhoneRun, result: DeviceResult): PhoneRun {
  if (result.id !== run.id) return run;
  const cart = run.action === "app_cart_add" ? readAppCartResult(result.data) : null;
  const event = run.action === "app_event_book" ? readAppEventResult(result.data) : null;
  return {
    ...run,
    status: result.status,
    message: result.message,
    cart: cart && cart.store === run.app ? cart : run.cart,
    event: event && event.app === run.app ? event : run.event,
  };
}

export function phoneRunState(run: PhoneRun): PhoneRunState {
  switch (run.status) {
    case "sent":
      return "waiting";
    case "completed":
      return "added";
    case "needs_approval":
      return hasMismatch(run) ? "needs_ok" : "waiting";
    case "handoff_started":
      return "handed";
    case "needs_permission":
    case "failed":
      return "stopped";
    default: {
      const neverStatus: never = run.status;
      return neverStatus;
    }
  }
}

/** Plain words for why the phone stopped. */
export function stopReasonLine(reason: CartStopReason, app: AutomationApp): string {
  const name = appName(app);
  switch (reason) {
    case "no_match":
      return `${name} did not show a matching item.`;
    case "price_above_limit":
      return "The price in the app is above your limit.";
    case "out_of_stock":
      return `It is out of stock on ${name} right now.`;
    case "size_mismatch":
      return "The app only has a different size.";
    case "not_signed_in":
      return `Sign in to ${name} on your phone first.`;
    case "no_address":
      return `Set a delivery address in ${name} first.`;
    case "app_missing":
      return `${name} is not installed on this phone.`;
    case "service_off":
      return "Turn on Scout's Accessibility service in Android settings.";
    case "screen_changed":
      return `${name} showed a screen Scout did not expect, so it stopped.`;
    case "timeout":
      return `${name} took too long to respond.`;
    case "captcha":
      return `${name} asked for a check only you can do.`;
    case "location_off":
      return `Turn on Location on your phone. ${name} will not continue without it.`;
    case "user_stopped":
      return "You stopped Scout.";
    case "payment_pin":
      return `${name} is asking for a UPI PIN or code. Enter it yourself. Scout does not type that.`;
    default: {
      const neverReason: never = reason;
      return neverReason;
    }
  }
}

export function phoneRunReason(run: PhoneRun): string {
  if (run.cart?.reason) return stopReasonLine(run.cart.reason, run.app);
  return run.event?.reason ?? run.message;
}

export function payLabel(run: PhoneRun): string {
  return `Pay in ${appName(run.app)}`;
}

export function openLabel(run: PhoneRun): string {
  return `Open ${appName(run.app)}`;
}

export function isPhoneRun(value: unknown): value is PhoneRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<Record<keyof PhoneRun, unknown>>;
  return typeof run.id === "string"
    && /^[a-f0-9]{24}$/.test(run.id)
    && isAppActionName(run.action)
    && (isShopApp(run.app) || isEventApp(run.app))
    && payloadMatches(run.action, run.app, run.cart, run.event)
    && typeof run.summary === "string"
    && run.summary.length <= 200
    && isAppLink(run.app, run.link)
    && (run.status === "sent" || isDeviceStatus(run.status))
    && typeof run.message === "string"
    && run.message.length <= 300;
}

function payloadMatches(action: AppActionName, app: AutomationApp, cart: unknown, event: unknown): boolean {
  switch (action) {
    case "app_cart_add":
      return isShopApp(app) && event === null && (cart === null || readAppCartResult(cart)?.store === app);
    case "app_event_book":
      return isEventApp(app) && cart === null && (event === null || readAppEventResult(event)?.app === app);
    default: {
      const neverAction: never = action;
      return neverAction;
    }
  }
}

function hasMismatch(run: PhoneRun): boolean {
  if (run.cart) return (run.cart.reason != null && NEEDS_OK.includes(run.cart.reason)) || run.cart.seen != null;
  return run.event?.reason != null;
}
