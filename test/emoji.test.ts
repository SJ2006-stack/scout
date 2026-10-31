import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripEmoji, withEmoji } from "../src/shared/emoji.ts";

describe("emoji intelligence", () => {
  it("adds one emoji that matches the reply", () => {
    assert.equal(withEmoji("Two comedy shows tomorrow."), "😂 Two comedy shows tomorrow.");
    assert.equal(withEmoji("Zepto is cheapest: milk at ₹70."), "🛒 Zepto is cheapest: milk at ₹70.");
    assert.equal(withEmoji("Which city should I look in?"), "📍 Which city should I look in?");
    assert.equal(withEmoji("Registered for Nitro Run."), "✅ Registered for Nitro Run.");
  });

  it("leaves a reply that already has an emoji", () => {
    assert.equal(withEmoji("🎬 That film is tonight."), "🎬 That film is tonight.");
  });

  it("removes emoji before speech", () => {
    assert.equal(stripEmoji("📅 Tonight in Delhi."), "Tonight in Delhi.");
    assert.equal(stripEmoji("दिल्ली में तीन कार्यक्रम हैं"), "दिल्ली में तीन कार्यक्रम हैं");
  });
});