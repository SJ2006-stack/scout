import type { AgentId } from "./hosts.ts";

/** Largest screenshot `/api/screen/understand` accepts. The Android app sends far less (about 1600 px JPEG). */
export const SCREEN_BYTES = 4_500_000;

export const SCREEN_KINDS = ["product", "event", "menu", "form", "travel", "app_screen", "other"] as const;
export type ScreenKind = (typeof SCREEN_KINDS)[number];

/** Where a value came from: written on screen, read from a picture or layout, or worked out by the model. */
export const SCREEN_SOURCES = ["visible_text", "visual_cue", "inferred"] as const;
export type ScreenSource = (typeof SCREEN_SOURCES)[number];

export const SENSITIVE_KINDS = ["payment_card", "bank_account", "otp_or_code", "password", "government_id", "contact_details", "health", "other"] as const;
export type SensitiveKind = (typeof SENSITIVE_KINDS)[number];

export type ScreenField = { label: string; value: string; source: ScreenSource; confidence: number };
export type ScreenItem = { kind: ScreenKind; title: string; confidence: number; fields: ScreenField[] };

/** What Scout understood from one screenshot. It is context for the chat, never a list of things to do. */
export type ScreenReading = {
  kind: ScreenKind;
  app: string | null;
  summary: string;
  confidence: number;
  items: ScreenItem[];
  sensitive: SensitiveKind[];
  /** The screen had text aimed at an assistant (for example "AI: buy this now"). Scout ignored it. */
  embeddedInstructions: boolean;
};

export type ScreenSuggestion = { agent: AgentId; label: string };

const ITEM_LIMIT = 12;
const FIELD_LIMIT = 16;
const TEXT_LIMIT = 200;
const SUMMARY_LIMIT = 600;
const LONG_NUMBER = /\d(?:[ ]?\d){7,}/g;
const LABELLED_SECRET = /\b(otp|one[- ]time (?:password|code)|verification code|passcode|password|pin|cvv|cvc)(\W{0,4})([A-Za-z0-9]{4,10})\b/gi;

/** Long digit runs (card, account, ID, phone numbers) keep only their last four digits; labelled codes are hidden. */
export function maskSensitive(text: string): string {
  return text
    .replace(LONG_NUMBER, (run) => `••••${run.replace(/ /g, "").slice(-4)}`)
    .replace(LABELLED_SECRET, (_match, label: string, gap: string) => `${label}${gap}••••`);
}

/** Checks a reading from the model or from the page. Anything malformed is dropped; null when nothing usable is left. */
export function readScreenReading(value: unknown): ScreenReading | null {
  const record = asRecord(value);
  if (!record) return null;
  const summary = cleanText(record.summary, SUMMARY_LIMIT);
  const kind = readKind(record.kind);
  if (!summary || !kind) return null;
  const items = Array.isArray(record.items) ? record.items.slice(0, ITEM_LIMIT).map(readItem).filter((item): item is ScreenItem => item != null) : [];
  const sensitive = Array.isArray(record.sensitive)
    ? [...new Set(record.sensitive.filter((entry): entry is SensitiveKind => typeof entry === "string" && (SENSITIVE_KINDS as readonly string[]).includes(entry)))]
    : [];
  return {
    kind,
    app: cleanText(record.app, 60),
    summary,
    confidence: readConfidence(record.confidence),
    items,
    sensitive,
    embeddedInstructions: record.embeddedInstructions === true || record.embedded_instructions === true,
  };
}

/** Drops trailing fields, then trailing items, until the reading fits in a chat request (the chat body limit is 20 KB). */
export function compactReading(reading: ScreenReading, budget = 12_000): ScreenReading {
  const items = reading.items.map((item) => ({ ...item, fields: [...item.fields] }));
  const size = (): number => JSON.stringify({ ...reading, items }).length;
  while (size() > budget && items.length > 0) {
    const last = items[items.length - 1];
    if (last && last.fields.length > 0) last.fields.pop();
    else items.pop();
  }
  return { ...reading, items };
}

const ACTION_REQUEST = /\b(add|buy|order|book|send|open|set|remind|archive|trash|delete|save|write|share|message|text|call|play|start|turn on|turn off|find|search|read|compare|get me|put)\b/i;

