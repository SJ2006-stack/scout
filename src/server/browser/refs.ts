import type { BrowserElement } from "../../shared/browser.ts";
import type { PageElement } from "./driver.ts";

export type AssignedElement = BrowserElement & { nth: number };

const LIMIT = 40;

export function assignRefs(elements: readonly PageElement[]): AssignedElement[] {
  const seen = new Map<string, number>();
  return elements.slice(0, LIMIT).map((element, index) => {
    const name = element.name.slice(0, 160);
    const key = `${element.role}\0${name}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    return { ref: `e${index + 1}`, role: element.role, name, nth };
  });
}

export function publicElements(elements: readonly AssignedElement[]): BrowserElement[] {
  return elements.map((element) => ({ ref: element.ref, role: element.role, name: element.name }));
}
