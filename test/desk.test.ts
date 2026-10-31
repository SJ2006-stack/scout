import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mergeDesk } from "../src/shared/deskBoard.ts";
import { DeskStore } from "../src/server/desk.ts";
import { withApi } from "./helpers.ts";

const chat = {
  id: "old",
  sessionId: "session-old",
  agent: "event" as const,
  title: "yo",
  turns: [{ kind: "text" as const, text: "Ask for a city and a time." }],
  activity: [],
  updatedAt: 10,
};

describe("shared desk", () => {
  it("keeps the newer copy of a chat and an empty save does not wipe it", async () => {
    const older = { ...chat, title: "old title", updatedAt: 1 };
    const newer = { ...chat, title: "yo", updatedAt: 10 };
    assert.equal(mergeDesk([newer], [older])[0]?.title, "yo");
    const dir = mkdtempSync(join(tmpdir(), "scout-desk-"));
    const desk = new DeskStore(join(dir, "conversations.json"));
    assert.equal(desk.write({ conversations: [chat] })?.[0]?.title, "yo");
    assert.equal(desk.write({ conversations: [] })?.[0]?.title, "yo");
    await withApi({ desk }, async (base) => {
      const response = await fetch(`${base}/api/desk`);
      const body = (await response.json()) as { conversations: { title: string }[] };
      assert.equal(response.status, 200);
      assert.equal(body.conversations[0]?.title, "yo");
      const refused = await fetch(`${base}/api/desk`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nope: true }),
      });
      assert.equal(refused.status, 400);
    });
  });
});