export type BrowserControl = {
  ref: string;
  role: string;
  name: string;
};

export type BrowseCommand =
  | { kind: "open"; url: string }
  | { kind: "click"; name: string }
  | { kind: "fill"; name: string; value: string };

const CLICK_ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "option", "switch"]);
const FILL_ROLES = new Set(["textbox", "searchbox", "combobox"]);

export function readBrowseCommand(text: string): BrowseCommand | null {
  const found = text.match(/https:\/\/[^\s<>"']+/);
  if (found) {
    const url = found[0].replace(/[),.;]+$/, "");
    if (url.length > "https://".length) return { kind: "open", url };
  }
  const fill = text.match(/^(?:type|enter|fill)\s+(.+?)\s+into\s+(.+)$/i);
  if (fill?.[1] && fill[2]) return { kind: "fill", value: fill[1].trim(), name: fill[2].trim() };
  const click = text.match(/^(?:click|press|tap)\s+(.+)$/i);
  if (click?.[1] && click[1].trim().length > 0) return { kind: "click", name: click[1].trim() };
  return null;
}

export function matchControl(controls: readonly BrowserControl[], name: string, kind: "click" | "fill"): BrowserControl | null {
  const needle = name.trim().toLowerCase();
  if (needle.length === 0) return null;
  const roles = kind === "fill" ? FILL_ROLES : CLICK_ROLES;
  const eligible = controls.filter((item) => roles.has(item.role) && item.name.trim().length > 0);
  return eligible.find((item) => item.name.toLowerCase() === needle)
    ?? eligible.find((item) => item.name.toLowerCase().includes(needle))
    ?? null;
}
