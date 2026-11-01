import type { PageElement } from "./driver.ts";

const INTERACTIVE = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "tab",
  "menuitem",
  "option",
  "switch",
  "textbox",
  "searchbox",
  "combobox",
]);

/** A sign-in label drawn as plain text, such as Blinkit's "Login" beside "My Cart". */
const TEXT_LOGIN = /(?:^|\s)(log\s?in|sign\s?in)(?=\s|$)/i;

export function parseAriaSnapshot(snapshot: string): PageElement[] {
  const elements: PageElement[] = [];
  for (const line of snapshot.split("\n")) {
    const match = /^\s*-\s+([a-zA-Z]+)\s+"([^"]*)"/.exec(line);
    const role = match?.[1]?.toLowerCase();
    const name = match?.[2];
    if (role && name != null && INTERACTIVE.has(role)) {
      elements.push({ role, name });
      continue;
    }
    const quoted = /^\s*-\s+text\s+"([^"]*)"/.exec(line);
    const bare = /^\s*-\s+text:\s+(.+)$/.exec(line);
    const text = quoted?.[1] ?? bare?.[1]?.trim();
    if (text && /₹|\b\d/.test(text)) elements.push({ role: "text", name: text });
    else if (text && text.length <= 40) {
      const login = TEXT_LOGIN.exec(text)?.[1];
      if (login) elements.push({ role: "text", name: login });
    }
  }
  return elements;
}
