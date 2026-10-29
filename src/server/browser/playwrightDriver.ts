import { parseAriaSnapshot } from "./aria.ts";
import type { BrowserDriver, ElementTarget, IsolatedPage, PageElement } from "./driver.ts";

type LaunchedBrowser = {
  newContext(): Promise<LaunchedContext>;
  close(): Promise<void>;
};

type LaunchedContext = {
  route(pattern: string, handler: (route: LaunchedRoute) => Promise<unknown> | unknown): Promise<void>;
  newPage(): Promise<LaunchedPage>;
  close(): Promise<void>;
  setDefaultTimeout(timeout: number): void;
  setDefaultNavigationTimeout(timeout: number): void;
};

type LaunchedRoute = {
  request(): { url(): string; isNavigationRequest(): boolean };
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
};

type LaunchedPage = {
  goto(url: string, options: { timeout: number; waitUntil: "domcontentloaded" }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  locator(selector: string): { ariaSnapshot(): Promise<string> };
  getByRole(role: AriaRole, options: { name: string; exact: true }): { nth(index: number): { click(options: { timeout: number }): Promise<void>; fill(value: string, options: { timeout: number }): Promise<void> } };
};

type AriaRole = "button" | "link" | "checkbox" | "radio" | "tab" | "menuitem" | "option" | "switch" | "textbox" | "searchbox" | "combobox";

const ROLES = new Set<string>(["button", "link", "checkbox", "radio", "tab", "menuitem", "option", "switch", "textbox", "searchbox", "combobox"]);

export class PlaywrightBrowserDriver implements BrowserDriver {
  private browser: LaunchedBrowser | null = null;
  private launching: Promise<LaunchedBrowser> | null = null;
  private readonly operationTimeoutMs: number;

  constructor(operationTimeoutMs: number) {
    this.operationTimeoutMs = operationTimeoutMs;
  }

  async openIsolated(allow: (url: string) => boolean): Promise<IsolatedPage> {
    const browser = await this.launch();
    const context = await browser.newContext();
    context.setDefaultTimeout(this.operationTimeoutMs);
    context.setDefaultNavigationTimeout(this.operationTimeoutMs);
    await context.route("**/*", (route) => {
      const request = route.request();
      if (!request.isNavigationRequest() || request.url() === "about:blank" || allow(request.url())) return route.continue();
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    return new PlaywrightPage(context, page, this.operationTimeoutMs);
  }

  async close(): Promise<void> {
    const pending = this.launching;
    if (pending) {
      try {
        this.browser = await pending;
      } catch {
        this.browser = null;
      }
    }
    const browser = this.browser;
    this.browser = null;
    this.launching = null;
    if (browser) await browser.close().catch(() => undefined);
  }

  private launch(): Promise<LaunchedBrowser> {
    if (this.browser) return Promise.resolve(this.browser);
    if (!this.launching) {
      this.launching = loadChromium().then((browser) => {
        this.browser = browser;
        return browser;
      }).catch((error: unknown) => {
        this.launching = null;
        throw error;
      });
    }
    return this.launching;
  }
}

class PlaywrightPage implements IsolatedPage {
  private readonly context: LaunchedContext;
  private readonly page: LaunchedPage;
  private readonly operationTimeoutMs: number;

  constructor(context: LaunchedContext, page: LaunchedPage, operationTimeoutMs: number) {
    this.context = context;
    this.page = page;
    this.operationTimeoutMs = operationTimeoutMs;
  }

  async goto(url: string, signal: AbortSignal): Promise<{ url: string; title: string }> {
    await raceSignal(this.page.goto(url, { timeout: this.operationTimeoutMs + 1_000, waitUntil: "domcontentloaded" }), signal);
    return { url: this.page.url(), title: await this.page.title() };
  }

  async elements(signal: AbortSignal): Promise<PageElement[]> {
    const snapshot = await raceSignal(this.page.locator("body").ariaSnapshot(), signal);
    return parseAriaSnapshot(snapshot);
  }

  async click(target: ElementTarget, signal: AbortSignal): Promise<void> {
    const role = asRole(target.role);
    const locator = this.page.getByRole(role, { name: target.name, exact: true }).nth(target.nth);
    await raceSignal(locator.click({ timeout: this.operationTimeoutMs + 1_000 }), signal);
  }

  async fill(target: ElementTarget, value: string, signal: AbortSignal): Promise<void> {
    const role = asRole(target.role);
    const locator = this.page.getByRole(role, { name: target.name, exact: true }).nth(target.nth);
    await raceSignal(locator.fill(value, { timeout: this.operationTimeoutMs + 1_000 }), signal);
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
  }
}

function asRole(role: string): AriaRole {
  if (!ROLES.has(role)) throw new Error("That element cannot be used.");
  return role as AriaRole;
}

async function loadChromium(): Promise<LaunchedBrowser> {
  try {
    // Loaded only when a session opens so Event Scout still starts when Chromium is not installed.
    const imported = await import("playwright-core");
    const playwright = imported as unknown as { chromium: { launch(options: { headless: true }): Promise<LaunchedBrowser> } };
    return await playwright.chromium.launch({ headless: true });
  } catch {
    console.error("Browser worker could not launch Chromium.");
    throw new Error("The browser could not be started.");
  }
}

function raceSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("timed out"));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new Error("timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
