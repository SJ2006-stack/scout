import { randomBytes } from "node:crypto";
import type { ChatEvent } from "../shared/chatEvents.ts";
import {
  appName,
  automatableApps,
  canAutomate,
  commandApp,
  DEVICE_ACTION_NAMES,
  DEVICE_ACTION_TTL_MS,
  DEVICE_APPS,
  deviceSummary,
  EVENT_APPS,
  handoffLink,
  isAppAction,
  isAppActionName,
  needsConfirmation,
  readDeviceCommand,
  SHOP_APPS,
  type AppActionName,
  type DeviceAction,
  type DeviceCommand,
  type PhoneAutomation,
} from "../shared/deviceActions.ts";
import type { AgentId } from "../shared/hosts.ts";
import type { EventApp, ShopApp } from "../shared/productRef.ts";
import { isProfileKey, PROFILE_KEYS, profilePrompt, type ProfileStore } from "./profile/profileStore.ts";
import { isEventKind, isWatchWhen, type WatchStore } from "./watch/watchStore.ts";
import { ASK_PROMPT, ASK_TOOL, askUser } from "./questionBack.ts";
import { GOOGLE_TOOLS, GOOGLE_TOOL_NAMES, googlePrompt, type GoogleAccounts, type GoogleToolName } from "./googleAccount.ts";

export type AssistantToolName = "ask_user" | "remember_preference" | "forget_preference" | "phone_action" | "watch_events" | AppActionName | GoogleToolName;

export type AssistantContext = {
  userId: string;
  agent: AgentId;
  now: () => number;
  timezone: string;
  profile?: ProfileStore;
  watches?: WatchStore;
  /** What the Scout Android app reported about its Accessibility service and installed store and event apps. */
  phone?: PhoneAutomation;
  google?: GoogleAccounts;
  fetchImpl?: typeof fetch;
  googleRedirect?: string;
};

export type AssistantToolResult = { ok: boolean; content: string };

const ASSISTANT_NAMES: readonly AssistantToolName[] = ["ask_user", "remember_preference", "forget_preference", "phone_action", "watch_events", "app_cart_add", "app_event_book", ...GOOGLE_TOOL_NAMES];
const PHONE_ACTION_NAMES = DEVICE_ACTION_NAMES.filter((name) => !isAppActionName(name));
const APP_AGENT: Readonly<Record<AppActionName, AgentId>> = { app_cart_add: "shop", app_event_book: "event" };

const REMEMBER = {
  name: "remember_preference",
  description: `Save one lasting preference they stated, shared by every Scout specialist. Keys: ${PROFILE_KEYS.join(", ")}. Only save what they clearly said about themselves. Never save codes, PINs, passwords, or card numbers. event_kinds is a comma list of movie, concert, comedy, theatre, workshop. city is bengaluru, mumbai, delhi, or hyderabad. budget_rupees is a whole number.`,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: { key: { type: "string", enum: [...PROFILE_KEYS] }, value: { type: "string" } },
    required: ["key", "value"],
  },
} as const;

const FORGET = {
  name: "forget_preference",
  description: "Delete one saved preference when they ask Scout to forget it.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: { key: { type: "string", enum: [...PROFILE_KEYS] } },
    required: ["key"],
  },
} as const;

const PHONE = {
  name: "phone_action",
  description: `Run one action on their Android phone through the Scout app: ${PHONE_ACTION_NAMES.join(", ")}. The phone confirms the result on screen; tell them it was sent to the phone, not that it is done. set_alarm takes hour (0-23), minute, label. set_timer takes seconds, label. create_reminder takes title and at as an ISO time with offset, for example 2026-11-01T18:00:00+05:30. cancel_reminder takes reminderId. open_app takes app, one of ${DEVICE_APPS.join(", ")}. open_maps takes query. share_text takes text. send_whatsapp takes text plus either phone (country code plus number, digits) or name (the chat's exact name). A number opens that chat directly. A name searches WhatsApp and opens the one matching chat. The phone then taps Send. If accessibility is off, a number still opens with the text filled in and Send left for them. toggle_flashlight takes on (true or false). set_volume takes stream (media, ring, alarm) and percent.`,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: [...PHONE_ACTION_NAMES] },
      hour: { type: "integer" },
      minute: { type: "integer" },
      seconds: { type: "integer" },
      label: { type: "string" },
      title: { type: "string" },
      at: { type: "string" },
      reminderId: { type: "string" },
      app: { type: "string", enum: [...DEVICE_APPS] },
      query: { type: "string" },
      text: { type: "string" },
      on: { type: "boolean" },
      stream: { type: "string", enum: ["media", "ring", "alarm"] },
      percent: { type: "integer" },
    },
    required: ["action"],
  },
} as const;

