import type { BrowserSessionView, BrowserTaskEvent } from "../../shared/browser.ts";
import type { BrowserDriver, IsolatedPage } from "./driver.ts";
import { checkNavigationUrl } from "./policy.ts";
import { assignRefs, publicElements, type AssignedElement } from "./refs.ts";
import { BrowserStore, type StoredSession } from "./store.ts";

const CLICK_ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "option", "switch"]);
const FILL_ROLES = new Set(["textbox", "searchbox", "combobox"]);

export type BrowserOutcome =
  | { kind: "json"; httpStatus: number; body: unknown }
  | { kind: "events"; events: BrowserTaskEvent[] };

type LivePage = {
  page: IsolatedPage;
  elements: AssignedElement[];
};

type WorkerOptions = {
  driver: BrowserDriver;
  store: BrowserStore;
  allowHosts: readonly string[];
  operationTimeoutMs: number;
  sessionTtlMs: number;
  maxSessions: number;
  now: () => number;
};

export class BrowserWorker {
  private readonly pages = new Map<string, LivePage>();
  private readonly options: WorkerOptions;
  private tail: Promise<void> = Promise.resolve();
  private opening = 0;
  private stopped = false;

  constructor(options: WorkerOptions) {
    this.options = options;
    this.options.store.expireRunning(this.options.now(), "Browser session ended because the worker restarted.");
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
    return this.exclusive(async () => {
      await this.sweepInner();
      const owned = this.owned(ownerId, sessionId);
      if (!owned.ok) return owned.outcome;
      if (owned.session.status === "open") return this.eventsOnly(owned.session, "Session is not paused.", "error");
      if (owned.session.status !== "paused") return terminal(owned.session);
      this.options.store.setRunningStatus(owned.session.id, "open", this.now());
      return this.eventsOnly(owned.session, "Browser session resumed.", "status");
    });
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
    const checked = checkNavigationUrl(rawUrl, this.options.allowHosts);
    if (!checked.ok) return json(400, { error: checked.error });
    if (taskId) {
      const task = this.options.store.task(taskId);
      if (!task || task.ownerId !== ownerId) return json(404, { error: "That task was not found." });
    }
    if (this.liveCount() >= this.options.maxSessions) {
      return json(429, { error: "Too many browser sessions are open. Close one and try again." });
    }
    this.opening += 1;
    let page: IsolatedPage | null = null;
    let sessionId: string | null = null;
    const events: BrowserTaskEvent[] = [];
    try {
      page = await this.options.driver.openIsolated((candidate) => checkNavigationUrl(candidate, this.options.allowHosts).ok);
      const session = this.options.store.openSession({
        ownerId,
        taskId,
        now: this.now(),
        ttlMs: this.options.sessionTtlMs,
      });
      sessionId = session.id;
      this.pages.set(session.id, { page, elements: [] });
      events.push(this.note(session, "Browser session started.", "status"));
      await this.navigateInner(session.id, checked.url, events);
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
    const checked = checkNavigationUrl(rawUrl, this.options.allowHosts);
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
    const finalCheck = checkNavigationUrl(landed.url, this.options.allowHosts);
    if (!finalCheck.ok) {
      events.push(...await this.finish(sessionId, "failed", "Navigation left the allowlist and the session was closed.", "error"));
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
    const now = this.now();
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
    return {
      id: session.id,
      taskId: session.taskId,
      status: session.status,
      taskStatus: task?.status ?? "closed",
      url: session.url,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
    };
  }

  private liveCount(): number {
    return this.options.store.live().length + this.opening;
  }

  private now(): number {
    return this.options.now();
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run, run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
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
  return error instanceof Error && error.message === "timed out";
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
