import { appName, isShopApp, type AutomationApp } from "./deviceActions.ts";
import { isPhoneRun, phoneRunState, type PhoneRun } from "./phoneRun.ts";

/** How long Scout shows a seat hold. The phone result does not include the app's own timer. */
export const SEAT_HOLD_MS = 10 * 60 * 1000;

export type PayReadyKind = "cart" | "booking";
export type PayReadyStatus = "ready" | "opened" | "paid" | "expired" | "failed";

export type PayReady = {
  taskId: string;
  app: AutomationApp;
  kind: PayReadyKind;
  title: string;
  lines: string[];
  summary: string;
  total: number | null;
  readyAt: number;
  holdExpiresAt: number | null;
  status: PayReadyStatus;
};

export type PayMark = {
  taskId: string;
  readyAt: number;
  status: PayReadyStatus;
};

export type CheckoutAppId = "blinkit" | "zepto" | "instamart" | "flipkart" | "amazon" | "bookmyshow" | "district" | "luma";
export type NativeCheckoutMove = "resume" | "cart" | "launch" | "app_missing" | "unknown";

export type CheckoutChoice = {
  app: CheckoutAppId;
  packageName: string;
  browserUrl: string;
  nativeCartUrl: string | null;
  idle: "cart" | "launch";
  website: "page" | "event";
  /** True when dumpsys on the attached phone showed this app claims the host. */
  hostClaimed: boolean;
};

/**
 * Links checked with dumpsys package on the attached phone, Nov 4, 2026.
 * Instamart claims instamart home and product paths, not /checkout or /instamart/cart.
 * Those two open Chrome, so the phone only brings in.swiggy.android forward.
 * Blinkit claims /cart, and a cold start drops the link, so an idle Blinkit task is launched.
 */
export const CHECKOUT_CHOICES: readonly CheckoutChoice[] = [
  { app: "blinkit", packageName: "com.grofers.customerapp", browserUrl: "https://blinkit.com/cart", nativeCartUrl: "https://blinkit.com/cart", idle: "launch", website: "page", hostClaimed: true },
  { app: "zepto", packageName: "com.zeptoconsumerapp", browserUrl: "https://www.zepto.com/cart", nativeCartUrl: "https://www.zepto.com/cart", idle: "cart", website: "page", hostClaimed: true },
  { app: "instamart", packageName: "in.swiggy.android", browserUrl: "https://www.swiggy.com/instamart/cart", nativeCartUrl: null, idle: "launch", website: "page", hostClaimed: false },
  { app: "flipkart", packageName: "com.flipkart.android", browserUrl: "https://www.flipkart.com/viewcart", nativeCartUrl: "https://www.flipkart.com/viewcart", idle: "cart", website: "page", hostClaimed: true },
  { app: "amazon", packageName: "in.amazon.mShop.android.shopping", browserUrl: "https://www.amazon.in/gp/cart/view.html", nativeCartUrl: "https://www.amazon.in/gp/cart/view.html", idle: "cart", website: "page", hostClaimed: true },
  { app: "bookmyshow", packageName: "com.bt.bms", browserUrl: "https://in.bookmyshow.com/", nativeCartUrl: null, idle: "launch", website: "event", hostClaimed: true },
  { app: "district", packageName: "com.application.zomato.district", browserUrl: "https://www.district.in/", nativeCartUrl: null, idle: "launch", website: "event", hostClaimed: true },
  { app: "luma", packageName: "com.luma.mobile", browserUrl: "https://luma.com/", nativeCartUrl: null, idle: "launch", website: "event", hostClaimed: true },
];

const PAY_STATUSES: readonly PayReadyStatus[] = ["ready", "opened", "paid", "expired", "failed"];
const TASK_ID = /^[a-f0-9]{24}$/;

export function checkoutChoice(app: string): CheckoutChoice | null {
  return CHECKOUT_CHOICES.find((choice) => choice.app === app) ?? null;
}

/** What the phone does for open_checkout. A running task is brought forward so the cart or seat hold stays. */
export function nativeCheckoutMove(app: string, installed: boolean, taskRunning: boolean): NativeCheckoutMove {
  const choice = checkoutChoice(app);
  if (!choice) return "unknown";
  if (!installed) return "app_missing";
  if (taskRunning) return "resume";
  if (choice.idle === "cart" && choice.nativeCartUrl) return "cart";
  return "launch";
}

/** Page opened in a browser tab. Event rows prefer the show link from the phone run. */
export function browserCartUrl(app: string, eventLink?: string): string | null {
  const choice = checkoutChoice(app);
  if (!choice) return null;
  if (choice.website === "page") return choice.browserUrl;
  if (eventLink && eventLink.startsWith("https://")) return eventLink;
  return choice.browserUrl;
}

export function nextPayStatus(status: PayReadyStatus, action: "open" | "paid" | "fail" | "tick", holdExpiresAt: number | null, now: number): PayReadyStatus {
  switch (action) {
    case "open":
      if (status === "paid" || status === "expired") return settle(status, holdExpiresAt, now);
      return settle("opened", holdExpiresAt, now);
    case "paid":
      if (status === "failed") return "failed";
      return "paid";
    case "fail":
      if (status === "paid") return "paid";
      return "failed";
    case "tick":
      return settle(status, holdExpiresAt, now);
    default: {
      const neverAction: never = action;
      return neverAction;
    }
  }
}

