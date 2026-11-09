import { randomBytes } from "node:crypto";
import type { ChatEvent } from "../shared/chatEvents.ts";
import type { ErrandForm, ErrandQuestion } from "../shared/errands.ts";
import type { AgentId } from "../shared/hosts.ts";
import type { ShopOffer } from "./browser/shelf.ts";
import type { ErrandPlan } from "./errands.ts";

const FORM_TTL_MS = 30 * 60 * 1000;
const FORMS_PER_USER = 4;
const USER_LIMIT = 500;
const ASK_LIMIT = 4;
const OPTION_LIMIT = 4;

/** A question form on screen, waiting for answers: Main Scout's errand plan, or any scout's ask_user. */
export type PendingForm =
  | { kind: "errands"; plan: ErrandPlan }
  | { kind: "ask"; agent: AgentId; questions: ErrandQuestion[] }
  | { kind: "shelf"; offer: ShopOffer; query: string; choices?: readonly { label: string; offer: ShopOffer }[] };

export class PendingForms {
  private readonly users = new Map<string, Map<string, { at: number; form: PendingForm }>>();
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  save(userId: string, formId: string, form: PendingForm): void {
    const forms = this.users.get(userId) ?? new Map<string, { at: number; form: PendingForm }>();
    this.users.delete(userId);
    forms.set(formId, { at: this.now(), form });
    while (forms.size > FORMS_PER_USER) {
      const oldest = forms.keys().next().value;
      if (oldest === undefined) break;
      forms.delete(oldest);
    }
    this.users.set(userId, forms);
    while (this.users.size > USER_LIMIT) {
      const oldest = this.users.keys().next().value;
      if (oldest === undefined) break;
      this.users.delete(oldest);
    }
  }

  /** Each form is answered once. */
  take(userId: string, formId: string): PendingForm | null {
    const saved = this.users.get(userId)?.get(formId);
    if (!saved) return null;
    this.users.get(userId)?.delete(formId);
    return this.now() - saved.at > FORM_TTL_MS ? null : saved.form;
  }
}

export const pendingForms = new PendingForms(Date.now);

export const ASK_TOOL = {
  name: "ask_user",
  description: `Ask them for details only they can give before you act, as a form on their screen. Put every question in one call, at most ${ASK_LIMIT}. Give 2 to ${OPTION_LIMIT} short options when there are common answers (sizes, brands, days, times); leave options empty for free text. Set photo true when the answer is likely a photo or document, such as a menu or a bill. After this call, stop: their answers come back as their next message.`,
  input_schema: {
    type: "object",
    properties: {
      why: { type: "string", description: "One short line on what you will do once they answer." },
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            options: { type: "array", items: { type: "string" } },
            photo: { type: "boolean" },
          },
          required: ["prompt"],
        },
      },
    },
    required: ["why", "questions"],
  },
} as const;

export const ASK_PROMPT = "If you need a detail only they can give before you can do the task well (which variant, size, how many, which day or time, who, from where), or a tool result asks them to pick one of several (a stylist, a showtime, a store), call ask_user once with every question, the picks as options, instead of guessing or asking in prose. Do not ask what their message, this chat, or their saved preferences already say. Do not ask when you can already act. After ask_user, end the turn with one short line.";

/** Shows the form and keeps its questions until they answer. */
export function askUser(userId: string, agent: AgentId, input: unknown, emit: (event: ChatEvent) => void): { ok: boolean; content: string } {
  const record = input && typeof input === "object" ? (input as { why?: unknown; questions?: unknown }) : {};
  const questions = readAsked(record.questions);
  if (questions.length === 0) return { ok: false, content: "Pass at least one question with a prompt." };
  const why = typeof record.why === "string" && record.why.trim().length > 0 ? record.why.trim().slice(0, 160) : "A few details first.";
  const form: ErrandForm = { id: randomBytes(12).toString("hex"), tasks: [why], questions };
  pendingForms.save(userId, form.id, { kind: "ask", agent, questions });
  emit({ type: "form", form });
  return { ok: true, content: "The form is on their screen. Do not answer the task yet. End this turn with one short line saying what you need; their answers come back as the next message." };
}

/** Yes or No for the only listing a shop search returned. */
export function askShelf(userId: string, offer: ShopOffer, query: string, emit: (event: ChatEvent) => void): void {
  const form: ErrandForm = {
    id: randomBytes(12).toString("hex"),
    tasks: [`${offer.merchant}: ${offer.title}, ₹${offer.rupees}`],
    questions: [{ id: "match", prompt: "Is that what you're looking for?", kind: "choice", options: ["Yes", "No"] }],
  };
  pendingForms.save(userId, form.id, { kind: "shelf", offer, query });
  emit({ type: "form", form });
}

/** A pick of the packs the stores listed, when the asked product was not an exact match. */
export function askShelfChoices(userId: string, offers: readonly ShopOffer[], query: string, emit: (event: ChatEvent) => void): void {
  const choices = shelfOptionLabels(offers);
  const first = choices[0];
  if (!first) return;
  const form: ErrandForm = {
    id: randomBytes(12).toString("hex"),
    tasks: choices.map((choice) => choice.label),
    questions: [{ id: "match", prompt: "Which pack?", kind: "choice", options: choices.map((choice) => choice.label) }],
  };
  pendingForms.save(userId, form.id, { kind: "shelf", offer: first.offer, query, choices });
  emit({ type: "form", form });
}

export function shelfOptionLabels(offers: readonly ShopOffer[]): { label: string; offer: ShopOffer }[] {
  const used = new Set<string>();
  return offers.slice(0, 4).map((offer) => {
    const plain = `${offer.title} ₹${offer.rupees}`.replace(/\s+/g, " ").trim();
    const withStore = `${offer.merchant}: ${plain}`;
    const label = (used.has(plain) ? withStore : plain).slice(0, 60);
    used.add(plain);
    return { label, offer };
  });
}

/** Their answers as one message to the scout that asked, so the chat carries the questions too. */
export function answersMessage(questions: readonly ErrandQuestion[], values: Readonly<Record<string, string>>): string {
  const lines = questions.map((question) => `- ${question.prompt} ${values[question.id]?.trim() || "(left blank: decide yourself or skip it)"}`);
  return `My answers to your questions:\n${lines.join("\n")}\nCarry on with the task now.`;
}

function readAsked(raw: unknown): ErrandQuestion[] {
  if (!Array.isArray(raw)) return [];
  const questions: ErrandQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as { prompt?: unknown; options?: unknown; photo?: unknown };
    const prompt = typeof row.prompt === "string" ? row.prompt.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    if (prompt.length < 3 || questions.some((question) => question.prompt === prompt)) continue;
    const options = Array.isArray(row.options)
      ? [...new Set(row.options.filter((option): option is string => typeof option === "string").map((option) => option.trim().slice(0, 60)).filter((option) => option.length > 0))].slice(0, OPTION_LIMIT)
      : [];
    const kind = row.photo === true ? "photo" : options.length >= 2 ? "choice" : "text";
    questions.push({ id: `q${questions.length}`, prompt, kind, options: kind === "choice" ? options : [] });
    if (questions.length === ASK_LIMIT) break;
  }
  return questions;
}