const WATCH = {
  name: "watch_events",
  description: "Save a recurring Scout Watch that checks Luma, District, and BookMyShow in the background and notifies their phone about new matches. Use when they say watch, keep an eye on, alert me, or tell me when. city is bengaluru, mumbai, delhi, or hyderabad. when is today, tomorrow, weekend, or week and stays relative. kind is movie, concert, comedy, theatre, workshop, other, or any. budgetRupees is 0 for no limit.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      city: { type: "string", enum: ["bengaluru", "mumbai", "delhi", "hyderabad"] },
      when: { type: "string", enum: ["today", "tomorrow", "weekend", "week"] },
      kind: { type: "string", enum: ["movie", "concert", "comedy", "theatre", "workshop", "other", "any"] },
      budgetRupees: { type: "integer" },
    },
    required: ["city", "when", "kind", "budgetRupees"],
  },
} as const;

const NULLABLE_TEXT = { type: ["string", "null"] } as const;
const TIME = { type: ["number", "string", "null"], description: "Epoch milliseconds or an ISO time with offset." } as const;

function cartTool(stores: readonly ShopApp[]) {
  return {
    name: "app_cart_add",
    description: `Add items to the cart in their own ${stores.map(appName).join(", ")} app on their Android phone. Scout's Accessibility service opens the app, checks the price, size, and stock again, sets the quantity, opens the cart, and stops before payment. They tap Allow on the phone first and pay in the app themselves. Pass each product reference exactly as the comparison returned it, including a null Instamart link. The phone searches Instamart by name and size when the link is missing. All items go to one store. maxPrice is their limit per unit in rupees; if they gave none, use the price Scout saw. allowSimilar is false unless they said a similar item is fine.`,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              ref: {
                type: "object",
                additionalProperties: false,
                properties: {
                  store: { type: "string", enum: [...stores] },
                  productId: NULLABLE_TEXT,
                  link: NULLABLE_TEXT,
                  name: { type: "string" },
                  size: NULLABLE_TEXT,
                  price: { type: "number" },
                  seenAt: { type: ["number", "string"] },
                },
                required: ["store", "productId", "link", "name", "size", "price", "seenAt"],
              },
              quantity: { type: "integer", minimum: 1, maximum: 20 },
              maxPrice: { type: "number" },
            },
            required: ["ref", "quantity", "maxPrice"],
          },
        },
        allowSimilar: { type: "boolean" },
      },
      required: ["items", "allowSimilar"],
    },
  } as const;
}

function bookTool(apps: readonly EventApp[]) {
  return {
    name: "app_event_book",
    description: `Open one event in their own ${apps.map(appName).join(", ")} app. The phone opens that listing link, closes a dining or membership sheet when it recognises one, and goes as far as it can without paying or signing up. BookMyShow movie: Book tickets, the first language and format, then with showtime set that day and time at the cinema in ref.venue and the ticket count, stopping on the seat map. District movie: that day and time at the cinema in ref.venue, stopping on the seat map. District event: the day and time slot from showtime, the cheapest ticket type within maxPricePerTicket, and the ticket count, stopping with Checkout on screen and the total read back. Luma: opens the registration form with the answers Luma fills in, and stops before its Register button. Without a showtime a movie stops on the showtimes and a District event on its calendar, and the result lists what is open. It never picks seats or taps Pay, Checkout, or Register. They tap Allow on the phone first. Build ref from the listing: app is its source, link is its url, title, venue (for a movie, the cinema they chose, else null), startsAt is its start, price. seat stays user_picks.`,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ref: {
          type: "object",
          additionalProperties: false,
          properties: {
            app: { type: "string", enum: [...apps] },
            eventId: NULLABLE_TEXT,
            link: { type: "string" },
            title: { type: "string" },
            venue: NULLABLE_TEXT,
            startsAt: TIME,
            price: { type: ["number", "null"] },
          },
          required: ["app", "eventId", "link", "title", "venue", "startsAt", "price"],
        },
        tickets: { type: "integer", minimum: 1, maximum: 10 },
        maxPricePerTicket: { type: ["number", "null"] },
        seat: { type: "string", enum: ["best_available", "user_picks"] },
        showtime: TIME,
      },
      required: ["ref", "tickets", "maxPricePerTicket", "seat", "showtime"],
    },
  } as const;
}

