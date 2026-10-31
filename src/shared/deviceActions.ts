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

export type DeviceCommand =
  | { name: "set_alarm"; args: { hour: number; minute: number; label: string } }
  | { name: "set_timer"; args: { seconds: number; label: string } }
  | { name: "create_reminder"; args: { title: string; at: number } }
  | { name: "list_reminders"; args: Record<string, never> }
  | { name: "cancel_reminder"; args: { reminderId: string } }
  | { name: "open_app"; args: { app: DeviceApp } }
  | { name: "open_maps"; args: { query: string } }
  | { name: "share_text"; args: { text: string } }
  | { name: "toggle_flashlight"; args: { on: boolean } }
  | { name: "set_volume"; args: { stream: VolumeStream; percent: number } }
  | { name: "get_capabilities"; args: Record<string, never> };

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
  "toggle_flashlight",
  "set_volume",
  "get_capabilities",
];

export const DEVICE_ACTION_TTL_MS = 2 * 60_000;
const TEXT_LIMIT = 500;
const LABEL_LIMIT = 80;
const YEAR_MS = 366 * 24 * 60 * 60_000;
const ACTION_ID = /^[a-f0-9]{24}$/;

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
    default: {
      const neverName: never = name;
      return neverName;
    }
  }
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
    case "toggle_flashlight":
      return `Turn the flashlight ${command.args.on ? "on" : "off"}`;
    case "set_volume":
      return `Set ${command.args.stream} volume to ${command.args.percent}%`;
    case "get_capabilities":
      return "Check what this phone allows";
    default: {
      const neverCommand: never = command;
      return neverCommand;
    }
  }
}

export function needsConfirmation(command: DeviceCommand): boolean {
  return command.name === "open_app" || command.name === "share_text" || (command.name === "set_volume" && command.args.stream === "ring" && command.args.percent === 0);
}

export function readDeviceResult(raw: unknown): DeviceResult | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { op?: unknown; id?: unknown; status?: unknown; message?: unknown; data?: unknown };
  if (row.op !== undefined && row.op !== "action") return null;
  if (!isActionId(row.id) || !isDeviceStatus(row.status)) return null;
  const message = typeof row.message === "string" ? row.message.slice(0, 300) : "";
  return { id: row.id, status: row.status, message, ...(row.data === undefined ? {} : { data: row.data }) };
}

function integer(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
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
