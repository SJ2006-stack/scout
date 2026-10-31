import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EmailAuth, type AuthMailer } from "../src/server/auth/emailAuth.ts";
import { UserDirectory } from "../src/server/db/userDirectory.ts";
import { withApi } from "./helpers.ts";

const EMAIL = "ada@gmail.com";

describe("email sign-in", () => {
  it("sends a code, then opens the same user when the code matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-auth-"));
    const sent: string[] = [];
    const mailer: AuthMailer = {
      configured: true,
      async send(_to, _subject, text) {
        sent.push(text);
      },
    };
    try {
      const directory = new UserDirectory(join(dir, "scout.sqlite"));
      let now = 1_000_000;
      const auth = new EmailAuth(directory, mailer, () => now);
      const first = await auth.requestCode(EMAIL);
      assert.equal(first.ok, true);
      const code = sent[0]?.match(/\d{6}/)?.[0] ?? "";
      assert.equal(code.length, 6);
      const stored = directory.codeFor(EMAIL);
      assert.ok(stored);
      assert.notEqual(stored.codeHash, code);
      assert.equal(auth.verify(EMAIL, "000000").ok, false);
      const opened = auth.verify(EMAIL, code);
      assert.equal(opened.ok, true);
      if (!opened.ok || opened.kind !== "session") return;
      assert.equal(opened.email, EMAIL);
      assert.equal(directory.codeFor(EMAIL), null);
      const again = await auth.requestCode(EMAIL);
      assert.equal(again.ok, false);
      now += 60_000;
      await auth.requestCode(EMAIL);
      const next = sent[1]?.match(/\d{6}/)?.[0] ?? "";
      const second = auth.verify(EMAIL, next);
      assert.equal(second.ok, true);
      if (!second.ok || second.kind !== "session") return;
      assert.equal(second.userId, opened.userId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps chat closed until the code matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-auth-http-"));
    const sent: string[] = [];
    const directory = new UserDirectory(join(dir, "scout.sqlite"));
    const auth = new EmailAuth(directory, {
      configured: true,
      async send(_to, _subject, text) {
        sent.push(text);
      },
    }, Date.now);
    try {
      await withApi({ auth, directory }, async (base) => {
        const locked = await fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hello" }),
        });
        assert.equal(locked.status, 401);
        const requested = await fetch(`${base}/api/auth/email`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "ada@gmail.com" }),
        });
        assert.equal(requested.status, 200);
        const code = sent[0]?.match(/\d{6}/)?.[0] ?? "";
        const verified = await fetch(`${base}/api/auth/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "ada@gmail.com", code }),
        });
        assert.equal(verified.status, 200);
        const cookie = verified.headers.get("set-cookie") ?? "";
        assert.equal(cookie.includes("scout_session="), true);
        const session = await fetch(`${base}/api/auth/session`, { headers: { cookie: cookie.split(";")[0] ?? "" } });
        const body = (await session.json()) as { signedIn?: boolean; email?: string };
        assert.equal(body.signedIn, true);
        assert.equal(body.email, "ada@gmail.com");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
