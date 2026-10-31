import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browseFollowUp, matchFound, readablePage } from "../src/server/events/pageText.ts";

describe("event page text", () => {
  it("keeps the description from an event page", () => {
    const text = readablePage("<html><head><meta name=\"description\" content=\"A morning run in Delhi\"></head><script>secret</script><body><h1>NITRO RUN</h1><p>Gandhi bagh</p></body></html>");
    assert.match(text, /morning run in Delhi/);
    assert.match(text, /Gandhi bagh/);
    assert.equal(text.includes("secret"), false);
  });

  it("finds a saved event by title or url", () => {
    const found = [{ title: "NITRO RUN", url: "https://luma.com/io3jgrsl" }];
    assert.equal(matchFound(found, "nitro", "")?.url, "https://luma.com/io3jgrsl");
    assert.equal(matchFound(found, "", "https://luma.com/io3jgrsl")?.title, "https://luma.com/io3jgrsl");
    assert.equal(matchFound(found, "jazz", ""), null);
  });

  it("asks what they want after the first three, and stays quiet for a detail request", () => {
    assert.match(browseFollowUp("I found a run.", 3, "what's happening tomorrow in Delhi"), /something particular/);
    assert.equal(browseFollowUp("I found a run. Want comedy?", 3, "what's on"), "I found a run. Want comedy?");
    assert.equal(browseFollowUp("Opening the page.", 0, "more details about nitro"), "Opening the page.");
    assert.equal(browseFollowUp("I found a run.", 3, "register me on nitro"), "I found a run.");
  });
});