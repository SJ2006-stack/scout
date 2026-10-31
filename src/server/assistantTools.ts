import { randomBytes } from "node:crypto";
import type { ChatEvent } from "../shared/chatEvents.ts";
import {
  DEVICE_ACTION_NAMES,
  DEVICE_ACTION_TTL_MS,
  DEVICE_APPS,
  deviceSummary,
  needsConfirmation,
  readDeviceCommand,
  type DeviceAction,
} from "../shared/deviceActions.ts";
import type { AgentId } from "../shared/hosts.ts";
import { isProfileKey, PROFILE_KEYS, profilePrompt, type ProfileStore } from "./profile/profileStore.ts";
import { isEventKind, isWatchWhen, type WatchStore } from "./watch/watchStore.ts";

export type AssistantToolName = "remember_preference" | "forget_preference" | "phone_action" | "watch_events";

export type AssistantContext = {
  userId: string;
  agent: AgentId;
  now: () => number;
  timezone: string;
  profile?: ProfileStore;
  watches?: WatchStore;
};

export type AssistantToolResult = { ok: boolean; content: string };

const ASSISTANT_NAMES: readonly AssistantToolName[] = ["remember_preference", "forget_preference", "phone_action", "watch_events"];

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
  description: `Run one action on their Android phone through the Scout app: ${DEVICE_ACTION_NAMES.join(", ")}. The phone confirms the result on screen; tell them it was sent to the phone, not that it is done. set_alarm takes hour (0-23), minute, label. set_timer takes seconds, label. create_reminder takes title and at as an ISO time with offset, for example 2026-11-01T18:00:00+05:30. cancel_reminder takes reminderId. open_app takes app, one of ${DEVICE_APPS.join(", ")}. open_maps takes query. share_text takes text. toggle_flashlight takes on (true or false). set_volume takes stream (media, ring, alarm) and percent.`,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: [...DEVICE_ACTION_NAMES] },
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

export function assistantTools(context: AssistantContext): readonly Record<string, unknown>[] {
  const tools: Record<string, unknown>[] = [PHONE];
  if (context.profile) tools.push(REMEMBER, FORGET);
  if (context.watches && (context.agent === "event" || context.agent === "main")) tools.push(WATCH);
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
  return [profile, phone, watch].filter((line) => line.length > 0).join(" ");
}

export async function runAssistantTool(
  context: AssistantContext,
  name: AssistantToolName,
  input: unknown,
  emit: (event: ChatEvent) => void,
): Promise<AssistantToolResult> {
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  switch (name) {
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
      const read = readDeviceCommand(action, rest, context.now());
      if (!read.ok) return { ok: false, content: read.error };
      const device: DeviceAction = {
        ...read.command,
        id: randomBytes(12).toString("hex"),
        summary: deviceSummary(read.command, context.timezone),
        confirm: needsConfirmation(read.command),
        expiresAt: context.now() + DEVICE_ACTION_TTL_MS,
      };
      emit({ type: "device", action: device });
      return {
        ok: true,
        content: device.confirm
          ? `Sent to the phone for approval: ${device.summary}. They must tap Allow; the phone reports the result.`
          : `Sent to the phone: ${device.summary}. The phone reports whether it completed.`,
      };
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
