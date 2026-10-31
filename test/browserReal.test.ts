import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { chromium } from "playwright-core";
import { PlaywrightBrowserDriver } from "../src/server/browser/playwrightDriver.ts";

function chromiumInstalled(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

describe("real chromium", { skip: !chromiumInstalled() }, () => {
  it("opens example.org, reads a link, and stays on https", async () => {
    const driver = new PlaywrightBrowserDriver(20_000);
    const page = await driver.openIsolated({ allow: (url) => url.startsWith("https://") });
    try {
      const landed = await page.goto("https://example.org/", new AbortController().signal);
      assert.equal(landed.url.startsWith("https://example.org/"), true);
      assert.equal(landed.title, "Example Domain");
      const elements = await page.elements(new AbortController().signal);
      assert.equal(elements.some((element) => element.role === "link" && element.name === "Learn more"), true);
      const state = await page.storageState(new AbortController().signal);
      assert.equal(typeof state, "object");
      await page.click({ role: "link", name: "Learn more", nth: 0 }, new AbortController().signal);
      const after = await page.location(new AbortController().signal);
      assert.equal(after.url.startsWith("https://"), true);
    } finally {
      await page.close();
      await driver.close();
    }
  });
});
