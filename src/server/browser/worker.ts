import { randomBytes } from "node:crypto";
import type { BrowserSessionView, BrowserTaskEvent } from "../../shared/browser.ts";
import type { BrowserDriver, IsolatedPage } from "./driver.ts";
import { admit, describeBudget, idleSessionIds, sessionHost, type AdmissionLimits, type BudgetReport } from "./budget.ts";
import { allowBrowserRequest, checkNavigationUrl } from "./policy.ts";
import { attendListing, cheapestOffer, readShelf, registerControl, shelfSummary, SHOP_SITES, type AttendResult, type ShopRun } from "./shelf.ts";
import { attemptSignIn, SIGN_IN_CODE_MESSAGE, type AccountLogin } from "./signIn.ts";
import type { UserDirectory } from "../db/userDirectory.ts";
import { registrable, type SessionVault } from "./sessionVault.ts";
import { skillForHost } from "./skills.ts";
import { assignRefs, publicElements, type AssignedElement } from "./refs.ts";
import { BrowserStore, type StoredSession } from "./store.ts";

const CLICK_ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "option", "switch"]);
const FILL_ROLES = new Set(["textbox", "searchbox", "combobox"]);
const REGISTER_STEP_MS = 30_000;
const SHOP_STEP_MS = 25_000;
const GENERIC_SIGNED_IN = /sign[\s-]?out|log[\s-]?out|my account|my orders/i;

export type BrowserOutcome =
  | { kind: "json"; httpStatus: number; body: unknown }
  | { kind: "events"; events: BrowserTaskEvent[] };

type LivePage = {
  page: IsolatedPage;
  elements: AssignedElement[];
  headed: boolean;
};

type PendingCode = {
  token: string;
  ownerId: string;
  sessionId: string;
  expiresAt: number;
};

type WorkerOptions = {
  driver: BrowserDriver;
  store: BrowserStore;
  vault: SessionVault | null;
  canShowWindow: boolean;
  operationTimeoutMs: number;
  sessionTtlMs: number;
  maxSessions: number;
  maxLanes?: number;
  allowedHosts: readonly string[] | null;
  directory?: UserDirectory | null;
  now: () => number;
  limits?: AdmissionLimits;
  rssMb?: () => number;
  idleMs?: number;
};

type Note = { text: string | null };

export function startBrowserWarm(browser: { warm(): Promise<void> } | null | undefined): void {
  if (!browser) return;
  void browser.warm().catch((error: unknown) => {
    console.error(`Browser warm failed: ${error instanceof Error ? error.message : "unknown"}`);
  });
}

export class BrowserWorker {
  private readonly pages = new Map<string, LivePage>();
  private readonly codes = new Map<string, PendingCode>();
  private readonly revoked = new Set<string>();
  private readonly options: WorkerOptions;
  private tail: Promise<void> = Promise.resolve();
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly attending = new Map<string, Promise<AttendResult | null>>();
  private readonly waiting: Array<() => void> = [];
  private active = 0;
  private opening = 0;
  private stopped = false;

  constructor(options: WorkerOptions) {
    this.options = options;
    this.options.store.expireRunning(this.options.now(), "Browser session ended because the worker restarted.");
  }

  warm(): Promise<void> {
    return this.options.driver.warm?.() ?? Promise.resolve();
  }

  budget(): BudgetReport {
    return describeBudget({
      sessions: this.options.store.live().map((session) => ({ ownerId: session.ownerId, url: session.url })),
      rssMb: this.measuredRss(),
      limits: this.options.limits ?? null,
      idleMs: this.options.idleMs ?? null,
    });
  }

