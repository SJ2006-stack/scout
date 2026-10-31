import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatEvent } from "../../shared/chatEvents.ts";
import type { Listing } from "../../shared/event.ts";
import { isAgentId, type AgentId } from "../../shared/hosts.ts";
import { runChat, type ChatTurn } from "../chatRun.ts";
import { postHaiku } from "../haikuClient.ts";
import type { ProfileStore } from "../profile/profileStore.ts";
import {
  bearerMatches,
  completionBody,
  completionChunk,
  mintWebCall,
  readCompletion,
  signVoiceTicket,
  speakable,
  spokenListings,
  spokenText,
  type BolnaConfig,
} from "./bolna.ts";
import type { LiveRelay } from "./liveRelay.ts";
import { VoiceRouter } from "./voiceRouter.ts";

export type BolnaRouteDeps = {
  bolna?: BolnaConfig | null;
  liveRelay?: LiveRelay;
  profile?: ProfileStore;
  anthropicApiKey?: string;
  fetchImpl?: typeof fetch;
  now: () => number;
};

export type TurnBuilder = (userId: string, agent: AgentId, text: string, signal: AbortSignal) => ChatTurn;

const LLM_PREFIX = "/api/bolna/v1";
const BODY_LIMIT = 200_000;
const KEEPALIVE_MS = 10_000;
const router = new VoiceRouter();

export function isBolnaLlmRoute(pathname: string): boolean {
  return pathname === `${LLM_PREFIX}/chat/completions` || pathname === `${LLM_PREFIX}/models`;
}

export async function routeBolnaLlm(request: IncomingMessage, response: ServerResponse, url: URL, deps: BolnaRouteDeps, buildTurn: TurnBuilder): Promise<void> {
  const config = deps.bolna;
  if (!config) return send(response, 503, { error: { message: "Bolna is not configured." } });
  if (!bearerMatches(request.headers.authorization, config.llmKey)) return send(response, 401, { error: { message: "Access denied." } });
  if (request.method === "GET" && url.pathname === `${LLM_PREFIX}/models`) {
    const label = (request.headers["x-forwarded-host"] ?? request.headers.host ?? "").toString().split(/[.:,]/)[0]?.toLowerCase() ?? "";
    const ids = ["scout", ...(/^[a-z0-9-]+$/.test(label) ? [`scout-${label}`] : [])];
    return send(response, 200, { object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "scout" })) });
  }
  if (request.method !== "POST") return send(response, 405, { error: { message: "POST only." } });
  const raw = await readBody(request);
  const parsed = readCompletion(raw, config.llmKey, deps.now());
  if (!parsed) return send(response, 400, { error: { message: "Send OpenAI chat messages." } });
  const id = `chatcmpl-${randomBytes(10).toString("hex")}`;
  const created = Math.floor(deps.now() / 1000);
  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });

  if (!parsed.ticket) {
    const reply = await passthrough(parsed.messages, deps, controller.signal);
    return reply == null ? send(response, 502, { error: { message: "Scout could not answer." } }) : writeCompletion(response, parsed.stream, id, created, [reply]);
  }

  const { userId } = parsed.ticket;
  const agent = router.pick(userId, parsed.text, parsed.ticket.agent, deps.now());
  const relay = deps.liveRelay;
  if (parsed.text.length === 0) return writeCompletion(response, parsed.stream, id, created, ["Haan, boliye?"]);
  relay?.publish(userId, { type: "voice-user", text: parsed.text });

  if (parsed.stream) {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
    response.write(completionChunk(id, created, "", null));
  }
  const pieces: string[] = [];
  let spokeFiller = false;
  let streamed = false;
  let heard = 0;
  const keepalive = parsed.stream ? setInterval(() => response.write(": keepalive\n\n"), KEEPALIVE_MS) : null;
  let pendingAction: string | null = null;
  let unspokenCards: Listing[] = [];
  const write = (text: string) => {
    pendingAction = null;
    unspokenCards = [];
    pieces.push(text);
    if (parsed.stream && !response.writableEnded) response.write(completionChunk(id, created, text, null));
  };
  const say = (text: string) => {
    const spoken = spokenText(text);
    if (spoken.length > 0) write(`${spoken} `);
  };
  const onSpeech = (soFar: string) => {
    if (soFar.length < heard) heard = 0;
    if (soFar.length === 0) {
      if (streamed) write(" ");
      return;
    }
    const fresh = speakable(soFar.slice(heard));
    heard = soFar.length;
    if (fresh.trim().length === 0) return;
    streamed = true;
    write(fresh);
  };
  const emit = (event: ChatEvent) => {
    relay?.publish(userId, event);
    if (event.type === "device") pendingAction = event.action.confirm ? `Phone pe approval ke liye bheja hai: ${event.action.summary}.` : `Aapke phone pe bhej diya: ${event.action.summary}.`;
    if (event.type === "card") unspokenCards = [...unspokenCards, event.listing];
    if (event.type === "watch") pendingAction = "Watch laga diya. Naye shows milte hi phone pe bataunga.";
    if (event.type === "status" && !spokeFiller && pieces.length === 0) {
      spokeFiller = true;
      say(event.message);
      return;
    }
    if (event.type === "question" && !streamed && event.message.trim().length > 0) say(event.message);
  };
  try {
    await runChat({ ...buildTurn(userId, agent, parsed.text, controller.signal), onSpeech }, emit);
  } catch (error) {
    console.error(error);
    say("Sorry, kuch gadbad ho gayi. Ek baar phir boliye.");
  } finally {
    if (keepalive) clearInterval(keepalive);
    relay?.publish(userId, { type: "voice-turn-done" });
  }
  const cardsLeft = unspokenCards as Listing[];
  if (cardsLeft.length > 0) say(` ${spokenListings(cardsLeft)}`);
  if (pendingAction) say(` ${pendingAction}`);
  if (pieces.length === 0) say("Main ne check kiya, par kuch nahi mila.");
  if (parsed.stream) {
    if (!response.writableEnded) {
      response.write(completionChunk(id, created, null, "stop"));
      response.end("data: [DONE]\n\n");
    }
    return;
  }
  send(response, 200, completionBody(id, created, pieces.join(" ")));
}

