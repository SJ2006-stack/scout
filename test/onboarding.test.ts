import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gmailAddress, indianMobile, onboardingStep, preferredName } from "../src/shared/onboarding.ts";
import { EmailAuth } from "../src/server/auth/emailAuth.ts";
import { UserDirectory } from "../src/server/db/userDirectory.ts";
import { withApi } from "./helpers.ts";

describe("onboarding", () => {
  it("accepts a Gmail address, an Indian mobile number, and a short name", () => {
    assert.equal(gmailAddress(" Ada@Gmail.com "), "ada@gmail.com");
    assert.equal(gmailAddress("ada@outlook.com"), null);
    assert.equal(indianMobile("98765 43210"), "+919876543210");
    assert.equal(indianMobile("+91 98765 43210"), "+919876543210");
    assert.equal(indianMobile("12345"), null);
    assert.equal(preferredName("  Asha  Rao "), "Asha Rao");
    assert.equal(preferredName(""), null);
    assert.equal(onboardingStep({ signedIn: true, phone: null, name: null }), "phone");
    assert.equal(onboardingStep({ signedIn: true, phone: "+919876543210", name: null }), "name");
    assert.equal(onboardingStep({ signedIn: true, phone: "+919876543210", name: "Asha" }), "ready");
  });

  it("stores the phone only after Gmail, then the name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-onboarding-"));
    const sent: string[] = [];
    const directory = new UserDirectory(join(dir, "scout.sqlite"));
    const auth = new EmailAuth(directory, {
      configured: true,
      async send(_to, _subject, text) {
        sent.push(text);
      },
    }, () => 1_000);
    try {
      const refused = await auth.requestCode("ada@outlook.com");
      assert.equal(refused.ok, false);
      await withApi({ auth, directory, now: () => 1_000 }, async (base) => {
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
        const cookie = verified.headers.get("set-cookie")?.split(";")[0] ?? "";
        const earlyName = await fetch(`${base}/api/onboarding/name`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ name: "Asha" }),
        });
        assert.equal(earlyName.status, 400);
        const phone = await fetch(`${base}/api/onboarding/phone`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ phone: "9876543210" }),
        });
        assert.equal(phone.status, 200);
        const named = await fetch(`${base}/api/onboarding/name`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ name: "Asha" }),
        });
        assert.equal(named.status, 200);
        const session = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
        const body = (await session.json()) as { phone?: string; name?: string };
        assert.equal(body.phone, "+919876543210");
        assert.equal(body.name, "Asha");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
