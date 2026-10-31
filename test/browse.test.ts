import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchControl, readBrowseCommand } from "../src/shared/browse.ts";

const controls = [
  { ref: "e1", role: "link", name: "Home" },
  { ref: "e2", role: "button", name: "Continue" },
  { ref: "e3", role: "textbox", name: "Email" },
];

describe("browse commands", () => {
  it("lets every scout open a page, click a control, or fill a field", () => {
    assert.deepEqual(readBrowseCommand("Open https://www.district.in/events/."), {
      kind: "open",
      url: "https://www.district.in/events/",
    });
    assert.deepEqual(readBrowseCommand("click Continue"), { kind: "click", name: "Continue" });
    assert.deepEqual(readBrowseCommand("type ada@example.com into Email"), {
      kind: "fill",
      value: "ada@example.com",
      name: "Email",
    });
    assert.equal(readBrowseCommand("Find comedy in Delhi"), null);
    assert.equal(matchControl(controls, "Continue", "click")?.ref, "e2");
    assert.equal(matchControl(controls, "Email", "fill")?.ref, "e3");
    assert.equal(matchControl(controls, "Email", "click"), null);
  });
});