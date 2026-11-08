export type ErrandAnswerKind = "choice" | "text" | "photo";

/** One detail Main Scout needs before it hands an errand to another scout. */
export type ErrandQuestion = { id: string; prompt: string; kind: ErrandAnswerKind; options: string[] };

/** Every question for one message, asked together before anything runs. */
export type ErrandForm = { id: string; tasks: string[]; questions: ErrandQuestion[] };

export type ErrandAnswers = { formId: string; values: Record<string, string> };

export type BusOption = {
  operator: string;
  busType: string;
  departs: string;
  arrives: string;
  duration: string;
  seats: number | null;
  rupees: number;
  rating: number | null;
};

/** Buses read from redBus for one route and day. Scout lists them; they book on redBus. */
export type BusResult = { from: string; to: string; date: string; window: string; url: string; total: number | null; options: BusOption[] };

const FORM_LIMIT = 8;
const OPTION_LIMIT = 6;
const TEXT_LIMIT = 4_000;

export function readErrandForm(raw: unknown): ErrandForm | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { id?: unknown; tasks?: unknown; questions?: unknown };
  if (typeof row.id !== "string" || !/^[a-f0-9]{16,32}$/.test(row.id) || !Array.isArray(row.tasks) || !Array.isArray(row.questions)) return null;
  const tasks = row.tasks.filter((task): task is string => typeof task === "string").map((task) => task.slice(0, 160)).slice(0, FORM_LIMIT);
  const questions: ErrandQuestion[] = [];
  for (const item of row.questions.slice(0, FORM_LIMIT)) {
    if (!item || typeof item !== "object") return null;
    const question = item as { id?: unknown; prompt?: unknown; kind?: unknown; options?: unknown };
    if (typeof question.id !== "string" || typeof question.prompt !== "string" || !isAnswerKind(question.kind) || !Array.isArray(question.options)) return null;
    const options = question.options.filter((option): option is string => typeof option === "string").map((option) => option.slice(0, 60)).slice(0, OPTION_LIMIT);
    questions.push({ id: question.id.slice(0, 40), prompt: question.prompt.slice(0, 200), kind: question.kind, options });
  }
  return { id: row.id, tasks, questions };
}

export function readErrandAnswers(raw: unknown): ErrandAnswers | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { formId?: unknown; values?: unknown };
  if (typeof row.formId !== "string" || !/^[a-f0-9]{16,32}$/.test(row.formId) || !row.values || typeof row.values !== "object") return null;
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(row.values as Record<string, unknown>).slice(0, FORM_LIMIT)) {
    if (typeof value === "string" && value.trim().length > 0) values[key.slice(0, 40)] = value.trim().slice(0, TEXT_LIMIT);
  }
  return { formId: row.formId, values };
}

export function readBusResult(raw: unknown): BusResult | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<BusResult>;
  if (typeof row.from !== "string" || typeof row.to !== "string" || typeof row.date !== "string" || typeof row.window !== "string" || typeof row.url !== "string" || !Array.isArray(row.options)) return null;
  if (!row.url.startsWith("https://www.redbus.in/")) return null;
  const options = row.options.filter(isBusOption).slice(0, 10);
  return { from: row.from, to: row.to, date: row.date, window: row.window, url: row.url, total: typeof row.total === "number" ? row.total : null, options };
}

function isBusOption(value: unknown): value is BusOption {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<BusOption>;
  return typeof row.operator === "string" && typeof row.busType === "string" && typeof row.departs === "string" && typeof row.arrives === "string"
    && typeof row.duration === "string" && typeof row.rupees === "number" && (row.seats == null || typeof row.seats === "number") && (row.rating == null || typeof row.rating === "number");
}

function isAnswerKind(value: unknown): value is ErrandAnswerKind {
  return value === "choice" || value === "text" || value === "photo";
}
