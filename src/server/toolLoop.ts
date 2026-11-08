import type { ChatEvent } from "../shared/chatEvents.ts";
import type { AgentId } from "../shared/hosts.ts";
import type { ChatLine } from "./chatMemory.ts";
import { askUser } from "./questionBack.ts";
import type { ChatMessage } from "./sarvamChat.ts";

type Block = Record<string, unknown>;

/** Said when a scout asked with a form and wrote nothing itself. */
export const ASK_LINE = "A few details first. Fill in the card and I'll carry on.";
const ASK_REPLY_LIMIT = 240;

/** The chat so far as model messages, with this message last. */
export function transcript(lines: readonly ChatLine[], text: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const line of lines) {
    const last = messages.at(-1);
    if (last && last.role === line.role && typeof last.content === "string") {
      last.content = `${last.content}\n${line.text}`;
      continue;
    }
    messages.push({ role: line.role, content: line.text });
  }
  if (messages[0]?.role === "assistant") messages.shift();
  const last = messages.at(-1);
  if (last?.role === "user" && typeof last.content === "string") last.content = `${last.content}\n${text}`;
  else messages.push({ role: "user", content: text });
  return messages;
}

export function contentBlocks(content: unknown): Block[] {
  return Array.isArray(content) ? content.filter(isBlock) : [];
}

export function blockText(blocks: readonly Block[]): string {
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text).trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** True when a form went to the screen this round; the turn ends there and their answers start the next one. */
export function askedUser(calls: readonly { name: unknown }[], results: readonly { ok: boolean }[]): boolean {
  return calls.some((call, index) => call.name === "ask_user" && results[index]?.ok === true);
}

const PICK_LINE = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.{1,48}?)\s*$/;
const PICK_LIMIT = 6;

/**
 * A reply that still asks in prose with a short bulleted list of picks ("which stylist? - Noor - Asha")
 * becomes a one-question form, so every scout's choices are tappable. Null for anything else.
 */
export function picksFromProse(reply: string): { prompt: string; options: string[]; rest: string } | null {
  return bulletPicks(reply) ?? inlinePicks(reply);
}

const WORD = String.raw`[\p{L}\d][\p{L}\d:'&.₹-]*`;
const ITEM = String.raw`${WORD}(?:\s+${WORD}){0,2}`;
const INLINE_PICKS = new RegExp(String.raw`(?:[—:]|\b(?:have|between|either|want|prefer|choose|pick|like|is it|try))\s+((?:${ITEM},\s+)*${ITEM},?\s+or\s+${ITEM})\s*[?.!]`, "iu");

/** "Which slot works — afternoon or evening?" or "We have Masala Dosa, Idli, or Chef Thali." in a reply that asks something. */
function inlinePicks(reply: string): { prompt: string; options: string[]; rest: string } | null {
  const text = reply.trim();
  const questions = text.match(/[^.!?\n]*\?/g);
  const asked = questions?.at(-1)?.trim();
  if (!asked) return null;
  const list = INLINE_PICKS.exec(text)?.[1];
  if (!list) return null;
  const options = [...new Set(list.split(/,\s*(?:or\s+)?|\s+or\s+/i).map((option) => option.trim().replace(/[.,]$/, "")).filter((option) => option.length > 0))];
  if (options.length < 2 || options.length > PICK_LIMIT) return null;
  return { prompt: asked.replace(/^[\p{Extended_Pictographic}\uFE0F\s—-]+/u, "").slice(0, 200), options, rest: text };
}

function bulletPicks(reply: string): { prompt: string; options: string[]; rest: string } | null {
  const lines = reply.trim().split("\n");
  const picks: { index: number; text: string }[] = [];
  lines.forEach((line, index) => {
    const match = PICK_LINE.exec(line);
    if (match?.[1]) picks.push({ index, text: match[1].replace(/\*\*/g, "").trim() });
  });
  if (picks.length < 2 || picks.length > PICK_LIMIT) return null;
  const first = picks[0]?.index ?? 0;
  const last = picks.at(-1)?.index ?? 0;
  if (last - first + 1 !== picks.length) return null;
  const before = lines.slice(0, first).join("\n").trim();
  const asked = /([^.!?\n]*\?)\s*$/.exec(before)?.[1]?.trim();
  if (!asked) return null;
  const options = [...new Set(picks.map((pick) => pick.text.replace(/[.:]$/, "")))];
  if (options.some((option) => option.length === 0 || option.split(/\s+/).length > 6)) return null;
  const rest = [...lines.slice(0, first), ...lines.slice(last + 1)].join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { prompt: asked.replace(/^[\p{Extended_Pictographic}\uFE0F\s—-]+/u, "").slice(0, 200), options, rest };
}

/** Shows a prose list of picks as a form and returns the reply without the list. Other replies come back unchanged. */
export function askPicks(userId: string, agent: AgentId, reply: string, emit: (event: ChatEvent) => void): string {
  const picks = picksFromProse(reply);
  if (!picks) return reply;
  const asked = askUser(userId, agent, { why: "", questions: [{ prompt: picks.prompt, options: picks.options }] }, emit);
  if (!asked.ok) return reply;
  return picks.rest.length > 0 ? picks.rest : picks.prompt;
}

/** The model's own line when it is short, else the standard one; the questions are already on the card. */
export function askReply(text: string): string {
  const line = text.trim();
  return line.length > 0 && line.length <= ASK_REPLY_LIMIT ? line : ASK_LINE;
}

function isBlock(value: unknown): value is Block {
  return Boolean(value) && typeof value === "object";
}
