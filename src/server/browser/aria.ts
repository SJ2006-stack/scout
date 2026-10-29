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

export function parseAriaSnapshot(snapshot: string): PageElement[] {
  const elements: PageElement[] = [];
  for (const line of snapshot.split("\n")) {
    const match = /^\s*-\s+([a-zA-Z]+)\s+"([^"]*)"/.exec(line);
    const role = match?.[1]?.toLowerCase();
    const name = match?.[2];
    if (!role || name == null || !INTERACTIVE.has(role)) continue;
    elements.push({ role, name });
  }
  return elements;
}
