import assert from "node:assert/strict";
import test from "node:test";
import { capHistory, historyFromTurns, readHistory, HISTORY_CHAR_LIMIT } from "../src/shared/chatHistory.ts";
import type { DeskTurn } from "../src/shared/deskBoard.ts";

test("a chat keeps its own lines and leaves out thinking", () => {
  const turns: DeskTurn[] = [
    { kind: "user", text: "What's happening tomorrow in Delhi?" },
    { kind: "thinking", steps: ["Thought for 1s"], startedAt: 1, finishedAt: 2 },
    { kind: "text", text: "I checked Luma, District, and BookMyShow." },
    { kind: "note", text: "Waiting for you to allow it on the phone." },
    { kind: "user", text: "what have we been doing" },
  ];
  assert.deepEqual(historyFromTurns(turns), [
    { role: "user", text: "What's happening tomorrow in Delhi?" },
    { role: "assistant", text: "I checked Luma, District, and BookMyShow." },
    { role: "assistant", text: "Waiting for you to allow it on the phone." },
    { role: "user", text: "what have we been doing" },
  ]);
});

test("history keeps the newest lines when the chat is long", () => {
  const lines = Array.from({ length: 5 }, (_, index) => ({ role: "user" as const, text: "x".repeat(HISTORY_CHAR_LIMIT) + index }));
  const kept = capHistory(lines);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.text.endsWith("4"), true);
});

test("a missing history is absent and a non-list is refused", () => {
  assert.equal(readHistory(undefined), null);
  assert.equal(readHistory("nope"), "bad");
  assert.deepEqual(readHistory([{ role: "assistant", text: " Delhi events " }, { role: "nope", text: "skip" }]), [
    { role: "assistant", text: "Delhi events" },
  ]);
});