export function assistantTools(context: AssistantContext): readonly Record<string, unknown>[] {
  const tools: Record<string, unknown>[] = [ASK_TOOL, PHONE];
  if (context.profile) tools.push(REMEMBER, FORGET);
  if (context.watches && (context.agent === "event" || context.agent === "main")) tools.push(WATCH);
  const stores = automatableApps(context.phone, SHOP_APPS);
  if (context.agent === "shop" && stores.length > 0) tools.push(cartTool(stores));
  const apps = automatableApps(context.phone, EVENT_APPS);
  if (context.agent === "event" && apps.length > 0) tools.push(bookTool(apps));
  if (context.google) tools.push(...GOOGLE_TOOLS);
  return tools;
}

export function isAssistantTool(value: unknown): value is AssistantToolName {
  return typeof value === "string" && ASSISTANT_NAMES.some((name) => name === value);
}

export function assistantPrompt(context: AssistantContext): string {
  const profile = context.profile ? profilePrompt(context.profile.list(context.userId)) : "";
  const phone = "When they ask for something on their phone (alarm, timer, reminder, flashlight, volume, open an app or maps, share), call phone_action. The Scout Android app runs it and shows the verified result.";
  const watch = context.watches && (context.agent === "event" || context.agent === "main")
    ? "When they want to be told later about new events, call watch_events. It keeps running after this chat."
    : "";
  return [profile, ASK_PROMPT, phone, watch, googlePrompt(context.google != null), appPrompt(context)].filter((line) => line.length > 0).join(" ");
}

function appPrompt(context: AssistantContext): string {
  if (context.agent === "shop") {
    const stores = automatableApps(context.phone, SHOP_APPS);
    const missing = SHOP_APPS.filter((store) => !stores.includes(store)).map(appName);
    const ready = stores.length > 0
      ? `For ${stores.map(appName).join(", ")}, when they ask to add or buy compared items, call app_cart_add instead of buy_from_shop. Their phone fills the cart in the real app and stops before payment; tell them to tap Allow on the phone, not that it is added.`
      : "";
    const handoff = missing.length > 0
      ? `Scout cannot drive the ${missing.join(", ")} app on this phone (the Scout app's Accessibility service is off or the store app is missing). For those, offer the product link so they open it in the app themselves, or buy_from_shop if they want Scout's browser to build the cart.`
      : "";
    return [ready, handoff].filter((line) => line.length > 0).join(" ");
  }
  if (context.agent === "event") {
    const apps = automatableApps(context.phone, EVENT_APPS);
    return apps.length > 0
      ? `For tickets on ${apps.map(appName).join(", ")}, call app_event_book instead of register_event. Their phone picks the tickets in the real app and stops before payment; tell them to tap Allow on the phone.`
      : "Scout cannot drive the BookMyShow, District, or Luma apps on this phone. If they ask to book in the app, give them the listing link to open.";
  }
  return "";
}

