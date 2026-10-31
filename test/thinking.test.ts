import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deskConversations } from "../src/shared/deskBoard.ts";
import { appendThought, finishThought, thoughtLabel, type ThinkingTurn } from "../src/shared/thinking.ts";

describe("thinking", () => {
  it("labels a live trace and the seconds it took", () => {
    assert.equal(thoughtLabel(0, null), "Thinking");
    assert.equal(thoughtLabel(0, 400), "Thought for 1s");
    assert.equal(thoughtLabel(0, 12_400), "Thought for 12s");
  });

  it("keeps the steps and seals them once", () => {
    const open: ThinkingTurn = { kind: "thinking", steps: [], startedAt: 10, finishedAt: null };
    const next = appendThought(appendThought(open, "Opened the page."), "  ");
    const again = appendThought(next, "Opened the page.");
    assert.deepEqual(again.steps, ["Opened the page."]);
    const sealed = finishThought(again, 4_000);
    assert.equal(sealed.finishedAt, 4_000);
    assert.equal(finishThought(sealed, 9_000).finishedAt, 4_000);
  });

  it("keeps a saved thinking turn on a chat", () => {
    const loaded = deskConversations([{
      id: "chat",
      sessionId: "session",
      agent: "shop",
      title: "Milk",
      turns: [
        { kind: "user", text: "Find milk." },
        { kind: "thinking", steps: ["Searching the simulated Instamart catalog."], startedAt: 1, finishedAt: 2 },
        { kind: "text", text: "Added 1 Amul Taaza Milk 1 L. This line is simulated." },
      ],
      activity: [],
      updatedAt: 2,
    }]);
    assert.equal(loaded[0]?.turns[1]?.kind, "thinking");
  });
});