import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mainLandingFile } from "../src/server/landingPage.ts";

describe("main landing", () => {
  it("serves the landing on the public host and leaves specialist paths to the app", () => {
    const root = "/app";
    const landing = join(root, "scout-landing", "index.html");
    assert.equal(mainLandingFile(root, "scout.shrianshjaiswal.me", "/"), landing);
    assert.equal(mainLandingFile(root, "sj-scout.azurewebsites.net:443", "/index.html"), landing);
    assert.equal(mainLandingFile(root, "scout.shrianshjaiswal.me", "/sign-in"), null);
    assert.equal(mainLandingFile(root, "scout.shrianshjaiswal.me", "/event-scout"), null);
    assert.equal(mainLandingFile(root, "sj-event-scout.azurewebsites.net", "/"), null);
  });
});
