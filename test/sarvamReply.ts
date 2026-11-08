type ModelTurn = { stop_reason: string; content: unknown[] };

/** Turns the conversation loop's block shape into a Sarvam chat-completion JSON body. */
export function sarvamReply(turn: ModelTurn): unknown {
  const texts: string[] = [];
  const calls: { id: string; name: string; arguments: string }[] = [];
  for (const block of turn.content) {
    if (!block || typeof block !== "object") continue;
    const row = block as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (row.type === "text" && typeof row.text === "string") texts.push(row.text);
    if (row.type === "tool_use" && typeof row.id === "string" && typeof row.name === "string") {
      calls.push({ id: row.id, name: row.name, arguments: JSON.stringify(row.input ?? {}) });
    }
  }
  const text = texts.join("\n");
  const refusal = turn.stop_reason === "refusal";
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "sarvam-105b",
    choices: [
      {
        index: 0,
        finish_reason: calls.length > 0 ? "tool_calls" : refusal ? "content_filter" : "stop",
        message: {
          role: "assistant",
          content: text.length > 0 && !refusal ? text : null,
          ...(refusal ? { refusal: text.length > 0 ? text : "refused" } : {}),
          ...(calls.length > 0
            ? {
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        },
      },
    ],
  };
}
