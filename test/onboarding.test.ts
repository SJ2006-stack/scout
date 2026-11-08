import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { aboutEntries, gmailAddress, indianMobile, onboardingStep, preferredName } from "../src/shared/onboarding.ts";
import { Accounts } from "../src/server/auth/accounts.ts";
import { UserDirectory } from "../src/server/db/userDirectory.ts";
import { ProfileStore } from "../src/server/profile/profileStore.ts";
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
    assert.equal(onboardingStep({ signedIn: false, phone: null, name: null, onboarded: false }), "google");
    assert.equal(onboardingStep({ signedIn: true, phone: null, name: null, onboarded: false }), "phone");
    assert.equal(onboardingStep({ signedIn: true, phone: "+919876543210", name: null, onboarded: false }), "name");
    assert.equal(onboardingStep({ signedIn: true, phone: "+919876543210", name: "Asha", onboarded: false }), "about");
    assert.equal(onboardingStep({ signedIn: true, phone: "+919876543210", name: "Asha", onboarded: true }), "ready");
  });

  it("keeps only known about answers, and reads the city from the pincode", () => {
    const parsed = aboutEntries({ pincode: "110 016", diet: "veg", interests: ["comedy", "concert", "rave"], language: "Hinglish" });
    assert.deepEqual(parsed, {
      ok: true,
      entries: { home_area: "110016", city: "delhi", diet: "Vegetarian", event_kinds: "concert, comedy", language: "Hinglish" },
    });
    assert.deepEqual(aboutEntries({ city: "Pune", diet: "carnivore", language: "French" }), { ok: true, entries: { city: "Pune" } });
    assert.deepEqual(aboutEntries({ pincode: "12345" }), { ok: false, error: "Enter a 6-digit pincode." });
    assert.deepEqual(aboutEntries({}), { ok: true, entries: {} });
  });

  it("has no email-code sign-in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-onboarding-"));
    const auth = new Accounts(new UserDirectory(join(dir, "scout.sqlite")), () => 1_000);
    try {
      await withApi({ auth, now: () => 1_000 }, async (base) => {
        for (const path of ["/api/auth/email", "/api/auth/verify"]) {
          const response = await fetch(`${base}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "ada@gmail.com", code: "123456" }),
          });
          assert.equal(response.status, 404, path);
        }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes the phone, then the name, then the about step into the profile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-onboarding-"));
    const directory = new UserDirectory(join(dir, "scout.sqlite"));
    const profile = new ProfileStore(join(dir, "profile.sqlite"));
    const auth = new Accounts(directory, () => 1_000);
    try {
      assert.equal(auth.sessionForVerifiedGmail("ada@outlook.com").ok, false);
      const signedIn = auth.sessionForVerifiedGmail("Ada@gmail.com");
      assert.equal(signedIn.ok, true);
      const cookie = `scout_session=${signedIn.ok ? signedIn.userId : ""}`;
      const post = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      });
      await withApi({ auth, directory, profile, now: () => 1_000 }, async (base) => {
        assert.equal((await post(base, "/api/onboarding/about", {})).status, 400);
        assert.equal((await post(base, "/api/onboarding/name", { name: "Asha" })).status, 400);
        assert.equal((await post(base, "/api/onboarding/phone", { phone: "9876543210" })).status, 200);
        assert.equal((await post(base, "/api/onboarding/about", {})).status, 400);
        assert.equal((await post(base, "/api/onboarding/name", { name: "Asha" })).status, 200);
        let session = (await (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json()) as Record<string, unknown>;
        assert.equal(session.phone, "+919876543210");
        assert.equal(session.name, "Asha");
        assert.equal(session.onboarded, false);
        assert.equal((await post(base, "/api/onboarding/about", { pincode: "1100" })).status, 400);
        const about = await post(base, "/api/onboarding/about", { pincode: "560034", diet: "jain", interests: ["workshop"], language: "Hindi" });
        assert.equal(about.status, 200);
        session = (await (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json()) as Record<string, unknown>;
        assert.equal(session.onboarded, true);
        const userId = signedIn.ok ? signedIn.userId : "";
        assert.deepEqual(
          profile.list(userId).map((entry) => [entry.key, entry.value, entry.source]),
          [
            ["city", "bengaluru", "explicit"],
            ["diet", "Jain", "explicit"],
            ["event_kinds", "workshop", "explicit"],
            ["home_area", "560034", "explicit"],
            ["language", "Hindi", "explicit"],
          ],
        );
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
