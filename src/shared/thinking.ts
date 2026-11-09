export type ThinkingTool = {
  name: string;
  description: string;
};

/** The system prompt and tools a scout was given, shown on the phone under the progress steps. */
export type ThinkingBrief = {
  scout: string;
  fed: boolean;
  prompt: string;
  tools: ThinkingTool[];
};

export type ThinkingTurn = {
  kind: "thinking";
  steps: string[];
  startedAt: number;
  finishedAt: number | null;
  brief?: ThinkingBrief;
};

export function isThinkingTurn(value: unknown): value is ThinkingTurn {
  if (!value || typeof value !== "object") return false;
  const turn = value as Partial<ThinkingTurn>;
  return turn.kind === "thinking"
    && Array.isArray(turn.steps)
    && turn.steps.every((step) => typeof step === "string")
    && typeof turn.startedAt === "number"
    && (turn.finishedAt == null || typeof turn.finishedAt === "number");
}

export function thoughtLabel(startedAt: number, finishedAt: number | null): string {
  if (finishedAt == null) return "Thinking";
  const seconds = Math.max(1, Math.round((finishedAt - startedAt) / 1000));
  return seconds === 1 ? "Thought for 1s" : `Thought for ${seconds}s`;
}

export function appendThought(turn: ThinkingTurn, step: string): ThinkingTurn {
  const steps = pushActivity(turn.steps, step);
  if (steps.length === turn.steps.length && steps.every((line, index) => line === turn.steps[index])) return turn;
  return { ...turn, steps };
}

/** Adds a progress line. "Message sent to Event Scout." replaces the plain "Message sent." opener. */
export function pushActivity(lines: readonly string[], step: string): string[] {
  const text = step.trim();
  if (text.length === 0) return [...lines];
  if (text.startsWith("Message sent to ")) {
    const opener = lines.findIndex((line) => line === "Message sent." || line.startsWith("Message sent to "));
    if (opener >= 0) {
      if (lines[opener] === text) return [...lines];
      const next = [...lines];
      next[opener] = text;
      return next;
    }
  }
  if (text.startsWith("Event Scout fetching") && lines.includes(text)) return [...lines];
  if (lines.at(-1) === text) return [...lines];
  return [...lines, text];
}

export function readThinkingBrief(value: unknown): ThinkingBrief | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { scout?: unknown; fed?: unknown; prompt?: unknown; tools?: unknown };
  if (typeof row.scout !== "string" || row.scout.trim().length === 0) return null;
  if (typeof row.fed !== "boolean") return null;
  if (typeof row.prompt !== "string" || row.prompt.trim().length === 0) return null;
  if (!Array.isArray(row.tools)) return null;
  const tools: ThinkingTool[] = [];
  for (const tool of row.tools) {
    if (!tool || typeof tool !== "object") continue;
    const item = tool as { name?: unknown; description?: unknown };
    if (typeof item.name !== "string" || item.name.trim().length === 0) continue;
    tools.push({
      name: item.name.trim().slice(0, 80),
      description: typeof item.description === "string" ? item.description.trim().slice(0, 600) : "",
    });
    if (tools.length === 24) break;
  }
  return {
    scout: row.scout.trim().slice(0, 40),
    fed: row.fed,
    prompt: row.prompt.trim().slice(0, 12_000),
    tools,
  };
}

export function finishThought(turn: ThinkingTurn, now: number): ThinkingTurn {
  if (turn.finishedAt != null) return turn;
  return { ...turn, finishedAt: now };
}
