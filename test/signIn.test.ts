import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextSignInAction, SIGN_IN_CODE_MESSAGE } from "../src/server/browser/signIn.ts";

const account = { email: "ada@gmail.com", phone: "+919876543210" };

describe("browser sign-in", () => {
  it("types the saved phone number, then waits for the code", () => {
    const phone = nextSignInAction([
      { role: "button", name: "Sign in" },
      { role: "textbox", name: "Mobile number" },
    ], account, new Set());
    assert.equal(phone.type, "fill");
    if (phone.type !== "fill") return;
    assert.equal(phone.value, "9876543210");
    const send = nextSignInAction([
      { role: "textbox", name: "Mobile number" },
      { role: "button", name: "Send OTP" },
    ], account, new Set([`fill:${phone.name}`]));
    assert.equal(send.type, "click");
    if (send.type !== "click") return;
    assert.equal(send.name, "Send OTP");
    const waiting = nextSignInAction([
      { role: "textbox", name: "OTP" },
    ], account, new Set([`fill:${phone.name}`, `click:${send.name}`]));
    assert.equal(waiting.type, "code");
    assert.match(SIGN_IN_CODE_MESSAGE, /vault/);
  });

  it("uses Gmail when the page asks for an email", () => {
    const email = nextSignInAction([
      { role: "textbox", name: "Email" },
      { role: "button", name: "Continue" },
    ], { email: "ada@gmail.com", phone: null }, new Set());
    assert.equal(email.type, "fill");
    if (email.type !== "fill") return;
    assert.equal(email.value, "ada@gmail.com");
  });

  it("leaves a signed-in page alone", () => {
    const ready = nextSignInAction([
      { role: "button", name: "Sign out" },
      { role: "link", name: "Events" },
    ], account, new Set());
    assert.equal(ready.type, "saved");
  });
});
