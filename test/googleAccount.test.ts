import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DRIVE_SCOPE, GMAIL_SCOPE, GoogleAccounts } from "../src/server/googleAccount.ts";
import { screenToolAllowed } from "../src/server/screenChat.ts";

const KEY = Buffer.from("ab".repeat(32), "hex");
const USER = "a".repeat(32);

describe("google accounts", () => {
  it("asks Google for full Gmail and Drive control, and keeps the refresh token sealed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-google-"));
    const google = new GoogleAccounts(join(dir, "scout.sqlite"), KEY, { clientId: "client", clientSecret: "secret", redirectUri: "" }, () => 5_000);
    try {
      const gmail = google.start(USER, "gmail", "https://scout.example/api/google/callback");
      const drive = google.start(USER, "drive", "https://scout.example/api/google/callback");
      assert.equal(gmail.ok, true);
      assert.equal(drive.ok, true);
      if (!gmail.ok || !drive.ok) return;
      const gmailScopes = new URL(gmail.url).searchParams.get("scope")?.split(" ") ?? [];
      const driveScopes = new URL(drive.url).searchParams.get("scope")?.split(" ") ?? [];
      assert.equal(gmailScopes.includes(GMAIL_SCOPE), true);
      assert.equal(gmailScopes.includes("https://www.googleapis.com/auth/gmail.readonly"), false);
      assert.equal(driveScopes.includes(DRIVE_SCOPE), true);
      assert.equal(driveScopes.includes("https://www.googleapis.com/auth/drive.readonly"), false);
      assert.equal(driveScopes.includes("https://www.googleapis.com/auth/drive.file"), false);
      assert.equal(new URL(gmail.url).searchParams.get("access_type"), "offline");
      assert.equal(new URL(gmail.url).searchParams.get("prompt"), "consent");
      const state = new URL(gmail.url).searchParams.get("state") ?? "";
      const fetchImpl: typeof fetch = async (input) => {
        const url = String(input);
        if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "access", refresh_token: "refresh-secret" });
        return Response.json({ email: "ada@gmail.com" });
      };
      const done = await google.finish(new URLSearchParams({ code: "code", state }), fetchImpl);
      assert.equal(done.ok, true);
      const again = await google.finish(new URLSearchParams({ code: "code", state }), fetchImpl);
      assert.equal(again.ok, false);
      const status = google.status(USER);
      assert.equal(status.links.find((link) => link.service === "gmail")?.email, "ada@gmail.com");
      assert.equal(JSON.stringify(status).includes("refresh-secret"), false);
      const missed = await google.run(USER, "drive_write", { name: "note.txt", text: "hello" }, fetchImpl, "https://scout.example/api/google/callback");
      assert.equal(missed.ok, false);
      assert.match(missed.content, /not connected/);
      assert.equal(screenToolAllowed("gmail_send"), false);
      assert.equal(screenToolAllowed("drive_trash"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays off until the OAuth client is set", () => {
    const google = new GoogleAccounts(":memory:", KEY, { clientId: "", clientSecret: "", redirectUri: "" }, () => 1);
    const started = google.start(USER, "gmail", "https://scout.example/api/google/callback");
    assert.equal(started.ok, false);
    if (!started.ok) assert.match(started.error, /GOOGLE_OAUTH_CLIENT_ID/);
  });
});