export async function runAssistantTool(
  context: AssistantContext,
  name: AssistantToolName,
  input: unknown,
  emit: (event: ChatEvent) => void,
): Promise<AssistantToolResult> {
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  switch (name) {
    case "ask_user":
      return askUser(context.userId, context.agent, input, emit);
    case "remember_preference": {
      if (!context.profile) return { ok: false, content: "Memory is not available." };
      if (!isProfileKey(args.key) || typeof args.value !== "string") return { ok: false, content: "Pass a known key and a value." };
      const saved = context.profile.set(context.userId, args.key, args.value, "explicit", context.now());
      if (!saved.ok) return { ok: false, content: saved.error };
      emit({ type: "note", message: `Remembered ${args.key.replace(/_/g, " ")}: ${saved.entry.value}` });
      return { ok: true, content: `Saved ${args.key}=${saved.entry.value} for every Scout specialist.` };
    }
    case "forget_preference": {
      if (!context.profile) return { ok: false, content: "Memory is not available." };
      if (!isProfileKey(args.key)) return { ok: false, content: "Pass a known key." };
      const removed = context.profile.remove(context.userId, args.key);
      if (removed) emit({ type: "note", message: `Forgot ${args.key.replace(/_/g, " ")}.` });
      return { ok: true, content: removed ? `Forgot ${args.key}.` : `Nothing was saved for ${args.key}.` };
    }
    case "phone_action": {
      const { action, ...rest } = args;
      if (isAppActionName(action)) return { ok: false, content: `Use the ${action} tool for that.` };
      const read = readDeviceCommand(action, rest, context.now());
      if (!read.ok) return { ok: false, content: read.error };
      const device = deviceAction(context, read.command);
      emit({ type: "device", action: device });
      return {
        ok: true,
        content: device.confirm
          ? `Sent to the phone for approval: ${device.summary}. They must tap Allow; the phone reports the result.`
          : `Sent to the phone: ${device.summary}. The phone reports whether it completed.`,
      };
    }
    case "app_cart_add":
    case "app_event_book": {
      const read = readDeviceCommand(name, args, context.now());
      if (!read.ok) return { ok: false, content: read.error };
      if (!isAppAction(read.command) || context.agent !== APP_AGENT[name]) return { ok: false, content: "This scout cannot run that phone action." };
      const app = commandApp(read.command);
      if (!canAutomate(context.phone, app)) {
        return {
          ok: false,
          content: `Scout cannot drive the ${appName(app)} app on this phone: the Scout app's Accessibility service is off or ${appName(app)} is not installed. Give them this link to open it in ${appName(app)} themselves: ${handoffLink(read.command)}`,
        };
      }
      const device = deviceAction(context, read.command);
      emit({ type: "device", action: device });
      return {
        ok: true,
        content: `Sent to the phone for approval: ${device.summary}. They tap Allow, then Scout works in ${appName(app)} and stops before payment. The phone reports what it added or where it stopped on a card. Do not say it is done.`,
      };
    }
    case "connect_google":
    case "gmail_recent":
    case "gmail_send":
    case "gmail_change":
    case "drive_find":
    case "drive_read":
    case "drive_write":
    case "drive_trash": {
      if (!context.google) return { ok: false, content: "Gmail and Drive are not available." };
      const ran = await context.google.run(context.userId, name, args, context.fetchImpl ?? fetch, context.googleRedirect ?? "");
      if (ran.note) emit({ type: "note", message: ran.note });
      return { ok: ran.ok, content: ran.content };
    }
    case "watch_events": {
      if (!context.watches) return { ok: false, content: "Scout Watch is not available." };
      const kind = args.kind === "any" ? null : isEventKind(args.kind) ? args.kind : undefined;
      if (typeof args.city !== "string" || !isWatchWhen(args.when) || kind === undefined) return { ok: false, content: "Pass city, when, kind, and budgetRupees." };
      const budget = typeof args.budgetRupees === "number" && args.budgetRupees > 0 ? Math.floor(args.budgetRupees) : null;
      const created = context.watches.create(context.userId, { cityId: args.city, kind, when: args.when, budget, query: "" }, context.now());
      if (!created.ok) return { ok: false, content: created.error };
      emit({ type: "watch", watch: { id: created.watch.id, cityId: created.watch.cityId, kind: created.watch.kind, when: created.watch.when, budget: created.watch.budget, intervalMinutes: created.watch.intervalMinutes } });
      return { ok: true, content: `Watch saved. It checks every ${created.watch.intervalMinutes} minutes and notifies their phone about new matches.` };
    }
    default: {
      const neverName: never = name;
      return neverName;
    }
  }
}

function deviceAction(context: AssistantContext, command: DeviceCommand): DeviceAction {
  return {
    ...command,
    id: randomBytes(12).toString("hex"),
    summary: deviceSummary(command, context.timezone),
    confirm: needsConfirmation(command),
    expiresAt: context.now() + DEVICE_ACTION_TTL_MS,
  };
}
