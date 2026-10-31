import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { EmailAuth, type AuthMailer } from "../src/server/auth/emailAuth.ts";
import { UserDirectory } from "../src/server/db/userDirectory.ts";
import { AppReleaseInvite, googleAccessToken, inviteEmail } from "../src/server/invites/appRelease.ts";
import { withApi } from "./helpers.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = "1%3A153984242644%3Aandroid%3Af6b6eee7dc1dfaf683bc41";
const RELEASE = "projects/153984242644/apps/1:153984242644:android:f6b6eee7dc1dfaf683bc41/releases/6tr27au31fvdg";

describe("app install invite", () => {
  it("accepts a normal email", () => {
    assert.equal(inviteEmail(" Ada@Example.com "), "ada@example.com");
    assert.equal(inviteEmail("not-an-email"), null);
  });

  it("adds the tester and sends the newest Firebase release", async () => {
    const calls: { url: string; body: unknown }[] = [];
    let now = 1_000_000;
    const invite = new AppReleaseInvite({
      now: () => now,
      accessToken: async () => "token",
      fetchImpl: async (url, init) => {
        const href = String(url);
        calls.push({ url: href, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (href.endsWith("/releases")) {
          return json({
            releases: [
              { name: RELEASE.replace("6tr27au31fvdg", "older"), createTime: "2026-10-01T00:00:00Z" },
              { name: RELEASE, createTime: "2026-10-31T00:00:00Z" },
            ],
          });
        }
        return json({});
      },
    });
    const sent = await invite.send("ada@example.com");
    assert.equal(sent.ok, true);
    assert.equal(calls[0]?.url, "https://firebaseappdistribution.googleapis.com/v1/projects/153984242644/testers:batchAdd");
    assert.deepEqual(calls[0]?.body, { emails: ["ada@example.com"] });
    assert.equal(calls[1]?.url, `https://firebaseappdistribution.googleapis.com/v1/projects/153984242644/apps/${APP}/releases`);
    assert.equal(calls[2]?.url, `https://firebaseappdistribution.googleapis.com/v1/projects/153984242644/apps/${APP}/releases/6tr27au31fvdg:distribute`);
    assert.deepEqual(calls[2]?.body, { testerEmails: ["ada@example.com"] });
    now += 1_000;
    const again = await invite.send("ada@example.com");
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.equal(again.status, 429);
  });

  it("signs in to Google without putting the key in the token request body", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    let assertion = "";
    const token = await googleAccessToken("invite@scout-b4da3.iam.gserviceaccount.com", pem, async (_url, init) => {
      assertion = String(init?.body);
      return json({ access_token: "ya29.test" });
    });
    assert.equal(token, "ya29.test");
    assert.equal(assertion.includes("BEGIN PRIVATE KEY"), false);
    assert.equal(assertion.split(".").length >= 3, true);
  });

  it("lets a signed-out visitor request the install link", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-invite-"));
    const mailer: AuthMailer = { configured: true, async send() {} };
    const auth = new EmailAuth(new UserDirectory(join(dir, "scout.sqlite")), mailer, () => 1);
    const sent: string[] = [];
    try {
      await withApi({
        auth,
        invite: {
          configured: true,
          async send(email) {
            sent.push(email);
            return { ok: true };
          },
        },
      }, async (base) => {
        const blocked = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        assert.equal(blocked.status, 401);
        const response = await fetch(`${base}/api/invite`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "ada@example.com" }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { sent: true });
      });
      assert.deepEqual(sent, ["ada@example.com"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
