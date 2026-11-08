const CHAT_URL = "https://api.sarvam.ai/v1/chat/completions";

/** Flagship Sarvam chat model. The installed SDK uses it for tool calls on this route. */
export const SARVAM_CHAT_MODEL = "sarvam-105b";
export const SARVAM_CHAT_URL = CHAT_URL;
const MODEL_TIMEOUT_MS = 20_000;

export type ChatMessage = { role: "user" | "assistant"; content: string | Record<string, unknown>[] };
export type ChatBody = { stop_reason?: string; content?: unknown };

export async function postSarvam(options: {
  apiKey: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  system: string;
  tools: readonly Record<string, unknown>[];
  messages: ChatMessage[];
  onText?: (text: string) => void;
  maxTokens?: number;
  timeoutMs?: number;
  /** Must call a tool, without reasoning first. A named tool choice makes Sarvam reason past the token limit. */
  mustCallTool?: boolean;
}): Promise<ChatBody | null> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? MODEL_TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, timeout.signal]);
  const body: Record<string, unknown> = {
    model: SARVAM_CHAT_MODEL,
    max_tokens: options.maxTokens ?? 2048,
    ...(options.mustCallTool ? { tool_choice: "required", reasoning_effort: null } : { reasoning_effort: "low" }),
    messages: toMessages(options.system, options.messages),
  };
  if (options.tools.length > 0) body.tools = options.tools.map(toFunctionTool);
  if (options.onText) body.stream = true;
  try {
    const response = await options.fetchImpl(CHAT_URL, {
      method: "POST",
      headers: {
        "api-subscription-key": options.apiKey.trim(),
        "content-type": "application/json",
        accept: options.onText ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) return null;
    return await readSarvam(response, options.onText);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readSarvam(response: Response, onText?: (text: string) => void): Promise<ChatBody | null> {
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) return readSarvamStream(response, onText);
  const payload = await response.json().catch(() => null);
  const body = fromCompletion(payload);
  if (!body) return null;
  if (onText && !contentHasTool(body.content)) {
    const text = textFromContent(body.content);
    if (text.length > 0) onText(text);
  }
  return body;
}

async function readSarvamStream(response: Response, onText?: (text: string) => void): Promise<ChatBody | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let buffer = "";
  let finish = "";
  let refusal = "";
  let spoken = "";
  let forwarded = false;
  let toolSeen = false;
  let text = "";
  const tools = new Map<number, { id: string; name: string; arguments: string }>();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (raw.length === 0 || raw === "[DONE]") continue;
      const event = parseEvent(raw);
      const choice = event ? firstChoice(event) : null;
      if (!choice) continue;
      if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) finish = choice.finish_reason;
      const delta = record(choice.delta);
      if (!delta) continue;
      if (typeof delta.refusal === "string" && delta.refusal.length > 0) refusal = delta.refusal;
      if (typeof delta.content === "string" && delta.content.length > 0) {
        text += delta.content;
        if (!toolSeen) {
          spoken += delta.content;
          forwarded = true;
          onText?.(spoken);
        }
      }
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const call of calls) {
        const row = record(call);
        if (!row) continue;
        toolSeen = true;
        const index = typeof row.index === "number" ? row.index : tools.size;
        const current = tools.get(index) ?? { id: "", name: "", arguments: "" };
        if (typeof row.id === "string" && row.id.length > 0) current.id = row.id;
        const fn = record(row.function);
        if (typeof fn?.name === "string" && fn.name.length > 0) current.name = fn.name;
        if (typeof fn?.arguments === "string") current.arguments += fn.arguments;
        tools.set(index, current);
        if (forwarded) {
          forwarded = false;
          onText?.("");
        }
      }
    }
  }
  const content = blocksFrom(finish === "length" ? wholeSentences(text) : text, tools);
  return { stop_reason: stopReason(finish, refusal, contentHasTool(content)), content };
}

