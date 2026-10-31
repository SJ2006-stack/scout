const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

export const HAIKU_MODEL = "claude-haiku-5-5";
const MODEL_TIMEOUT_MS = 20_000;

export type HaikuMessage = { role: "user" | "assistant"; content: string | Record<string, unknown>[] };
export type HaikuBody = { stop_reason?: string; content?: unknown };

export async function postHaiku(options: {
  apiKey: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  system: string;
  tools: readonly Record<string, unknown>[];
  messages: HaikuMessage[];
  onText?: (text: string) => void;
}): Promise<HaikuBody | null> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), MODEL_TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, timeout.signal]);
  const body: Record<string, unknown> = {
    model: HAIKU_MODEL,
    max_tokens: 1024,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    system: options.system,
    messages: options.messages,
  };
  if (options.tools.length > 0) body.tools = options.tools;
  if (options.onText) body.stream = true;
  try {
    const response = await options.fetchImpl(MESSAGES_URL, {
      method: "POST",
      headers: {
        "x-api-key": options.apiKey.trim(),
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        accept: options.onText ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) return null;
    return await readHaiku(response, options.onText);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readHaiku(response: Response, onText?: (text: string) => void): Promise<HaikuBody | null> {
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) return readHaikuStream(response, onText);
  const payload = (await response.json()) as HaikuBody;
  if (onText && !contentHasTool(payload.content)) {
    const text = textFromContent(payload.content);
    if (text.length > 0) onText(text);
  }
  return payload;
}

async function readHaikuStream(response: Response, onText?: (text: string) => void): Promise<HaikuBody | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let buffer = "";
  let stop = "end_turn";
  let spoken = "";
  let forwarded = false;
  let toolSeen = false;
  const blocks: Array<{ type: string; text: string; id?: string; name?: string; inputJson: string }> = [];
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (raw.length === 0 || raw === "[DONE]") continue;
      const event = parseEvent(raw);
      if (!event) continue;
      const kind = event.type;
      if (kind === "content_block_start") {
        const block = record(event.content_block);
        const blockType = block?.type === "tool_use" ? "tool_use" : "text";
        if (blockType === "tool_use") toolSeen = true;
        blocks.push({
          type: blockType,
          text: typeof block?.text === "string" ? block.text : "",
          id: typeof block?.id === "string" ? block.id : undefined,
          name: typeof block?.name === "string" ? block.name : undefined,
          inputJson: "",
        });
        if (toolSeen && forwarded) {
          forwarded = false;
          onText?.("");
        }
      } else if (kind === "content_block_delta") {
        const index = typeof event.index === "number" ? event.index : blocks.length - 1;
        const delta = record(event.delta);
        const current = blocks[index];
        if (!delta || !current) continue;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          current.text += delta.text;
          if (!toolSeen) {
            spoken += delta.text;
            forwarded = true;
            onText?.(spoken);
          }
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          current.inputJson += delta.partial_json;
          toolSeen = true;
          if (forwarded) {
            forwarded = false;
            onText?.("");
          }
        }
      } else if (kind === "message_delta") {
        const delta = record(event.delta);
        if (typeof delta?.stop_reason === "string") stop = delta.stop_reason;
      }
    }
  }
  return {
    stop_reason: stop,
    content: blocks.map((block) => ({
      type: block.type,
      text: block.text,
      id: block.id,
      name: block.name,
      input: parseInput(block.inputJson),
    })),
  };
}

function parseEvent(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
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
