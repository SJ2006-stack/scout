import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deleteConversation } from "../src/web/conversationList.ts";

describe("conversation list", () => {
  it("deletes one chat and leaves the others", () => {
    const conversations = [
      { id: "new", title: "New chat" },
      { id: "about", title: "tell me about yourself" },
      { id: "delhi", title: "what's happening tomorrow in delhi" },
    ];
    const next = deleteConversation(conversations, "about");
    assert.deepEqual(next.map((item) => item.id), ["new", "delhi"]);
    assert.equal(deleteConversation(conversations, "missing").length, 3);
    assert.equal(conversations.length, 3);
  });
});