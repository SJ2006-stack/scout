import type { IsolatedPage, PageElement } from "./driver.ts";

const FILL_ROLES = new Set(["textbox", "searchbox", "combobox"]);
const CLICK_ROLES = new Set(["button", "link"]);
const SIGNED_IN = /sign[\s-]?out|log[\s-]?out/i;
const OPEN_LOGIN = /sign[\s-]?in|log[\s-]?in|^login$|continue with (?:phone|email|google)/i;
const PHONE_FIELD = /phone|mobile|number/i;
const EMAIL_FIELD = /email|e-mail|gmail/i;
const SEND_CODE = /otp|send code|get code|continue|next|verify/i;
const CODE_FIELD = /code|otp|pin|passcode|verification/i;

export const SIGN_IN_CODE_MESSAGE = "A sign-in code was sent to your phone or Gmail. Approve it on your phone and Scout saves that browser session in the vault.";

export type AccountLogin = {
  email: string;
  phone: string | null;
  name?: string | null;
};

export type SignInResult = "unchanged" | "saved" | "code";

type SignInAction =
  | { type: "unchanged" }
  | { type: "saved" }
  | { type: "code" }
  | { type: "click"; role: string; name: string }
  | { type: "fill"; role: string; name: string; value: string };

export function nextSignInAction(elements: readonly PageElement[], account: AccountLogin, used: ReadonlySet<string>): SignInAction {
  const clickable = elements.filter((element) => CLICK_ROLES.has(element.role));
  const fields = elements.filter((element) => FILL_ROLES.has(element.role));
  if (clickable.some((element) => SIGNED_IN.test(element.name))) return { type: "saved" };
  const code = fields.find((element) => CODE_FIELD.test(element.name));
  const filled = [...used].some((item) => item.startsWith("fill:"));
  if (code && filled) return { type: "code" };
  const phoneBox = account.phone == null ? undefined : fields.find((element) => PHONE_FIELD.test(element.name) && !used.has(fillKey(element)));
  if (phoneBox && account.phone) return { type: "fill", role: phoneBox.role, name: phoneBox.name, value: localPhone(account.phone) };
  const emailBox = fields.find((element) => EMAIL_FIELD.test(element.name) && !used.has(fillKey(element)));
  if (emailBox) return { type: "fill", role: emailBox.role, name: emailBox.name, value: account.email };
  const open = clickable.find((element) => OPEN_LOGIN.test(element.name) && !used.has(clickKey(element)));
  if (open && !filled) return { type: "click", role: open.role, name: open.name };
  const send = clickable.find((element) => SEND_CODE.test(element.name) && !used.has(clickKey(element)));
  if (send && filled) return { type: "click", role: send.role, name: send.name };
  if (code) return { type: "code" };
  return used.size === 0 ? { type: "unchanged" } : { type: "saved" };
}

export async function attemptSignIn(
  page: IsolatedPage,
  account: AccountLogin,
  step: <T>(run: (signal: AbortSignal) => Promise<T>) => Promise<T>,
): Promise<SignInResult> {
  const used = new Set<string>();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const elements = await step((signal) => page.elements(signal));
    const action = nextSignInAction(elements, account, used);
    if (action.type === "unchanged" || action.type === "saved" || action.type === "code") return action.type;
    if (action.type === "click") {
      used.add(clickKey(action));
      await step((signal) => page.click({ role: action.role, name: action.name, nth: 0 }, signal));
      continue;
    }
    used.add(fillKey(action));
    await step((signal) => page.fill({ role: action.role, name: action.name, nth: 0 }, action.value, signal));
  }
  return used.size === 0 ? "unchanged" : "saved";
}

function localPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return digits;
}

function fillKey(element: { name: string }): string {
  return `fill:${element.name}`;
}

function clickKey(element: { name: string }): string {
  return `click:${element.name}`;
}