function toMessages(system: string, messages: ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (system.length > 0) out.push({ role: "system", content: system });
  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      out.push(assistantWire(message.content));
      continue;
    }
    const results = message.content.filter(isToolResult);
    if (results.length === message.content.length && results.length > 0) {
      for (const result of results) {
        out.push({
          role: "tool",
          tool_call_id: result.tool_use_id,
          content: typeof result.content === "string" ? result.content : JSON.stringify(result.content ?? ""),
        });
      }
      continue;
    }
    out.push({ role: "user", content: JSON.stringify(message.content) });
  }
  return out;
}

function assistantWire(blocks: Record<string, unknown>[]): Record<string, unknown> {
  const text = blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("\n");
  const calls = blocks.filter(isToolUse).map((block) => ({
    id: block.id,
    type: "function",
    function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
  }));
  return {
    role: "assistant",
    content: text.length > 0 ? text : null,
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
  };
}

function toFunctionTool(tool: Record<string, unknown>): Record<string, unknown> {
  const parameters = tool.input_schema && typeof tool.input_schema === "object" ? tool.input_schema : undefined;
  return {
    type: "function",
    function: {
      name: typeof tool.name === "string" ? tool.name : "",
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(parameters ? { parameters } : {}),
    },
  };
}

function fromCompletion(payload: unknown): ChatBody | null {
  const root = record(payload);
  if (!root) return null;
  const choice = firstChoice(root);
  const message = record(choice?.message);
  const finish = choice?.finish_reason;
  const refusal = typeof message?.refusal === "string" ? message.refusal : "";
  const text = typeof message?.content === "string" ? message.content : "";
  const tools = new Map<number, { id: string; name: string; arguments: string }>();
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  calls.forEach((call, index) => {
    const row = record(call);
    const fn = record(row?.function);
    if (!row || !fn) return;
    tools.set(index, {
      id: typeof row.id === "string" ? row.id : "",
      name: typeof fn.name === "string" ? fn.name : "",
      arguments: typeof fn.arguments === "string" ? fn.arguments : "",
    });
  });
  const content = blocksFrom(finish === "length" ? wholeSentences(text) : text, tools);
  return { stop_reason: stopReason(finish, refusal, contentHasTool(content)), content };
}

/** A reply cut by the token limit ends mid-sentence ("Luma has"). Keep only what was finished. */
export function wholeSentences(text: string): string {
  const trimmed = text.trimEnd();
  if (/[.!?)\]"'”’]$/.test(trimmed)) return trimmed;
  const end = Math.max(...[".", "!", "?", "\n"].map((mark) => trimmed.lastIndexOf(mark)));
  return end > 0 ? trimmed.slice(0, end + 1).trimEnd() : trimmed;
}

function blocksFrom(text: string, tools: ReadonlyMap<number, { id: string; name: string; arguments: string }>): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [];
  if (text.trim().length > 0) content.push({ type: "text", text });
  for (const index of [...tools.keys()].sort((left, right) => left - right)) {
    const call = tools.get(index);
    if (!call || call.id.length === 0 || call.name.length === 0) continue;
    content.push({ type: "tool_use", id: call.id, name: call.name, input: parseInput(call.arguments) });
  }
  return content;
}

function stopReason(finish: unknown, refusal: string, hasTool: boolean): string {
  if (hasTool) return "tool_use";
  if (refusal.length > 0 || finish === "content_filter") return "refusal";
  return "end_turn";
}

function firstChoice(value: Record<string, unknown>): Record<string, unknown> | null {
  const choices = value.choices;
  if (!Array.isArray(choices)) return null;
  return record(choices[0]);
}

function isToolResult(block: Record<string, unknown>): block is Record<string, unknown> & { tool_use_id: string; content: unknown } {
  return block.type === "tool_result" && typeof block.tool_use_id === "string";
}

function isToolUse(block: Record<string, unknown>): block is Record<string, unknown> & { id: string; name: string; input: unknown } {
  return block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string";
}

function parseEvent(raw: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function parseInput(raw: string): unknown {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function contentHasTool(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => record(block)?.type === "tool_use");
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const row = record(block);
      return row?.type === "text" && typeof row.text === "string" ? row.text.trim() : "";
    })
    .filter((line) => line.length > 0)
    .join("\n");
}
