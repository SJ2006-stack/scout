import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAriaSnapshot } from "../src/server/browser/aria.ts";
import type { ElementTarget, IsolatedPage, PageElement } from "../src/server/browser/driver.ts";
import { signInWithSkill } from "../src/server/browser/siteFlows.ts";
import { SKILLS } from "../src/server/browser/skills.ts";
import { CONNECTOR_GROUPS } from "../src/shared/onboarding.ts";

const step = <T>(run: (signal: AbortSignal) => Promise<T>) => run(new AbortController().signal);

function zeptoPage(blankReads: number): { page: IsolatedPage; filled: string[] } {
  let reads = 0;
  type Stage = "home" | "login" | "code" | "done";
  let stage: Stage = "home";
  const filled: string[] = [];
  const screens: Record<Stage, PageElement[]> = {
    home: [{ role: "button", name: "login" }, { role: "button", name: "Cart" }],
    login: [{ role: "textbox", name: "Enter Phone Number" }, { role: "button", name: "Continue" }],
    code: [{ role: "textbox", name: "Enter OTP" }, { role: "button", name: "Verify" }],
    done: [{ role: "link", name: "My Orders" }, { role: "button", name: "Profile" }],
  };
  const page = {
    goto: async (url: string) => ({ url, title: "Zepto" }),
    location: async () => ({ url: "https://www.zepto.com/", title: "Zepto" }),
    html: async () => "<html></html>",
    elements: async () => {
      reads += 1;
      return reads <= blankReads ? [] : screens[stage];
    },
    click: async (target: ElementTarget) => {
      if (target.name === "login") stage = "login";
      if (target.name === "Continue") stage = "code";
      if (target.name === "Verify") stage = "done";
    },
    fill: async (_target: ElementTarget, value: string) => {
      filled.push(value);
    },
    takePayment: () => null,
    screenshot: async () => new Uint8Array(),
    storageState: async () => ({}),
    close: async () => undefined,
  } as IsolatedPage;
  return { page, filled };
}

describe("site sign-in", () => {
  it("lists each connector under its skill's vault domain and sign-in methods", () => {
    for (const connector of CONNECTOR_GROUPS.flatMap((group) => group.connectors)) {
      const skill = SKILLS[connector.id];
      assert.equal(skill.domains[0], connector.domain);
      const methods = skill.login.methods.join(" ");
      assert.equal(connector.uses === "phone or email" ? methods === "phone email" : methods === connector.uses, true, connector.id);
    }
  });

  it("finds Blinkit's Login drawn as plain text, but not a long sentence that mentions it", () => {
    const elements = parseAriaSnapshot(["- text: Login r My Cart", "- text: Please login to see your past orders and saved addresses here"].join("\n"));
    assert.deepEqual(elements, [{ role: "text", name: "Login" }]);
    assert.equal(SKILLS.blinkit.login.openLogin.test("Login"), true);
  });

  it("opens Instamart's sign-in from its account button", () => {
    assert.equal(SKILLS.instamart.login.openLogin.test("Log in with phone number"), true);
    assert.equal(SKILLS.instamart.login.openLogin.test("double tap to go to user account"), true);
  });

  it("waits for a login button the page draws late, then signs in with phone and code", async () => {
    const { page, filled } = zeptoPage(3);
    const outcome = await signInWithSkill(page, SKILLS.zepto, { email: "a@example.com", phone: "+919876543210", name: "A" }, step, async () => "123456", 5);
    assert.deepEqual(outcome, { kind: "signed_in" });
    assert.deepEqual(filled, ["9876543210", "123456"]);
  });

  it("still gives up on a page that never shows a sign-in step", async () => {
    const { page } = zeptoPage(1_000);
    const outcome = await signInWithSkill(page, SKILLS.zepto, { email: "a@example.com", phone: "+919876543210", name: "A" }, step, async () => "123456", 1);
    assert.equal(outcome.kind, "failed");
  });
});
