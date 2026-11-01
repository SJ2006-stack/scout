import { paymentTarget } from "../../shared/payLink.ts";
import { parseAriaSnapshot } from "./aria.ts";
import { chromiumContextProfile, chromiumLaunchOptions, type ChromiumContextProfile, type ChromiumLaunchOptions } from "./chromiumLaunch.ts";
import type { BrowserDriver, ElementTarget, IsolatedOpen, IsolatedPage, PageElement } from "./driver.ts";
import { isPageLocalUrl, rememberedPublicHost, type HostVerdictCache } from "./policy.ts";

type LaunchedBrowser = {
  newContext(options?: Partial<ChromiumContextProfile> & { storageState?: unknown; geolocation?: { latitude: number; longitude: number }; permissions?: string[]; proxy?: { server: string; username: string; password: string } }): Promise<LaunchedContext>;
  version(): string;
  close(): Promise<void>;
};

type LaunchedContext = {
  route(pattern: string, handler: (route: LaunchedRoute) => Promise<unknown> | unknown): Promise<void>;
  newPage(): Promise<LaunchedPage>;
  close(): Promise<void>;
  setDefaultTimeout(timeout: number): void;
  setDefaultNavigationTimeout(timeout: number): void;
  storageState(): Promise<unknown>;
};

type LaunchedRoute = {
  request(): { url(): string; isNavigationRequest(): boolean; resourceType(): string };
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
};

type LaunchedPage = {
  goto(url: string, options: { timeout: number; waitUntil: "domcontentloaded" }): Promise<unknown>;
  content(): Promise<string>;
  url(): string;
  title(): Promise<string>;
  locator(selector: string): { ariaSnapshot(): Promise<string> };
  getByRole(role: AriaRole, options: { name: string; exact: true }): { nth(index: number): { click(options: { timeout: number }): Promise<void>; fill(value: string, options: { timeout: number }): Promise<void> } };
  getByText(text: string): { nth(index: number): { click(options: { timeout: number }): Promise<void> } };
  screenshot(options: { type: "png" }): Promise<Buffer>;
  evaluate(run: () => void): Promise<void>;
};

type AriaRole = "button" | "link" | "checkbox" | "radio" | "tab" | "menuitem" | "option" | "switch" | "textbox" | "searchbox" | "combobox";

const ACTION_TIMEOUT_MS = 10_000;
const LEAN_SKIP = new Set(["image", "font", "media"]);
const ROLES = new Set<string>(["button", "link", "checkbox", "radio", "tab", "menuitem", "option", "switch", "textbox", "searchbox", "combobox"]);

export class PlaywrightBrowserDriver implements BrowserDriver {
  private readonly browsers = new Map<boolean, LaunchedBrowser>();
  private readonly launching = new Map<boolean, Promise<LaunchedBrowser>>();
  private readonly hostCache: HostVerdictCache = new Map();
  private readonly hostLookups = new Map<string, Promise<boolean>>();
  private readonly operationTimeoutMs: number;
  private readonly publicOnly: boolean;

  /** publicOnly is false only in tests that drive a local fixture site. */
  constructor(operationTimeoutMs: number, options: { publicOnly?: boolean } = {}) {
    this.operationTimeoutMs = operationTimeoutMs;
    this.publicOnly = options.publicOnly !== false;
  }