  startCleanup(intervalMs: number): () => void {
    const timer = setInterval(() => {
      void this.sweep();
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    return () => clearInterval(timer);
  }

  sweep(): Promise<void> {
    return this.exclusive(() => this.sweepInner());
  }

  async stop(): Promise<void> {
    await this.exclusive(async () => {
      this.stopped = true;
      for (const sessionId of [...this.pages.keys()]) {
        await this.finish(sessionId, "closed", "Browser session closed.", "status");
      }
      await this.options.driver.close();
    });
  }

  create(ownerId: string, rawUrl: string, taskId: string | null): Promise<BrowserOutcome> {
    return this.exclusive(() => this.createInner(ownerId, rawUrl, taskId));
  }

  list(ownerId: string): Promise<BrowserOutcome> {
    return this.exclusive(async () => {
      await this.sweepInner();
      return json(200, { sessions: this.options.store.list(ownerId).map((session) => this.view(session)) });
    });
  }

  status(ownerId: string, sessionId: string): Promise<BrowserOutcome> {
    return this.exclusive(async () => {
      await this.sweepInner();
      const owned = this.owned(ownerId, sessionId);
      if (!owned.ok) return owned.outcome;
      return json(200, { session: this.view(this.options.store.session(sessionId) ?? owned.session) });
    });
  }

  eventsFor(ownerId: string, taskId: string): Promise<BrowserOutcome> {
    return this.exclusive(async () => {
      await this.sweepInner();
      const task = this.options.store.task(taskId);
      if (!task || task.ownerId !== ownerId) return json(404, { error: "That task was not found." });
      return { kind: "events", events: this.options.store.events(taskId) };
    });
  }

  navigate(ownerId: string, sessionId: string, rawUrl: string): Promise<BrowserOutcome> {
    return this.exclusive(() => this.navigateRequest(ownerId, sessionId, rawUrl));
  }

  openFromPhone(rawUrl: string): Promise<BrowserOutcome> {
    return this.exclusive(() => this.openFromPhoneInner(rawUrl));
  }

  readHtml(rawUrl: string, parent?: AbortSignal, ownerId?: string): Promise<{ ok: true; html: string } | { ok: false; message: string }> {
    return this.slot(() => this.readHtmlInner(rawUrl, parent, ownerId));
  }

  compareShop(query: string, parent?: AbortSignal, ownerId?: string, onStatus?: (message: string) => void): Promise<ShopRun> {
    return this.lane(ownerId, () => this.compareShopInner(query, parent, ownerId, onStatus));
  }

  collectPay(pageUrl: string, title: string, merchant: string, parent?: AbortSignal, ownerId?: string): Promise<AttendResult | null> {
    const key = `${ownerId ?? ""}\0${pageUrl}`;
    const running = this.attending.get(key);
    if (running) return running;
    const started = this.lane(ownerId, () => this.collectPayInner(pageUrl, title, merchant, parent, ownerId))
      .finally(() => this.attending.delete(key));
    this.attending.set(key, started);
    return started;
  }

  submitOwnerCode(ownerId: string, code: string): Promise<BrowserOutcome> {
    return this.exclusive(() => this.submitOwnerCodeInner(ownerId, code));
  }

  snapshot(ownerId: string, sessionId: string): Promise<BrowserOutcome> {
    return this.exclusive(() => this.snapshotInner(ownerId, sessionId));
  }

  click(ownerId: string, sessionId: string, ref: string): Promise<BrowserOutcome> {
    return this.exclusive(() => this.clickInner(ownerId, sessionId, ref));
  }

  fill(ownerId: string, sessionId: string, ref: string, value: string): Promise<BrowserOutcome> {
    return this.exclusive(() => this.fillInner(ownerId, sessionId, ref, value));
  }

  pause(ownerId: string, sessionId: string): Promise<BrowserOutcome> {
    return this.exclusive(async () => {
      await this.sweepInner();
      const owned = this.owned(ownerId, sessionId);
      if (!owned.ok) return owned.outcome;
      if (owned.session.status === "paused") return this.eventsOnly(owned.session, "Browser session paused.", "status");
      if (owned.session.status !== "open") return terminal(owned.session);
      this.options.store.setRunningStatus(owned.session.id, "paused", this.now());
      return this.eventsOnly(owned.session, "Browser session paused.", "status");
    });
  }

  resume(ownerId: string, sessionId: string): Promise<BrowserOutcome> {
    return this.exclusive(() => this.resumeInner(ownerId, sessionId));
  }

  handoff(ownerId: string, sessionId: string): Promise<BrowserOutcome> {
    return this.exclusive(() => this.handoffInner(ownerId, sessionId));
  }

  submitCode(taskId: string, token: string, code: string): Promise<BrowserOutcome> {
    return this.exclusive(() => this.submitCodeInner(taskId, token, code));
  }

  profile(ownerId: string): Promise<BrowserOutcome> {
    return this.exclusive(async () => {
      this.options.vault?.expireDue();
      return json(200, { profile: this.options.vault?.status(ownerId) ?? { state: "absent", expiresAt: null } });
    });
  }

  revokeProfile(ownerId: string): Promise<BrowserOutcome> {
    return this.exclusive(() => this.revokeInner(ownerId));
  }

  close(ownerId: string, sessionId: string): Promise<BrowserOutcome> {
    return this.exclusive(async () => {
      await this.sweepInner();
      const owned = this.owned(ownerId, sessionId);
      if (!owned.ok) return owned.outcome;
      if (owned.session.status !== "open" && owned.session.status !== "paused") return terminal(owned.session);
      return { kind: "events", events: await this.finish(owned.session.id, "closed", "Browser session closed.", "status") };
    });
  }

  private async createInner(ownerId: string, rawUrl: string, taskId: string | null): Promise<BrowserOutcome> {
    if (this.stopped) return json(503, { error: "Browser worker is not enabled on this server." });
    await this.sweepInner();
    const checked = this.checkedUrl(rawUrl);
    if (!checked.ok) return json(400, { error: checked.error });
    if (taskId) {
      const task = this.options.store.task(taskId);
      if (!task || task.ownerId !== ownerId) return json(404, { error: "That task was not found." });
    }
    if (this.liveCount() >= this.options.maxSessions) {
      return json(429, { error: "Too many browser sessions are open. Close one and try again." });
    }
    if (this.options.limits) {
      const decision = admit({
        ownerId,
        host: sessionHost(checked.url),
        live: this.options.store.live().map((session) => ({ ownerId: session.ownerId, host: sessionHost(session.url) })),
        rssMb: this.measuredRss(),
        limits: this.options.limits,
      });
      if (!decision.ok) return json(429, { error: decision.reason });
    }
    this.opening += 1;
    let page: IsolatedPage | null = null;
    let sessionId: string | null = null;
    const events: BrowserTaskEvent[] = [];
    try {
      const headed = this.options.canShowWindow;
      page = await this.options.driver.openIsolated({
        allow: (candidate) => this.permit(candidate),
        storageState: this.savedFor(ownerId, [checked.url]),
        headed,
      });
      const session = this.options.store.openSession({
        ownerId,
        taskId,
        now: this.now(),
        ttlMs: this.options.sessionTtlMs,
      });
      sessionId = session.id;
      this.pages.set(session.id, { page, elements: [], headed });
      events.push(this.note(session, "Browser session started.", "status"));
      await this.navigateInner(session.id, checked.url, events);
      const current = this.options.store.session(session.id);
      if (headed && current?.status === "open") {
        const token = this.ensureToken(session);
        events.push(this.note(session, "The browser window is on your screen.", "status"));
        events.push(this.note(session, `Phone token: ${token}.`, "status"));
      }
      return { kind: "events", events };
    } catch {
      await closeQuiet(page);
      if (sessionId) {
        this.pages.delete(sessionId);
        events.push(...await this.finish(sessionId, "failed", "The browser could not be started.", "error"));
        return { kind: "events", events };
      }
      return json(503, { error: "The browser could not be started." });
    } finally {
      this.opening -= 1;
    }
  }

  private async openFromPhoneInner(rawUrl: string): Promise<BrowserOutcome> {
    await this.sweepInner();
    const checked = this.checkedUrl(rawUrl);
    if (!checked.ok) return json(400, { error: checked.error });
    const live = this.options.store.live();
    if (live.length === 0) return json(404, { error: "Start a browser session on the computer first." });
    if (live.length > 1) return json(409, { error: "Close the extra browser sessions first." });
    const session = live[0];
    if (!session) return json(404, { error: "Start a browser session on the computer first." });
    if (session.status === "paused") this.options.store.setRunningStatus(session.id, "open", this.now());
    const events: BrowserTaskEvent[] = [];
    await this.navigateInner(session.id, checked.url, events);
    return { kind: "events", events };
  }

  private async readHtmlInner(rawUrl: string, parent?: AbortSignal, ownerId?: string): Promise<{ ok: true; html: string } | { ok: false; message: string }> {
    if (parent?.aborted) return { ok: false, message: "Search stopped." };
    if (this.stopped) return { ok: false, message: "Browser worker is not enabled on this server." };
    const checked = this.checkedUrl(rawUrl);
    if (!checked.ok) return { ok: false, message: checked.error };
    let page: IsolatedPage | null = null;
    let held = false;
    try {
      page = await this.options.driver.openIsolated({
        allow: (candidate) => this.permit(candidate),
        headed: false,
        lean: true,
        storageState: this.savedFor(ownerId, [checked.url]),
      });
      const opened = page;
      const landed = await withTimeout(this.options.operationTimeoutMs, (signal) => opened.goto(checked.url, linkSignal(signal, parent)));
      const finalCheck = this.checkedUrl(landed.url);
      if (!finalCheck.ok) return { ok: false, message: "Navigation did not stay on an https page." };
      const account = this.loginFor(ownerId);
      if (account) {
        const signed = await attemptSignIn(opened, account, (run) => withTimeout(this.options.operationTimeoutMs, (signal) => run(linkSignal(signal, parent))));
        if (signed === "code") {
          held = this.holdForCode(ownerId ?? "", opened, finalCheck.url);
          if (held) return { ok: false, message: SIGN_IN_CODE_MESSAGE };
        }
        if (signed === "saved") await this.captureProfile(ownerId ?? "", opened);
      }
      const html = await withTimeout(this.options.operationTimeoutMs, (signal) => opened.html(linkSignal(signal, parent)));
      return { ok: true, html };
    } catch (error) {
      if (parent?.aborted) return { ok: false, message: "Search stopped." };
      return { ok: false, message: isTimeout(error) ? "The page timed out." : "The page could not be opened." };
    } finally {
      if (!held) await page?.close();
    }
  }

  private async compareShopInner(query: string, parent?: AbortSignal, ownerId?: string, onStatus?: (message: string) => void): Promise<ShopRun> {
    const needle = query.trim();
    const empty: ShopRun = { offers: [], cheapest: null, pay: null, summary: "The browser worker could not open Blinkit, Zepto, or Instamart.", signIn: null };
    if (needle.length < 2) return { ...empty, summary: "Tell Scout an item to look up." };
    if (parent?.aborted || this.stopped) return { ...empty, summary: shelfSummary([]) };
    const note: Note = { text: null };
    onStatus?.("Opening Blinkit, Zepto, and Instamart together.");
    const shelves = await Promise.all(SHOP_SITES.map(async (site) => {
      const siteNote: Note = { text: null };
      const shelf = await this.withPage(parent, ownerId, null, siteNote, async (page, step) => readShelf(page, needle, site.merchant, step), SHOP_STEP_MS, false);
      if (siteNote.text) note.text = siteNote.text;
      if (shelf) onStatus?.(shelf.offers.length > 0 ? `${site.merchant} showed ${shelf.offers.length} prices.` : `${site.merchant} showed no price.`);
      return shelf;
    }));
    const opened = shelves.filter((shelf) => shelf != null);
    const run = { offers: opened.flatMap((shelf) => shelf.offers), opened: opened.length, needsLocation: opened.some((shelf) => shelf.needsLocation) };
    if (!run || run.opened === 0) {
      return { ...empty, summary: note.text ?? empty.summary };
    }
    const cheapest = cheapestOffer(run.offers);
    const pay = null;
    const summary = run.offers.length === 0 && run.needsLocation
      ? "Blinkit, Zepto, and Instamart opened, but they need a delivery location before they show a price."
      : shelfSummary(run.offers);
    return { offers: run.offers, cheapest, pay, summary, signIn: note.text };
  }

  private async collectPayInner(pageUrl: string, title: string, merchant: string, parent?: AbortSignal, ownerId?: string): Promise<AttendResult | null> {
    if (parent?.aborted || this.stopped) return null;
    const checked = this.checkedUrl(pageUrl);
    if (!checked.ok) return null;
    const note: Note = { text: null };
    const result = await this.withPage(parent, ownerId, checked.url, note, async (page, step) => attendListing(page, checked.url, merchant, title, this.loginFor(ownerId), step), REGISTER_STEP_MS);
    if (result) return result;
    if (note.text) return { pay: null, message: note.text };
    return { pay: null, message: "The browser worker could not open the registration." };
  }

  private async withPage<T>(parent: AbortSignal | undefined, ownerId: string | undefined, startUrl: string | null, note: Note, run: (page: IsolatedPage, step: <R>(work: (signal: AbortSignal) => Promise<R>) => Promise<R>) => Promise<T>, timeoutMs = this.options.operationTimeoutMs, signIn = true): Promise<T | null> {
    if (this.stopped) return null;
    let page: IsolatedPage | null = null;
    let held = false;
    try {
      page = await this.options.driver.openIsolated({
        allow: (candidate) => this.permit(candidate),
        headed: false,
        lean: true,
        storageState: this.savedFor(ownerId, startUrl ? [startUrl] : SHOP_SITES.map((site) => site.home)),
      });
      const opened = page;
      const step = <R>(work: (signal: AbortSignal) => Promise<R>): Promise<R> =>
        withTimeout(timeoutMs, (signal) => work(linkSignal(signal, parent)));
      if (startUrl) await step((signal) => opened.goto(startUrl, signal));
      const account = signIn ? this.loginFor(ownerId) : null;
      const openedElements = account ? await step((signal) => opened.elements(signal)).catch(() => []) : [];
      if (account && !registerControl(openedElements)) {
        try {
          const signed = await attemptSignIn(opened, account, step);
          if (signed === "code") {
            const location = await step((signal) => opened.location(signal));
            held = this.holdForCode(ownerId ?? "", opened, location.url);
            if (held) note.text = SIGN_IN_CODE_MESSAGE;
            return null;
          }
          if (signed === "saved" && ownerId) await this.captureProfile(ownerId, opened);
        } catch (error) {
          if (!isTimeout(error)) throw error;
        }
      }
      return await run(opened, step);
    } catch (error) {
      note.text = pageFailure(error);
      return null;
    } finally {
      if (!held) await page?.close();
    }
  }

  private async navigateRequest(ownerId: string, sessionId: string, rawUrl: string): Promise<BrowserOutcome> {
    await this.sweepInner();
    const ready = await this.ready(ownerId, sessionId);
    if (!ready.ok) return ready.outcome;
    const events: BrowserTaskEvent[] = [];
    await this.navigateInner(ready.session.id, rawUrl, events);
    return { kind: "events", events };
  }

  private async navigateInner(sessionId: string, rawUrl: string, events: BrowserTaskEvent[]): Promise<void> {
    const session = this.options.store.session(sessionId);
    if (!session) return;
    const checked = this.checkedUrl(rawUrl);
    if (!checked.ok) {
      events.push(this.note(session, checked.error, "error"));
      events.push(this.keep(this.done(session.id)));
      return;
    }
    const live = this.pages.get(sessionId);
    if (!live) {
      events.push(...await this.finish(sessionId, "failed", "The browser session is not running.", "error"));
      return;
    }
    let landed: { url: string; title: string };
    try {
      landed = await withTimeout(this.options.operationTimeoutMs, (signal) => live.page.goto(checked.url, signal));
    } catch (error) {
      const message = isTimeout(error) ? "Navigation timed out and the session was closed." : "The page could not be opened.";
      events.push(...await this.finish(sessionId, "failed", message, "error"));
      return;
    }
    const finalCheck = this.checkedUrl(landed.url);
    if (!finalCheck.ok) {
      events.push(...await this.finish(sessionId, "failed", "Navigation did not stay on an https page and the session was closed.", "error"));
      return;
    }
    const title = clip(landed.title, 180);
    this.options.store.updateOpen(sessionId, { url: finalCheck.url, title }, this.now());
    events.push(this.note(session, `Opened ${finalCheck.url}.`, "status"));
    try {
      const assigned = assignRefs(await withTimeout(this.options.operationTimeoutMs, (signal) => live.page.elements(signal)));
      live.elements = assigned;
      const current = this.options.store.session(sessionId);
      events.push(this.keep({
        type: "snapshot",
        taskId: session.taskId,
        sessionId,
        url: finalCheck.url,
        title: current?.title ?? title,
        elements: publicElements(assigned),
      }));
    } catch (error) {
      if (isTimeout(error)) {
        events.push(...await this.finish(sessionId, "failed", "The browser operation timed out and the session was closed.", "error"));
        return;
      }
      events.push(this.note(session, "The page snapshot could not be read.", "error"));
    }
    await this.captureProfile(session.ownerId, live.page);
    events.push(this.keep(this.done(sessionId)));
  }

  private async snapshotInner(ownerId: string, sessionId: string): Promise<BrowserOutcome> {
    await this.sweepInner();
    const owned = this.owned(ownerId, sessionId);
    if (!owned.ok) return owned.outcome;
    if (owned.session.status !== "open" && owned.session.status !== "paused") return terminal(owned.session);
    const live = this.pages.get(sessionId);
    if (!live) {
      await this.finish(sessionId, "expired", "Browser session ended because the worker restarted.", "status");
      return json(409, { error: "That browser session has expired." });
    }
    try {
      const assigned = assignRefs(await withTimeout(this.options.operationTimeoutMs, (signal) => live.page.elements(signal)));
      live.elements = assigned;
      this.note(owned.session, "Read the page snapshot.", "status");
      const session = this.options.store.session(sessionId) ?? owned.session;
      return json(200, { session: this.view(session), elements: publicElements(assigned) });
    } catch (error) {
      if (isTimeout(error)) {
        await this.finish(sessionId, "failed", "The browser operation timed out and the session was closed.", "error");
        return json(504, { error: "The browser operation timed out and the session was closed." });
      }
      return json(502, { error: "The page snapshot could not be read." });
    }
  }

  private async clickInner(ownerId: string, sessionId: string, ref: string): Promise<BrowserOutcome> {
    await this.sweepInner();
    const ready = await this.ready(ownerId, sessionId);
    if (!ready.ok) return ready.outcome;
    const element = ready.live.elements.find((item) => item.ref === ref);
    if (!element) return this.eventsOnly(ready.session, "That element is not on the page.", "error");
    if (!CLICK_ROLES.has(element.role)) return this.eventsOnly(ready.session, "That element cannot be clicked.", "error");
    try {
      await withTimeout(this.options.operationTimeoutMs, (signal) => ready.live.page.click(element, signal));
    } catch (error) {
      if (isTimeout(error)) {
        return { kind: "events", events: await this.finish(sessionId, "failed", "The browser operation timed out and the session was closed.", "error") };
      }
      return this.eventsOnly(ready.session, "That element could not be clicked.", "error");
    }
    return this.eventsOnly(ready.session, `Clicked a ${element.role}.`, "status");
  }

  private async fillInner(ownerId: string, sessionId: string, ref: string, value: string): Promise<BrowserOutcome> {
    await this.sweepInner();
    const ready = await this.ready(ownerId, sessionId);
    if (!ready.ok) return ready.outcome;
    const element = ready.live.elements.find((item) => item.ref === ref);
    if (!element) return this.eventsOnly(ready.session, "That element is not on the page.", "error");
    if (!FILL_ROLES.has(element.role)) return this.eventsOnly(ready.session, "That element cannot be filled.", "error");
    try {
      // The typed value reaches the page only. It is not written to the session store, events, or logs.
      await withTimeout(this.options.operationTimeoutMs, (signal) => ready.live.page.fill(element, value, signal));
    } catch (error) {
      if (isTimeout(error)) {
        return { kind: "events", events: await this.finish(sessionId, "failed", "The browser operation timed out and the session was closed.", "error") };
      }
      return this.eventsOnly(ready.session, "The field could not be filled.", "error");
    }
    return this.eventsOnly(ready.session, "Filled a field.", "status");
  }

  private async handoffInner(ownerId: string, sessionId: string): Promise<BrowserOutcome> {
    await this.sweepInner();
    const owned = this.owned(ownerId, sessionId);
    if (!owned.ok) return owned.outcome;
    if (owned.session.status === "paused") return this.eventsOnly(owned.session, "The browser window is already waiting.", "status");
    if (owned.session.status !== "open") return terminal(owned.session);
    if (!this.options.canShowWindow) return this.eventsOnly(owned.session, "This host cannot open a browser window.", "error");
    const live = this.pages.get(sessionId);
    if (!live) {
      return { kind: "events", events: await this.finish(sessionId, "expired", "Browser session ended because the worker restarted.", "status") };
    }
    if (!live.headed) {
      const swapped = await this.showWindow(owned.session, live);
      if (!swapped.ok) return this.eventsOnly(owned.session, swapped.error, "error");
    }
    this.options.store.setRunningStatus(sessionId, "paused", this.now());
    const token = this.ensureToken(owned.session);
    return this.eventsOnly(owned.session, `The browser window is open for this task. Phone token: ${token}.`, "status");
  }

  private async showWindow(session: StoredSession, live: LivePage): Promise<{ ok: true } | { ok: false; error: string }> {
    let opened: IsolatedPage | null = null;
    try {
      const state = await withTimeout(this.options.operationTimeoutMs, (signal) => live.page.storageState(signal));
      opened = await this.options.driver.openIsolated({
        allow: (candidate) => this.permit(candidate),
        storageState: state,
        headed: true,
      });
      if (session.url.length > 0) {
        const landed = await withTimeout(Math.max(this.options.operationTimeoutMs, 45_000), (signal) => opened?.goto(session.url, signal) ?? Promise.reject(new Error("closed")));
        if (!landed || !this.checkedUrl(landed.url).ok) {
          await closeQuiet(opened);
          return { ok: false, error: "Navigation did not stay on an https page and the window was not opened." };
        }
      }
    } catch (error) {
      if (opened && isTimeout(error)) {
        await closeQuiet(live.page);
        this.pages.set(session.id, { page: opened, elements: live.elements, headed: true });
        return { ok: true };
      }
      console.error("Browser window handoff failed.");
      await closeQuiet(opened);
      return { ok: false, error: isTimeout(error) ? "The browser window timed out before the page finished loading." : "The browser window could not be opened." };
    }
    if (!opened) return { ok: false, error: "The browser window could not be opened." };
    await closeQuiet(live.page);
    this.pages.set(session.id, { page: opened, elements: live.elements, headed: true });
    return { ok: true };
  }

  private async resumeInner(ownerId: string, sessionId: string): Promise<BrowserOutcome> {
    await this.sweepInner();
    const owned = this.owned(ownerId, sessionId);
    if (!owned.ok) return owned.outcome;
    if (owned.session.status === "open") return this.eventsOnly(owned.session, "Session is not paused.", "error");
    if (owned.session.status !== "paused") return terminal(owned.session);
    const live = this.pages.get(sessionId);
    if (!live) {
      return { kind: "events", events: await this.finish(sessionId, "expired", "Browser session ended because the worker restarted.", "status") };
    }
    let landed: { url: string; title: string };
    try {
      landed = await withTimeout(this.options.operationTimeoutMs, (signal) => live.page.location(signal));
    } catch (error) {
      if (isTimeout(error)) {
        return { kind: "events", events: await this.finish(sessionId, "failed", "The browser operation timed out and the session was closed.", "error") };
      }
      return this.eventsOnly(owned.session, "The page could not be read.", "error");
    }
    const finalCheck = this.checkedUrl(landed.url);
    if (!finalCheck.ok) {
      return { kind: "events", events: await this.finish(sessionId, "failed", "Navigation did not stay on an https page and the session was closed.", "error") };
    }
    this.options.store.setRunningStatus(sessionId, "open", this.now());
    this.options.store.updateOpen(sessionId, { url: finalCheck.url, title: clip(landed.title, 180) }, this.now());
    await this.captureProfile(ownerId, live.page);
    const events: BrowserTaskEvent[] = [this.note(owned.session, "Browser session resumed.", "status")];
    try {
      const assigned = assignRefs(await withTimeout(this.options.operationTimeoutMs, (signal) => live.page.elements(signal)));
      live.elements = assigned;
      const current = this.options.store.session(sessionId);
      events.push(this.keep({
        type: "snapshot",
        taskId: owned.session.taskId,
        sessionId,
        url: finalCheck.url,
        title: current?.title ?? clip(landed.title, 180),
        elements: publicElements(assigned),
      }));
    } catch (error) {
      if (isTimeout(error)) {
        return { kind: "events", events: await this.finish(sessionId, "failed", "The browser operation timed out and the session was closed.", "error") };
      }
      events.push(this.note(owned.session, "The page snapshot could not be read.", "error"));
    }
    events.push(this.keep(this.done(sessionId)));
    return { kind: "events", events };
  }

  private async submitCodeInner(taskId: string, token: string, code: string): Promise<BrowserOutcome> {
    await this.sweepInner();
    const pending = this.codes.get(taskId);
    if (!pending || pending.token !== token || this.now() >= pending.expiresAt) {
      return json(404, { error: "That browser task is not waiting for a code." });
    }
    const owned = this.owned(pending.ownerId, pending.sessionId);
    if (!owned.ok) {
      return json(404, { error: "That browser task is not waiting for a code." });
    }
    if (owned.session.status !== "open" && owned.session.status !== "paused") {
      return json(409, { error: "That browser session is no longer open." });
    }
    const live = this.pages.get(pending.sessionId);
    if (!live) return json(404, { error: "That browser task is not waiting for a code." });
    try {
      const assigned = assignRefs(await withTimeout(this.options.operationTimeoutMs, (signal) => live.page.elements(signal)));
      live.elements = assigned;
    } catch (error) {
      if (isTimeout(error)) {
        return json(504, { error: "The page could not be read in time. Try the code again." });
      }
      return json(502, { error: "The page snapshot could not be read." });
    }
    const field = codeField(live.elements);
    if (!field) return json(409, { error: "The page has no single code field yet." });
    try {
      await withTimeout(this.options.operationTimeoutMs, (signal) => live.page.fill(field, code, signal));
    } catch (error) {
      if (isTimeout(error)) {
        this.codes.delete(taskId);
        return { kind: "events", events: await this.finish(pending.sessionId, "failed", "The browser operation timed out and the session was closed.", "error") };
      }
      return this.eventsOnly(owned.session, "The field could not be filled.", "error");
    }
    this.codes.delete(taskId);
    await this.captureProfile(pending.ownerId, live.page);
    return this.eventsOnly(owned.session, "Filled a field.", "status");
  }

  private async submitOwnerCodeInner(ownerId: string, code: string): Promise<BrowserOutcome> {
    if (!/^\d{4,8}$/.test(code)) return json(400, { error: "Send the numeric code from the message." });
    const pending = [...this.codes.values()].find((item) => item.ownerId === ownerId && this.now() < item.expiresAt);
    if (!pending) return json(404, { error: "Scout is not waiting for a sign-in code." });
    const taskId = [...this.codes.entries()].find((entry) => entry[1] === pending)?.[0];
    if (!taskId) return json(404, { error: "Scout is not waiting for a sign-in code." });
    return this.submitCodeInner(taskId, pending.token, code);
  }

  private loginFor(ownerId: string | undefined): AccountLogin | null {
    if (!ownerId) return null;
    const account = this.options.directory?.account(ownerId) ?? null;
    if (!account) return null;
    return { email: account.email, phone: account.phone, name: account.name };
  }

  private holdForCode(ownerId: string, page: IsolatedPage, url: string): boolean {
    if (!ownerId || this.liveCount() >= this.options.maxSessions) return false;
    const checked = this.checkedUrl(url);
    if (!checked.ok) return false;
    const session = this.options.store.openSession({
      ownerId,
      taskId: null,
      now: this.now(),
      ttlMs: this.options.sessionTtlMs,
    });
    this.pages.set(session.id, { page, elements: [], headed: false });
    this.options.store.updateOpen(session.id, { url: checked.url, title: "Sign in" }, this.now());
    this.ensureToken(session);
    return true;
  }

  private async revokeInner(ownerId: string): Promise<BrowserOutcome> {
    this.revoked.add(ownerId);
    this.options.vault?.revoke(ownerId);
    this.rememberProfile(ownerId);
    const events: BrowserTaskEvent[] = [];
    for (const session of this.options.store.live()) {
      if (session.ownerId !== ownerId) continue;
      events.push(...await this.finish(session.id, "closed", "Saved sign-in was revoked and the session was closed.", "status"));
    }
    this.revoked.delete(ownerId);
    if (events.length > 0) return { kind: "events", events };
    return json(200, { profile: this.options.vault?.status(ownerId) ?? { state: "absent", expiresAt: null } });
  }

  private async captureProfile(ownerId: string, page: IsolatedPage): Promise<void> {
    const vault = this.options.vault;
    if (!vault || this.revoked.has(ownerId)) return;
    try {
      const where = await withTimeout(this.options.operationTimeoutMs, (signal) => page.location(signal));
      const host = new URL(where.url).hostname;
      const elements = await withTimeout(this.options.operationTimeoutMs, (signal) => page.elements(signal));
      const signedIn = skillForHost(host)?.login.signedIn ?? GENERIC_SIGNED_IN;
      const verified = elements.some((element) => signedIn.test(element.name));
      const state = await withTimeout(this.options.operationTimeoutMs, (signal) => page.storageState(signal));
      vault.save(ownerId, host, state, verified);
      this.rememberProfile(ownerId);
    } catch {
      // Keep the previous saved sign-in when the page cannot be read.
    }
  }

  private async ready(ownerId: string, sessionId: string): Promise<{ ok: true; session: StoredSession; live: LivePage } | { ok: false; outcome: BrowserOutcome }> {
    const owned = this.owned(ownerId, sessionId);
    if (!owned.ok) return owned;
    if (owned.session.status === "paused") return { ok: false, outcome: this.eventsOnly(owned.session, "Session is paused.", "error") };
    if (owned.session.status !== "open") return { ok: false, outcome: terminal(owned.session) };
    const live = this.pages.get(sessionId);
    if (!live) {
      const events = await this.finish(sessionId, "expired", "Browser session ended because the worker restarted.", "status");
      return { ok: false, outcome: { kind: "events", events } };
    }
    return { ok: true, session: owned.session, live };
  }

  private async sweepInner(): Promise<void> {
    this.options.vault?.expireDue();
    const now = this.now();
    const idleMs = this.options.idleMs;
    if (idleMs != null) {
      const idleIds = idleSessionIds(this.options.store.live(), now, idleMs);
      for (const sessionId of idleIds) {
        await this.finish(sessionId, "closed", "Browser session was idle.", "status");
      }
    }
    for (const session of this.options.store.live()) {
      if (now < session.expiresAt) continue;
      await this.finish(session.id, "expired", "Browser session expired.", "status");
    }
    for (const sessionId of [...this.pages.keys()]) {
      const session = this.options.store.session(sessionId);
      if (session && (session.status === "open" || session.status === "paused")) continue;
      const live = this.pages.get(sessionId);
      this.pages.delete(sessionId);
      await closeQuiet(live?.page);
    }
  }

  private async finish(sessionId: string, status: "closed" | "expired" | "failed", message: string, level: "status" | "error"): Promise<BrowserTaskEvent[]> {
    const session = this.options.store.session(sessionId);
    const live = this.pages.get(sessionId);
    this.pages.delete(sessionId);
    if (session) this.codes.delete(session.taskId);
    if (live && session && (session.status === "open" || session.status === "paused")) {
      await this.captureProfile(session.ownerId, live.page);
    }
    await closeQuiet(live?.page);
    if (!session || (session.status !== "open" && session.status !== "paused")) return [];
    this.options.store.mark(sessionId, status, this.now());
    const updated = this.options.store.session(sessionId);
    const events: BrowserTaskEvent[] = [
      level === "error"
        ? { type: "error", taskId: session.taskId, sessionId, message }
        : { type: "status", taskId: session.taskId, sessionId, message },
      { type: "done", taskId: session.taskId, sessionId, status: updated?.status ?? status },
    ];
    for (const event of events) this.options.store.addEvent(event, this.now());
    return events;
  }

  private owned(ownerId: string, sessionId: string): { ok: true; session: StoredSession } | { ok: false; outcome: BrowserOutcome } {
    const session = this.options.store.session(sessionId);
    if (!session || session.ownerId !== ownerId) return { ok: false, outcome: json(404, { error: "That browser session was not found." }) };
    return { ok: true, session };
  }

  private eventsOnly(session: StoredSession, message: string, level: "status" | "error"): BrowserOutcome {
    return {
      kind: "events",
      events: [this.note(session, message, level), this.keep(this.done(session.id))],
    };
  }

  private note(session: StoredSession, message: string, level: "status" | "error"): BrowserTaskEvent {
    const event: BrowserTaskEvent = level === "error"
      ? { type: "error", taskId: session.taskId, sessionId: session.id, message }
      : { type: "status", taskId: session.taskId, sessionId: session.id, message };
    this.options.store.addEvent(event, this.now());
    return event;
  }

  private keep(event: BrowserTaskEvent): BrowserTaskEvent {
    this.options.store.addEvent(event, this.now());
    return event;
  }

  private done(sessionId: string): BrowserTaskEvent {
    const session = this.options.store.session(sessionId);
    return {
      type: "done",
      taskId: session?.taskId ?? "",
      sessionId,
      status: session?.status ?? "failed",
    };
  }

  private view(session: StoredSession): BrowserSessionView {
    const task = this.options.store.task(session.taskId);
    const pending = this.codes.get(session.taskId);
    const phoneToken = pending && pending.sessionId === session.id && this.now() < pending.expiresAt ? pending.token : null;
    return {
      id: session.id,
      taskId: session.taskId,
      status: session.status,
      taskStatus: task?.status ?? "closed",
      url: session.url,
      title: session.title,
      phoneToken,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
    };
  }

  private ensureToken(session: StoredSession): string {
    const existing = this.codes.get(session.taskId);
    if (existing && existing.sessionId === session.id && existing.ownerId === session.ownerId && this.now() < existing.expiresAt) {
      return existing.token;
    }
    const token = randomBytes(16).toString("hex");
    const remaining = Math.max(0, session.expiresAt - this.now());
    this.codes.set(session.taskId, {
      token,
      ownerId: session.ownerId,
      sessionId: session.id,
      expiresAt: this.now() + Math.min(10 * 60 * 1000, remaining),
    });
    return token;
  }

  private liveCount(): number {
    return this.options.store.live().length + this.opening;
  }

  private measuredRss(): number {
    const read = this.options.rssMb;
    if (!read) return 0;
    const value = read();
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  private now(): number {
    return this.options.now();
  }

  private savedFor(ownerId: string | undefined, urls: readonly string[]): unknown {
    if (!ownerId || !this.options.vault) return undefined;
    const domains = urls.flatMap((url) => {
      try {
        return [registrable(new URL(url).hostname)];
      } catch {
        return [];
      }
    });
    return this.options.vault.loadFor(ownerId, domains) ?? undefined;
  }

  private rememberProfile(ownerId: string): void {
    const status = this.options.vault?.status(ownerId);
    if (!status) return;
    this.options.directory?.setProfile(ownerId, status, this.now());
  }

  private checkedUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
    return checkNavigationUrl(raw, this.options.allowedHosts);
  }

  private permit(raw: string): boolean {
    return allowBrowserRequest(raw, this.options.allowedHosts);
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run, run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private lane<T>(ownerId: string | undefined, run: () => Promise<T>): Promise<T> {
    const key = ownerId ?? "anonymous";
    const previous = this.lanes.get(key) ?? Promise.resolve();
    const result = previous.then(() => this.slot(run), () => this.slot(run));
    const tail = result.then(() => undefined, () => undefined);
    this.lanes.set(key, tail);
    void tail.then(() => {
      if (this.lanes.get(key) === tail) this.lanes.delete(key);
    });
    return result;
  }

  private async slot<T>(run: () => Promise<T>): Promise<T> {
    const limit = Math.max(1, this.options.maxLanes ?? 3);
    while (this.active >= limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await run();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

function codeField(elements: readonly AssignedElement[]): AssignedElement | undefined {
  const fields = elements.filter((item) => FILL_ROLES.has(item.role));
  const named = fields.filter((item) => /code|otp|pin|passcode|verification/i.test(item.name));
  if (named.length === 1) return named[0];
  if (fields.length === 1) return fields[0];
  return undefined;
}

function terminal(session: StoredSession): BrowserOutcome {
  switch (session.status) {
    case "open":
    case "paused":
      return json(409, { error: "That browser session is still open." });
    case "closed":
      return json(409, { error: "That browser session is closed." });
    case "expired":
      return json(409, { error: "That browser session has expired." });
    case "failed":
      return json(409, { error: "That browser session has failed." });
    default: {
      const neverStatus: never = session.status;
      return neverStatus;
    }
  }
}

function json(httpStatus: number, body: unknown): BrowserOutcome {
  return { kind: "json", httpStatus, body };
}

function clip(value: string, max: number): string {
  const clean = value.replace(/[\u0000-\u001f]/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.message === "timed out" || /timeout/i.test(error.message));
}

function pageFailure(error: unknown): string {
  const message = error instanceof Error ? error.message.replace(/\s+/g, " ").trim() : "";
  if (isTimeout(error)) {
    console.error(`Browser step timed out.${message.length > 0 ? ` ${message.slice(0, 180)}` : ""}`);
    return "The browser worker timed out opening that page.";
  }
  if (message === "The browser could not be started.") return "The browser could not be started on the server.";
  if (message.length > 0) return `The browser worker could not open the registration. ${message.slice(0, 160)}`;
  return "The browser worker could not open the registration.";
}

function linkSignal(timeout: AbortSignal, parent?: AbortSignal): AbortSignal {
  if (!parent) return timeout;
  return AbortSignal.any([timeout, parent]);
}

function withTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let settled = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(new Error("timed out"));
    }, timeoutMs);
    run(controller.signal).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(isTimeout(error) || controller.signal.aborted ? new Error("timed out") : error);
      },
    );
  });
}

async function closeQuiet(page: IsolatedPage | null | undefined): Promise<void> {
  if (!page) return;
  try {
    await page.close();
  } catch {
    // The page is already gone.
  }
}