/** One row per app. Several finished adds in one store share that store's cart. */
export function groupPayReady(runs: readonly PhoneRun[], now: number, marks: readonly PayMark[] = []): PayReady[] {
  const groups = new Map<AutomationApp, PhoneRun[]>();
  const order: AutomationApp[] = [];
  for (const run of runs) {
    if (!isPayable(run)) continue;
    const existing = groups.get(run.app);
    if (existing) existing.push(run);
    else {
      groups.set(run.app, [run]);
      order.push(run.app);
    }
  }
  const rows: PayReady[] = [];
  for (const app of order) {
    const items = groups.get(app);
    const latest = items?.[items.length - 1];
    if (!items || !latest) continue;
    const kind: PayReadyKind = isShopApp(app) ? "cart" : "booking";
    const lines = items.flatMap((run) => runLines(run)).slice(0, 12);
    const mark = marks.find((item) => item.taskId === latest.id);
    const readyAt = mark?.readyAt ?? now;
    const holdExpiresAt = kind === "booking" ? readyAt + SEAT_HOLD_MS : null;
    rows.push({
      taskId: latest.id,
      app,
      kind,
      title: `${appName(app)} ${kind === "cart" ? "cart" : "booking"}`,
      lines,
      summary: lines.join(", ").slice(0, 180),
      total: latestTotal(items),
      readyAt,
      holdExpiresAt,
      status: nextPayStatus(mark?.status ?? "ready", "tick", holdExpiresAt, now),
    });
  }
  return rows;
}

export function visiblePayRows(rows: readonly PayReady[]): PayReady[] {
  return rows.filter((row) => row.status !== "paid");
}

export function phoneRunsFromTurns(turns: readonly { kind?: unknown; run?: unknown }[]): PhoneRun[] {
  const runs: PhoneRun[] = [];
  for (const turn of turns) {
    if (turn.kind === "phone" && isPhoneRun(turn.run)) runs.push(turn.run);
  }
  return runs;
}

export function syncPayMarks(runs: readonly PhoneRun[], now: number, marks: readonly PayMark[]): PayMark[] {
  const grouped = groupPayReady(runs, now, marks);
  const byId = new Map(marks.map((mark) => [mark.taskId, mark]));
  for (const row of grouped) byId.set(row.taskId, { taskId: row.taskId, readyAt: row.readyAt, status: row.status });
  return [...byId.values()].slice(-40);
}

export function marksEqual(left: readonly PayMark[], right: readonly PayMark[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((mark, index) => {
    const other = right[index];
    return other != null && mark.taskId === other.taskId && mark.readyAt === other.readyAt && mark.status === other.status;
  });
}

export function readPayMarks(raw: string | null): PayMark[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(readPayMark).slice(-40);
  } catch {
    return [];
  }
}

export function serializePayMarks(marks: readonly PayMark[]): string {
  return JSON.stringify(marks.slice(-40));
}

export const PAY_MARKS_KEY = "scout-pay-ready-v1";

function readPayMark(value: unknown): PayMark[] {
  if (!value || typeof value !== "object") return [];
  const mark = value as Partial<PayMark>;
  if (typeof mark.taskId !== "string" || !TASK_ID.test(mark.taskId)) return [];
  if (typeof mark.readyAt !== "number" || !Number.isFinite(mark.readyAt)) return [];
  if (!isPayStatus(mark.status)) return [];
  return [{ taskId: mark.taskId, readyAt: mark.readyAt, status: mark.status }];
}

function isPayStatus(value: unknown): value is PayReadyStatus {
  return PAY_STATUSES.some((status) => status === value);
}

function settle(status: PayReadyStatus, holdExpiresAt: number | null, now: number): PayReadyStatus {
  switch (status) {
    case "paid":
    case "failed":
      return status;
    case "ready":
    case "opened":
    case "expired":
      if (holdExpiresAt != null && now >= holdExpiresAt) return "expired";
      return status === "expired" ? "ready" : status;
    default: {
      const neverStatus: never = status;
      return neverStatus;
    }
  }
}

function isPayable(run: PhoneRun): boolean {
  if (phoneRunState(run) !== "added") return false;
  switch (run.action) {
    case "app_cart_add":
      return (run.cart?.added.length ?? 0) > 0 || run.cart?.cart?.grandTotal != null;
    case "app_event_book":
      return run.event?.total != null || run.event?.tickets != null || (run.event?.seats?.length ?? 0) > 0;
    default: {
      const neverAction: never = run.action;
      return neverAction;
    }
  }
}

function runLines(run: PhoneRun): string[] {
  switch (run.action) {
    case "app_cart_add": {
      const added = run.cart?.added ?? [];
      if (added.length === 0) return [run.summary];
      return added.map((line) => `${line.quantity} × ${line.name}${line.size ? ` ${line.size}` : ""}`);
    }
    case "app_event_book": {
      const lines: string[] = [];
      if (run.event?.tickets != null) lines.push(`${run.event.tickets} ${run.event.tickets === 1 ? "ticket" : "tickets"}`);
      if (run.event?.seats && run.event.seats.length > 0) lines.push(run.event.seats.join(", "));
      if (lines.length === 0) lines.push(run.summary);
      return lines;
    }
    default: {
      const neverAction: never = run.action;
      return neverAction;
    }
  }
}

function latestTotal(items: readonly PhoneRun[]): number | null {
  let total: number | null = null;
  for (const run of items) {
    const next = runTotal(run);
    if (next != null) total = next;
  }
  return total;
}

function runTotal(run: PhoneRun): number | null {
  switch (run.action) {
    case "app_cart_add":
      return run.cart?.cart?.grandTotal ?? null;
    case "app_event_book":
      return run.event?.total ?? null;
    default: {
      const neverAction: never = run.action;
      return neverAction;
    }
  }
}