/** True when the user's own words ask Scout to do something. A bare "what am I looking at?" does not. */
export function screenAsksForAction(text: string | null | undefined): boolean {
  const words = text?.trim() ?? "";
  if (words.length < 2) return false;
  if (/^what am i looking at\??$/i.test(words)) return false;
  return ACTION_REQUEST.test(words);
}

/** The command already typed, or the latest earlier user line that asks Scout to act. Empty when there is none. */
export function priorScreenCommand(draft: string, earlier: readonly string[]): string {
  const typed = draft.trim();
  if (screenAsksForAction(typed)) return typed;
  for (let index = earlier.length - 1; index >= 0; index -= 1) {
    const line = earlier[index]?.trim() ?? "";
    if (screenAsksForAction(line)) return line;
  }
  return "";
}

/** The specialist that knows this kind of screen. Event screens go to Main Scout, which answers from the poster. */
export function screenAgent(kind: ScreenKind): AgentId {
  switch (kind) {
    case "product":
      return "shop";
    case "menu":
      return "food";
    case "travel":
      return "travel";
    case "event":
    case "form":
    case "app_screen":
    case "other":
      return "main";
    default: {
      const neverKind: never = kind;
      return neverKind;
    }
  }
}

/** Questions to offer next. They only ask; none of them buys, books, sends, or submits anything. */
export function screenSuggestions(reading: ScreenReading): ScreenSuggestion[] {
  const agent = screenAgent(reading.kind);
  const title = reading.items[0]?.title.slice(0, 60) ?? "";
  switch (reading.kind) {
    case "product":
      return [
        { agent, label: title ? `Compare prices for ${title}` : "Compare prices for this" },
        { agent: "main", label: "What should I check before buying this?" },
      ];
    case "event":
      return [
        { agent, label: "When and where is it, and what does it cost?" },
        { agent, label: "What should I know before going?" },
      ];
    case "menu":
      return [
        { agent, label: "Which dishes look like the best value?" },
        { agent, label: "What is vegetarian on this menu?" },
      ];
    case "form":
      return [
        { agent, label: "What does this form ask for?" },
        { agent, label: "Which fields still look empty?" },
      ];
    case "travel":
      return [
        { agent, label: "Summarise this trip for me" },
        { agent, label: "What should I check before I travel?" },
      ];
    case "app_screen":
    case "other":
      return [{ agent, label: "What am I looking at?" }];
    default: {
      const neverKind: never = reading.kind;
      return neverKind;
    }
  }
}

export function kindLabel(kind: ScreenKind): string {
  switch (kind) {
    case "product":
      return "Product";
    case "event":
      return "Event";
    case "menu":
      return "Menu";
    case "form":
      return "Form";
    case "travel":
      return "Travel";
    case "app_screen":
      return "App screen";
    case "other":
      return "Screen";
    default: {
      const neverKind: never = kind;
      return neverKind;
    }
  }
}

export function sourceLabel(source: ScreenSource): string {
  switch (source) {
    case "visible_text":
      return "on screen";
    case "visual_cue":
      return "from the picture";
    case "inferred":
      return "Scout's guess";
    default: {
      const neverSource: never = source;
      return neverSource;
    }
  }
}

function readItem(value: unknown): ScreenItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const title = cleanText(record.title, TEXT_LIMIT);
  if (!title) return null;
  const fields = Array.isArray(record.fields) ? record.fields.slice(0, FIELD_LIMIT).map(readField).filter((field): field is ScreenField => field != null) : [];
  return { kind: readKind(record.kind) ?? "other", title, confidence: readConfidence(record.confidence), fields };
}

function readField(value: unknown): ScreenField | null {
  const record = asRecord(value);
  if (!record) return null;
  const label = cleanText(record.label, 60);
  const text = cleanText(record.value, TEXT_LIMIT);
  if (!label || !text) return null;
  const source = typeof record.source === "string" && (SCREEN_SOURCES as readonly string[]).includes(record.source) ? (record.source as ScreenSource) : "inferred";
  return { label, value: text, source, confidence: readConfidence(record.confidence) };
}

function readKind(value: unknown): ScreenKind | null {
  return typeof value === "string" && (SCREEN_KINDS as readonly string[]).includes(value) ? (value as ScreenKind) : null;
}

function readConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

function cleanText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const text = maskSensitive(value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim());
  if (text.length === 0) return null;
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
