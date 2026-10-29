const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

export const HAIKU_MODEL = "claude-haiku-5-5";
const MODEL_TIMEOUT_MS = 20_000;

export type HaikuMessage = { role: "user" | "assistant"; content: string | Record<string, unknown>[] };

export async function postHaiku(options: {
  apiKey: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  system: string;
  tools: readonly Record<string, unknown>[];
  messages: HaikuMessage[];
}): Promise<{ stop_reason?: string; content?: unknown } | null> {
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
  try {
    const response = await options.fetchImpl(MESSAGES_URL, {
      method: "POST",
      headers: {
        "x-api-key": options.apiKey.trim(),
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as { stop_reason?: string; content?: unknown };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
