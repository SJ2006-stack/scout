export type ThinkingTurn = {
  kind: "thinking";
  steps: string[];
  startedAt: number;
  finishedAt: number | null;
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
  const text = step.trim();
  if (text.length === 0 || turn.steps.at(-1) === text) return turn;
  return { ...turn, steps: [...turn.steps, text] };
}

export function finishThought(turn: ThinkingTurn, now: number): ThinkingTurn {
  if (turn.finishedAt != null) return turn;
  return { ...turn, finishedAt: now };
}
