import type { DeskTurn } from "./deskBoard.ts";

/** One line of a single chat, in the order it was said. */
export type HistoryLine = { role: "user" | "assistant"; text: string };

/** The whole chat is sent. These caps keep one huge chat from crowding out the request. */
export const HISTORY_TURN_LIMIT = 80;
export const HISTORY_CHAR_LIMIT = 16_000;

/** The lines of this chat that the model should see. Thinking, bills, and payment links stay out. */
export function historyFromTurns(turns: readonly DeskTurn[]): HistoryLine[] {
  const lines: HistoryLine[] = [];
  for (const turn of turns) {
    const line = lineFrom(turn);
    if (line) lines.push(line);
  }
  return capHistory(lines);
}

/** Reads a history list from a chat request. Null means the field was absent. */
export function readHistory(value: unknown): HistoryLine[] | null | "bad" {
  if (value == null) return null;
  if (!Array.isArray(value)) return "bad";
  const lines: HistoryLine[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as { role?: unknown; text?: unknown };
    if ((row.role !== "user" && row.role !== "assistant") || typeof row.text !== "string") continue;
    const text = row.text.trim();
    if (text.length === 0) continue;
    lines.push({ role: row.role, text: text.slice(0, 2_000) });
  }
  return capHistory(lines);
}

/** Keeps the newest lines that fit the caps. */
export function capHistory(lines: readonly HistoryLine[]): HistoryLine[] {
  const kept: HistoryLine[] = [];
  let chars = 0;
  for (let index = lines.length - 1; index >= 0 && kept.length < HISTORY_TURN_LIMIT; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    if (chars + line.text.length > HISTORY_CHAR_LIMIT && kept.length > 0) break;
    kept.push(line);
    chars += line.text.length;
  }
  return kept.reverse();
}

function lineFrom(turn: DeskTurn): HistoryLine | null {
  switch (turn.kind) {
    case "user":
      return spoken("user", turn.text);
    case "text":
    case "note":
      return spoken("assistant", turn.text);
    case "phone":
      return spoken("assistant", turn.run.summary);
    case "form":
      return spoken("assistant", turn.form.tasks.join("; "));
    case "card":
      return spoken("assistant", turn.listing.title);
    case "places":
      return spoken("assistant", turn.places.map((place) => place.label).join("; "));
    case "thinking":
    case "cart":
    case "quote":
    case "estimate":
    case "buses":
    case "flights":
    case "receipt":
    case "pay":
    case "task":
    case "more":
      return null;
    default: {
      const neverTurn: never = turn;
      return neverTurn;
    }
  }
}

function spoken(role: HistoryLine["role"], text: string): HistoryLine | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return { role, text: trimmed.slice(0, 2_000) };
}