export async function routeBolnaSession(request: IncomingMessage, response: ServerResponse, userId: string, deps: BolnaRouteDeps): Promise<void> {
  const config = deps.bolna;
  if (!config) return send(response, 503, { error: "Voice calls stay off until BOLNA_API_KEY and BOLNA_LLM_KEY are set." });
  const raw = (await readBody(request)) as { agent?: unknown; language?: unknown; user_data?: { agent?: unknown; language?: unknown } } | null;
  const agentValue = raw?.agent ?? raw?.user_data?.agent;
  const languageValue = raw?.language ?? raw?.user_data?.language;
  const agent: AgentId = isAgentId(agentValue) ? agentValue : "main";
  const language = languageValue === "hi" || languageValue === "en" ? languageValue : null;
  const ticket = signVoiceTicket({ userId, agent }, config.llmKey, deps.now());
  const name = deps.profile?.get(userId, "name")?.value ?? null;
  const minted = await mintWebCall(config, { ticket, name, language }, deps.fetchImpl ?? fetch);
  send(response, minted.status, minted.body);
}

export async function routeVoiceLive(request: IncomingMessage, response: ServerResponse, userId: string, deps: BolnaRouteDeps): Promise<void> {
  const relay = deps.liveRelay;
  if (!relay) return send(response, 503, { error: "Live voice is not enabled." });
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
  response.write(": live\n\n");
  const unsubscribe = relay.subscribe(userId, (event) => response.write(`data: ${JSON.stringify(event)}\n\n`));
  const ping = setInterval(() => response.write(": ping\n\n"), 20_000);
  request.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
}

async function passthrough(messages: { role: string; content: string }[], deps: BolnaRouteDeps, signal: AbortSignal): Promise<string | null> {
  const apiKey = deps.anthropicApiKey ?? "";
  if (apiKey.length === 0) return null;
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  const turns = messages
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.content.trim().length > 0)
    .map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));
  if (turns[0]?.role === "assistant") turns.shift();
  if (turns.length === 0) return null;
  const body = await postHaiku({ apiKey, fetchImpl: deps.fetchImpl ?? fetch, signal, system, tools: [], messages: turns });
  if (!body || !Array.isArray(body.content)) return null;
  const text = body.content
    .map((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
    .join(" ")
    .trim();
  return text.length > 0 ? text : null;
}

function writeCompletion(response: ServerResponse, stream: boolean, id: string, created: number, pieces: string[]): void {
  const text = pieces.map(spokenText).join(" ").trim();
  if (!stream) return send(response, 200, completionBody(id, created, text));
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
  response.write(completionChunk(id, created, text, null));
  response.write(completionChunk(id, created, null, "stop"));
  response.end("data: [DONE]\n\n");
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) return null;
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    if (!response.writableEnded) response.end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
