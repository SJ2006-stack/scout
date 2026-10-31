import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgentId } from "../../shared/hosts.ts";
import { isAgentId } from "../../shared/hosts.ts";

export type BolnaConfig = { apiKey: string; agentId: string; llmKey: string };
export type VoiceTicket = { userId: string; agent: AgentId; expiresAt: number };
export type CompletionRequest = { stream: boolean; ticket: VoiceTicket | null; text: string; messages: { role: string; content: string }[] };

const BOLNA_API = "https://api.bolna.ai";
const TICKET_TTL_MS = 45 * 60_000;
const TICKET = /scout_ticket[^A-Za-z0-9_-]{0,6}([A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/;
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

export function bolnaFromEnv(env: NodeJS.ProcessEnv): BolnaConfig | null {
  const apiKey = env.BOLNA_API_KEY?.trim() ?? "";
  const llmKey = env.BOLNA_LLM_KEY?.trim() ?? "";
  if (!apiKey.startsWith("bn-") || llmKey.length < 32) return null;
  return { apiKey, agentId: env.BOLNA_AGENT_ID?.trim() ?? "", llmKey };
}

export function signVoiceTicket(ticket: Omit<VoiceTicket, "expiresAt">, key: string, now: number): string {
  const body = Buffer.from(JSON.stringify({ u: ticket.userId, a: ticket.agent, e: now + TICKET_TTL_MS })).toString("base64url");
  return `${body}.${mac(body, key)}`;
}

export function readVoiceTicket(token: string, key: string, now: number): VoiceTicket | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = Buffer.from(mac(body, key));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { u?: unknown; a?: unknown; e?: unknown };
    if (typeof parsed.u !== "string" || !isAgentId(parsed.a) || typeof parsed.e !== "number" || parsed.e < now) return null;
    return { userId: parsed.u, agent: parsed.a, expiresAt: parsed.e };
  } catch {
    return null;
  }
}

export function bearerMatches(header: string | undefined, key: string): boolean {
  const given = Buffer.from((header ?? "").replace(/^Bearer\s+/i, "").trim());
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function readCompletion(raw: unknown, key: string, now: number): CompletionRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as { messages?: unknown; stream?: unknown };
  if (!Array.isArray(body.messages)) return null;
  const messages = body.messages.flatMap((message): { role: string; content: string }[] => {
    if (!message || typeof message !== "object") return [];
    const row = message as { role?: unknown; content?: unknown };
    if (typeof row.role !== "string") return [];
    return [{ role: row.role, content: contentText(row.content) }];
  });
  let ticket: VoiceTicket | null = null;
  for (const message of messages) {
    if (message.role !== "system") continue;
    const found = message.content.match(TICKET)?.[1];
    if (found) ticket = readVoiceTicket(found, key, now);
    if (ticket) break;
  }
  const text = [...messages].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
  return { stream: body.stream === true, ticket, text, messages };
}

export async function mintWebCall(
  config: BolnaConfig,
  input: { ticket: string; name: string | null; language: "hi" | "en" | null },
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: unknown }> {
  if (config.agentId.length === 0) return { status: 503, body: { error: "Voice calls need BOLNA_AGENT_ID. Run npm run bolna:setup." } };
  try {
    const response = await fetchImpl(`${BOLNA_API}/web-call/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        agent_id: config.agentId,
        user_data: { scout_ticket: input.ticket, name: input.name ?? "there" },
        ...(input.language ? { agent_data: { language: input.language } } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: "Bolna returned an unreadable session." };
    }
    if (!response.ok) console.error(`Bolna web-call mint failed with ${response.status}.`);
    return { status: response.status, body };
  } catch {
    return { status: 502, body: { error: "Bolna could not be reached." } };
  }
}

export function spokenText(text: string): string {
  return text
    .replace(EMOJI, "")
    .replace(/\*\*?|__|`/g, "")
    .replace(/https?:\/\/\S+/g, "the link on screen")
    .replace(/₹\s?(\d)/g, "rupees $1")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function completionChunk(id: string, created: number, content: string | null, finish: "stop" | null): string {
  const delta = content == null ? {} : { role: "assistant", content };
  return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "scout", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

export function completionBody(id: string, created: number, content: string): unknown {
  return {
    id,
    object: "chat.completion",
    created,
    model: "scout",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function mac(body: string, key: string): string {
  return createHmac("sha256", `voice-ticket:${key}`).update(body).digest("base64url");
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join(" ");
}
