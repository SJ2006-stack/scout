import assert from "node:assert/strict";
import test from "node:test";
import { mainLandingFile } from "../src/server/landingPage.ts";

test("the main site home is the landing page", () => {
  assert.equal(
    mainLandingFile("/app", "sj-scout.azurewebsites.net", "/"),
    "/app/scout-landing/index.html",
  );
  assert.equal(mainLandingFile("/app", "sj-scout.azurewebsites.net:443", "/index.html"), "/app/scout-landing/index.html");
  assert.equal(mainLandingFile("/app", "sj-event-scout.azurewebsites.net", "/"), null);
  assert.equal(mainLandingFile("/app", "sj-scout.azurewebsites.net", "/api/health"), null);
});