  async warm(): Promise<void> {
    const browser = await this.launch(false);
    const context = await browser.newContext(chromiumContextProfile(browser.version()));
    try {
      const page = await context.newPage();
      await page.goto("about:blank", { timeout: this.operationTimeoutMs, waitUntil: "domcontentloaded" });
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  async openIsolated(options: IsolatedOpen): Promise<IsolatedPage> {
    const headed = options.headed === true;
    const browser = await this.launch(headed);
    const context = await browser.newContext({
      ...chromiumContextProfile(browser.version()),
      ...(options.storageState === undefined ? {} : { storageState: options.storageState }),
      ...(options.geolocation ? { geolocation: options.geolocation, permissions: ["geolocation"] } : {}),
      ...(options.proxy ? { proxy: options.proxy } : {}),
    });
    context.setDefaultTimeout(this.operationTimeoutMs);
    context.setDefaultNavigationTimeout(this.operationTimeoutMs);
    const payments: string[] = [];
    await context.route("**/*", async (route) => {
      const target = route.request().url();
      if (options.lean === true && !headed && LEAN_SKIP.has(route.request().resourceType())) {
        await route.abort("blockedbyclient");
        return;
      }
      const payment = paymentTarget(target);
      if (payment) {
        payments.push(payment);
        await route.abort("blockedbyclient");
        return;
      }
      if (isPageLocalUrl(target)) {
        await route.continue();
        return;
      }
      let hostname = "";
      try {
        hostname = new URL(target).hostname;
      } catch {
        await route.abort("blockedbyclient");
        return;
      }
      if (!options.allow(target) || (this.publicOnly && !(await rememberedPublicHost(hostname, this.hostCache, this.hostLookups, Date.now())))) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    return new PlaywrightPage(context, page, this.operationTimeoutMs, payments);
  }

  async close(): Promise<void> {
    const pending = [...this.launching.values()];
    for (const launch of pending) {
      try {
        await launch;
      } catch {
        // A failed launch leaves no browser to close.
      }
    }
    const browsers = [...this.browsers.values()];
    this.browsers.clear();
    this.launching.clear();
    for (const browser of browsers) await browser.close().catch(() => undefined);
  }

  private launch(headed: boolean): Promise<LaunchedBrowser> {
    const existing = this.browsers.get(headed);
    if (existing) return Promise.resolve(existing);
    const pending = this.launching.get(headed);
    if (pending) return pending;
    const launch = loadChromium(headed).then((browser) => {
      this.browsers.set(headed, browser);
      return browser;
    }).catch((error: unknown) => {
      this.launching.delete(headed);
      throw error;
    });
    this.launching.set(headed, launch);
    return launch;
  }
}

class PlaywrightPage implements IsolatedPage {
  private readonly context: LaunchedContext;
  private readonly page: LaunchedPage;
  private readonly operationTimeoutMs: number;
  private readonly payments: string[];

  constructor(context: LaunchedContext, page: LaunchedPage, operationTimeoutMs: number, payments: string[]) {
    this.context = context;
    this.page = page;
    this.operationTimeoutMs = operationTimeoutMs;
    this.payments = payments;
  }

  async goto(url: string, signal: AbortSignal): Promise<{ url: string; title: string }> {
    await raceSignal(this.page.goto(url, { timeout: this.operationTimeoutMs + 1_000, waitUntil: "domcontentloaded" }), signal);
    return this.location(signal);
  }

  async location(signal: AbortSignal): Promise<{ url: string; title: string }> {
    const title = await raceSignal(this.page.title(), signal);
    return { url: this.page.url(), title };
  }

  async html(signal: AbortSignal): Promise<string> {
    return raceSignal(this.page.content(), signal);
  }

  async elements(signal: AbortSignal): Promise<PageElement[]> {
    await raceSignal(this.page.evaluate(unhideModalBody), signal).catch(() => undefined);
    const snapshot = await raceSignal(this.page.locator("body").ariaSnapshot(), signal);
    return parseAriaSnapshot(snapshot);
  }

  async click(target: ElementTarget, signal: AbortSignal): Promise<void> {
    if (target.role === "text") {
      const lead = target.name.replace(/^(?:\S\s)+/, "").split(/\s+/).slice(0, 2).join(" ");
      await raceSignal(this.page.getByText(lead).nth(target.nth).click({ timeout: Math.min(this.operationTimeoutMs, ACTION_TIMEOUT_MS) }), signal);
      return;
    }
    const role = asRole(target.role);
    const locator = this.page.getByRole(role, { name: target.name, exact: true }).nth(target.nth);
    await raceSignal(locator.click({ timeout: Math.min(this.operationTimeoutMs, ACTION_TIMEOUT_MS) }), signal);
  }

  async fill(target: ElementTarget, value: string, signal: AbortSignal): Promise<void> {
    const role = asRole(target.role);
    const locator = this.page.getByRole(role, { name: target.name, exact: true }).nth(target.nth);
    await raceSignal(locator.fill(value, { timeout: Math.min(this.operationTimeoutMs, ACTION_TIMEOUT_MS) }), signal);
  }

  takePayment(): string | null {
    return this.payments.shift() ?? null;
  }

  async screenshot(signal: AbortSignal): Promise<Uint8Array> {
    const bytes = await raceSignal(this.page.screenshot({ type: "png" }), signal);
    return new Uint8Array(bytes);
  }

  async storageState(signal: AbortSignal): Promise<unknown> {
    return raceSignal(this.context.storageState(), signal);
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
  }
}

function asRole(role: string): AriaRole {
  if (!ROLES.has(role)) throw new Error("That element cannot be used.");
  return role as AriaRole;
}

async function loadChromium(headed: boolean): Promise<LaunchedBrowser> {
  try {
    // Loaded only when a session opens so Event Scout still starts when Chromium is not installed.
    const imported = await import("playwright-core");
    const playwright = imported as unknown as { chromium: { launch(options: ChromiumLaunchOptions): Promise<LaunchedBrowser> } };
    const options = chromiumLaunchOptions(headed);
    try {
      return await playwright.chromium.launch(options);
    } catch (error) {
      if (!options.channel) throw error;
      console.error("Full Chromium was not found. Falling back to the headless shell.");
      return await playwright.chromium.launch({ headless: options.headless, args: options.args });
    }
  } catch {
    console.error(headed ? "Browser worker could not open a visible Chromium window." : "Browser worker could not launch Chromium.");
    throw new Error(headed ? "The browser window could not be opened." : "The browser could not be started.");
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

/**
 * React Modal marks the whole body aria-hidden when its app element is unset, as on
 * Blinkit's login dialog. That hides the dialog's own phone box from the snapshot.
 */
function unhideModalBody(): void {
  const body = document.body;
  if (body.getAttribute("aria-hidden") === "true") body.removeAttribute("aria-hidden");
}
