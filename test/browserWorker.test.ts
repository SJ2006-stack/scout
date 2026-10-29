import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { BrowserSessionView, BrowserTaskEvent } from "../src/shared/browser.ts";
import { parseAriaSnapshot } from "../src/server/browser/aria.ts";
import type { BrowserDriver, ElementTarget, IsolatedPage, PageElement } from "../src/server/browser/driver.ts";
import { checkNavigationUrl, hostAllowed } from "../src/server/browser/policy.ts";
import { assignRefs } from "../src/server/browser/refs.ts";
import { BrowserStore } from "../src/server/browser/store.ts";
import { BrowserWorker } from "../src/server/browser/worker.ts";
import { parseSse, withApi } from "./helpers.ts";

const SECRET_FILL = "storage-secret-value";
const SECRET_COOKIE = "secret-cookie-value";

describe("browser worker", () => {
  it("parses accessible controls and allowlist hosts", () => {
    const elements = parseAriaSnapshot([
      "- banner:",
      "  - heading \"Events\" [level=1]",
      "  - link \"Home\"",
      "  - button \"Continue\"",
      "  - textbox \"Notes\"",
      "  - button \"Continue\"",
    ].join("\n"));
    assert.deepEqual(elements, [
      { role: "link", name: "Home" },
      { role: "button", name: "Continue" },
      { role: "textbox", name: "Notes" },
      { role: "button", name: "Continue" },
    ]);
    const refs = assignRefs(elements);
    assert.equal(refs[1]?.nth, 0);
    assert.equal(refs[3]?.ref, "e4");
    assert.equal(refs[3]?.nth, 1);
    assert.equal(hostAllowed("www.example.com", ["example.com"]), true);
    assert.equal(hostAllowed("notexample.com", ["example.com"]), false);
    assert.equal(hostAllowed("example.com.evil.com", ["example.com"]), false);
    assert.equal(checkNavigationUrl("javascript:alert(1)", ["example.com"]).ok, false);
    assert.equal(checkNavigationUrl("https://user:pass@example.com/", ["example.com"]).ok, false);
  });

  it("keeps sessions isolated per owner and ignores a client session id", async () => {
    await withWorker({}, async ({ base, driver, file }) => {
      const health = await fetch(`${base}/api/health`);
      assert.equal(health.status, 200);
      const forgedOwner = "c".repeat(32);
      const forgedSession = "d".repeat(32);
      const first = await start(base, undefined, {
        url: "https://example.com/",
        sessionId: forgedSession,
        ownerId: forgedOwner,
      });
      const cookieA = sessionCookie(first);
      const opened = await first.text();
      assert.equal(opened.includes("event: status"), true);
      assert.equal(opened.includes("event: done"), true);
      const mine = lastDone(opened);
      assert.equal(mine.status, "open");
      assert.notEqual(mine.sessionId, forgedSession);
      assert.equal(driver.pages.length, 1);
      assert.equal(driver.allows[0]?.("https://evil.example/left"), false);
      assert.equal(driver.allows[0]?.("https://www.example.com/"), true);

      const second = await start(base, undefined, { url: "https://example.com/other" });
      const cookieB = sessionCookie(second);
      const other = lastDone(await second.text());
      assert.notEqual(cookieA, cookieB);
      assert.notEqual(mine.sessionId, other.sessionId);
      assert.notEqual(mine.taskId, other.taskId);
      assert.equal(driver.pages.length, 2);
      const pageA = driver.pages[0];
      const pageB = driver.pages[1];
      assert.ok(pageA && pageB);
      pageA.cookies.set("only-a", SECRET_COOKIE);
      assert.equal(pageB.cookies.get("only-a"), undefined);

      const attached = await start(base, cookieA, { url: "https://example.com/next", taskId: mine.taskId });
      const sameTask = lastDone(await attached.text());
      assert.equal(sameTask.taskId, mine.taskId);
      const stolenTask = await start(base, cookieB, { url: "https://example.com/", taskId: mine.taskId });
      assert.equal(stolenTask.status, 404);
      assert.equal(driver.pages.length, 3);

      const denied = await fetch(`${base}/api/browser/sessions/${mine.sessionId}`, {
        headers: { cookie: cookieB, "x-scout-session": ownerOf(cookieA) },
      });
      assert.equal(denied.status, 404);
      const ignoredHeader = await fetch(`${base}/api/browser/sessions/${mine.sessionId}`, {
        headers: { cookie: cookieA, "x-scout-session": forgedOwner },
      });
      assert.equal(ignoredHeader.status, 200);
      const status = (await ignoredHeader.json()) as { session: BrowserSessionView & { ownerId?: string; cookie?: string } };
      assert.equal(status.session.status, "open");
      assert.equal(status.session.url, "https://example.com/");
      assert.equal(status.session.ownerId, undefined);
      assertNoSecrets(JSON.stringify(status), [SECRET_COOKIE, forgedOwner, forgedSession]);

      const listed = await fetch(`${base}/api/browser/sessions`, { headers: { cookie: cookieA } });
      const list = (await listed.json()) as { sessions: BrowserSessionView[] };
      assert.equal(list.sessions.some((session) => session.id === other.sessionId), false);
      assert.equal(list.sessions.some((session) => session.id === mine.sessionId), true);

      const snapshot = await fetch(`${base}/api/browser/sessions/${mine.sessionId}/snapshot`, { headers: { cookie: cookieA } });
      const shot = (await snapshot.json()) as { elements: Array<{ ref: string; role: string }> };
      assert.equal(snapshot.status, 200);
      assert.equal(shot.elements[0]?.ref, "e1");
      assert.equal(shot.elements[0]?.role, "button");
      assertNoSecrets(JSON.stringify(shot), [SECRET_COOKIE]);
      const foreignShot = await fetch(`${base}/api/browser/sessions/${mine.sessionId}/snapshot`, {
        headers: { cookie: cookieB, "x-scout-session": ownerOf(cookieA) },
      });
      assert.equal(foreignShot.status, 404);

      const stored = readFileSync(file, "utf8");
      assert.equal(stored.includes(ownerOf(cookieA)), true);
      assertNoSecrets(stored, [SECRET_COOKIE, SECRET_FILL, forgedOwner, forgedSession]);
    });
  });

  it("rejects urls that are not allowlisted https pages", async () => {
    await withWorker({}, async ({ base, driver }) => {
      const rejected = [
        "http://example.com/",
        "javascript:alert(1)",
        "file:///etc/passwd",
        "https://user:pass@example.com/",
        "https://notexample.com/",
        "https://example.com.evil.com/",
        "https://evil.com/?next=https://example.com",
      ];
      for (const url of rejected) {
        const response = await start(base, undefined, { url });
        assert.equal(response.status, 400, url);
        const payload = (await response.json()) as { error: string };
        assert.equal(payload.error.length > 0, true);
      }
      const empty = await start(base, undefined, { url: "   " });
      assert.equal(empty.status, 400);
      assert.equal(driver.pages.length, 0);

      const allowed = await start(base, undefined, { url: "https://www.example.com/path" });
      const body = await allowed.text();
      assert.equal(allowed.status, 200);
      assert.equal(body.includes("Opened https://www.example.com/path"), true);
      assert.equal(lastDone(body).status, "open");
      assert.equal(driver.pages.length, 1);
    });
  });

  it("closes a session when navigation leaves the allowlist", async () => {
    await withWorker({}, async ({ base, driver, file }) => {
      const response = await start(base, undefined, { url: "https://example.com/bounce" });
      const cookie = sessionCookie(response);
      const body = await response.text();
      assert.equal(body.includes("Navigation left the allowlist and the session was closed."), true);
      assert.equal(body.includes("Opened "), false);
      const done = lastDone(body);
      assert.equal(done.status, "failed");
      assert.equal(driver.pages[0]?.closed, true);
      const status = await fetch(`${base}/api/browser/sessions/${done.sessionId}`, { headers: { cookie } });
      const payload = (await status.json()) as { session: BrowserSessionView };
      assert.equal(payload.session.status, "failed");
      assert.equal(payload.session.url, "");
      assert.equal(readFileSync(file, "utf8").includes("evil.example"), false);
    });
  });

  it("records a timeout and does not report the navigation as opened", async () => {
    await withWorker({ operationTimeoutMs: 80 }, async ({ base, driver }) => {
      const response = await start(base, undefined, { url: "https://example.com/hang" });
      const cookie = sessionCookie(response);
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.equal(body.includes("event: error"), true);
      assert.equal(body.includes("Navigation timed out and the session was closed."), true);
      assert.equal(body.includes("Opened "), false);
      const done = lastDone(body);
      assert.equal(done.status, "failed");
      assert.equal(driver.pages[0]?.closed, true);
      assert.equal(driver.pages[0]?.gotos.length, 1);
      const click = await act(base, cookie, done.sessionId, "click", { ref: "e1" });
      assert.equal(click.status, 409);
      const failure = (await click.json()) as { error: string };
      assert.equal(failure.error, "That browser session has failed.");
    });
  });

  it("pauses work, resumes it, and keeps typed text out of the log", async () => {
    await withWorker({}, async ({ base, driver, file }) => {
      const response = await start(base, undefined, { url: "https://example.com/" });
      const cookie = sessionCookie(response);
      const opened = lastDone(await response.text());
      const page = driver.pages[0];
      assert.ok(page);

      const paused = await act(base, cookie, opened.sessionId, "pause");
      const pausedBody = await paused.text();
      assert.equal(pausedBody.includes("Browser session paused."), true);
      assert.equal(lastDone(pausedBody).status, "paused");
      const whilePaused = await fetch(`${base}/api/browser/sessions/${opened.sessionId}`, { headers: { cookie } });
      const pausedStatus = (await whilePaused.json()) as { session: BrowserSessionView };
      assert.equal(pausedStatus.session.status, "paused");
      assert.equal(pausedStatus.session.taskStatus, "paused");

      const blocked = await act(base, cookie, opened.sessionId, "navigate", { url: "https://example.com/next" });
      const blockedBody = await blocked.text();
      assert.equal(blockedBody.includes("Session is paused."), true);
      assert.equal(page.gotos.length, 1);
      const blockedFill = await act(base, cookie, opened.sessionId, "fill", { ref: "e2", value: SECRET_FILL });
      assert.equal((await blockedFill.text()).includes("Session is paused."), true);
      assert.deepEqual(page.fills, []);
      const blockedClick = await act(base, cookie, opened.sessionId, "click", { ref: "e1" });
      assert.equal((await blockedClick.text()).includes("Session is paused."), true);
      assert.deepEqual(page.clicks, []);

      const resumed = await act(base, cookie, opened.sessionId, "resume");
      assert.equal((await resumed.text()).includes("Browser session resumed."), true);
      const logged: unknown[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(args);
      };
      let filledBody = "";
      try {
        const filled = await act(base, cookie, opened.sessionId, "fill", { ref: "e2", value: SECRET_FILL });
        filledBody = await filled.text();
      } finally {
        console.error = original;
      }
      assert.deepEqual(page.fills, [SECRET_FILL]);
      assert.equal(filledBody.includes("The field could not be filled."), true);
      assert.equal(filledBody.includes(SECRET_FILL), false);
      assert.equal(JSON.stringify(logged).includes(SECRET_FILL), false);
      const history = await fetch(`${base}/api/browser/tasks/${opened.taskId}/events`, { headers: { cookie } });
      const historyBody = await history.text();
      assert.equal(history.status, 200);
      assert.equal(historyBody.includes("event: status"), true);
      assert.equal(historyBody.includes(SECRET_FILL), false);
      assertNoSecrets(readFileSync(file, "utf8"), [SECRET_FILL, SECRET_COOKIE]);

      const clicked = await act(base, cookie, opened.sessionId, "click", { ref: "e1" });
      assert.equal((await clicked.text()).includes("Clicked a button."), true);
      assert.deepEqual(page.clicks, ["Continue"]);
      const missing = await act(base, cookie, opened.sessionId, "click", { ref: "e9" });
      assert.equal((await missing.text()).includes("That element is not on the page."), true);
      assert.deepEqual(page.clicks, ["Continue"]);

      const moved = await act(base, cookie, opened.sessionId, "navigate", { url: "https://example.com/next" });
      assert.equal((await moved.text()).includes("Opened https://example.com/next"), true);
      assert.equal(page.gotos.length, 2);
      const after = await fetch(`${base}/api/browser/sessions/${opened.sessionId}`, { headers: { cookie } });
      const running = (await after.json()) as { session: BrowserSessionView };
      assert.equal(running.session.status, "open");
      assert.equal(running.session.taskStatus, "running");
      assert.equal(running.session.url, "https://example.com/next");
    });
  });

  it("expires a session when the clock passes its deadline", async () => {
    await withWorker({ sessionTtlMs: 1_000, nowStart: 5_000_000 }, async ({ base, driver, file, setNow }) => {
      const response = await start(base, undefined, { url: "https://example.com/" });
      const cookie = sessionCookie(response);
      const opened = lastDone(await response.text());
      const other = await start(base, undefined, { url: "https://example.com/other" });
      const cookieB = sessionCookie(other);
      await other.text();
      setNow(5_001_000);
      const status = await fetch(`${base}/api/browser/sessions/${opened.sessionId}`, { headers: { cookie } });
      const payload = (await status.json()) as { session: BrowserSessionView };
      assert.equal(status.status, 200);
      assert.equal(payload.session.status, "expired");
      assert.equal(payload.session.taskStatus, "expired");
      assert.equal(driver.pages[0]?.closed, true);
      const click = await act(base, cookie, opened.sessionId, "click", { ref: "e1" });
      assert.equal(click.status, 409);
      const hidden = await fetch(`${base}/api/browser/sessions/${opened.sessionId}`, { headers: { cookie: cookieB } });
      assert.equal(hidden.status, 404);
      const events = await fetch(`${base}/api/browser/tasks/${opened.taskId}/events`, { headers: { cookie } });
      const replay = await events.text();
      assert.equal(replay.includes("Browser session expired."), true);
      assert.equal(driver.pages.every((page) => page.closed), true);
      assertNoSecrets(readFileSync(file, "utf8"), [SECRET_COOKIE, SECRET_FILL]);
    });
  });

  it("expires a live session when a new worker takes the store", async () => {
    await withWorker({}, async ({ base, driver, store }) => {
      const response = await start(base, undefined, { url: "https://example.com/" });
      const cookie = sessionCookie(response);
      const opened = lastDone(await response.text());
      assert.equal(driver.pages[0]?.closed, false);
      const restarted = new BrowserWorker({
        driver: new FakeDriver(),
        store,
        allowHosts: ["example.com"],
        operationTimeoutMs: 1_000,
        sessionTtlMs: 60_000,
        maxSessions: 4,
        now: () => 1_000_000,
      });
      try {
        const status = await fetch(`${base}/api/browser/sessions/${opened.sessionId}`, { headers: { cookie } });
        const payload = (await status.json()) as { session: BrowserSessionView };
        assert.equal(payload.session.status, "expired");
        assert.equal(payload.session.taskStatus, "expired");
        assert.equal(driver.pages[0]?.closed, true);
        const activity = await (await fetch(`${base}/api/browser/tasks/${opened.taskId}/events`, { headers: { cookie } })).text();
        assert.equal(activity.includes("Browser session ended because the worker restarted."), true);
        assert.equal(activity.includes(SECRET_COOKIE), false);
      } finally {
        await restarted.stop();
      }
    });
  });

  it("stops opening sessions at the configured cap", async () => {
    await withWorker({ maxSessions: 1 }, async ({ base, driver }) => {
      const first = await start(base, undefined, { url: "https://example.com/" });
      const cookie = sessionCookie(first);
      await first.text();
      const second = await start(base, cookie, { url: "https://example.com/next" });
      assert.equal(second.status, 429);
      assert.equal(driver.pages.length, 1);
    });
  });

  it("stays off when no worker is configured", async () => {
    await withApi({}, async (base) => {
      const response = await fetch(`${base}/api/browser/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-scout-session": "a".repeat(32) },
        body: JSON.stringify({ url: "https://example.com/" }),
      });
      assert.equal(response.status, 503);
      const payload = (await response.json()) as { error: string };
      assert.equal(payload.error, "Browser worker is not enabled on this server.");
    });
  });
});

class FakePage implements IsolatedPage {
  url = "";
  title = "";
  closed = false;
  cookies = new Map<string, string>();
  clicks: string[] = [];
  fills: string[] = [];
  gotos: string[] = [];
  private readonly allow: (url: string) => boolean;

  constructor(allow: (url: string) => boolean) {
    this.allow = allow;
  }

  async goto(url: string, signal: AbortSignal): Promise<{ url: string; title: string }> {
    this.gotos.push(url);
    if (url.includes("/hang")) {
      await new Promise<never>((_, reject) => {
        const fail = (): void => reject(new Error("timed out"));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      });
    }
    const finalUrl = url.includes("/bounce") ? "https://evil.example/left" : url;
    void this.allow(finalUrl);
    this.url = finalUrl;
    this.title = "Example";
    this.cookies.set("session", SECRET_COOKIE);
    return { url: finalUrl, title: this.title };
  }

  async elements(signal: AbortSignal): Promise<PageElement[]> {
    if (signal.aborted) throw new Error("timed out");
    return [
      { role: "button", name: "Continue" },
      { role: "textbox", name: "Notes" },
    ];
  }

  async click(target: ElementTarget, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("timed out");
    this.clicks.push(target.name);
  }

  async fill(_target: ElementTarget, value: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("timed out");
    this.fills.push(value);
    if (value === SECRET_FILL) throw new Error(`could not fill ${value}`);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeDriver implements BrowserDriver {
  pages: FakePage[] = [];
  allows: Array<(url: string) => boolean> = [];

  async openIsolated(allow: (url: string) => boolean): Promise<IsolatedPage> {
    this.allows.push(allow);
    const page = new FakePage(allow);
    this.pages.push(page);
    return page;
  }

  async close(): Promise<void> {}
}

async function withWorker(
  options: { operationTimeoutMs?: number; sessionTtlMs?: number; maxSessions?: number; nowStart?: number },
  run: (context: {
    base: string;
    driver: FakeDriver;
    file: string;
    store: BrowserStore;
    setNow: (value: number) => void;
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "scout-browser-"));
  const file = join(dir, "sessions.json");
  const driver = new FakeDriver();
  const store = new BrowserStore(file);
  let now = options.nowStart ?? 1_000_000;
  const worker = new BrowserWorker({
    driver,
    store,
    allowHosts: ["example.com"],
    operationTimeoutMs: options.operationTimeoutMs ?? 1_000,
    sessionTtlMs: options.sessionTtlMs ?? 60_000,
    maxSessions: options.maxSessions ?? 4,
    now: () => now,
  });
  try {
    await withApi({ browser: worker, now: () => now }, async (base) => {
      await run({ base, driver, file, store, setNow: (value) => { now = value; } });
    });
  } finally {
    await worker.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

function start(base: string, cookie: string | undefined, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return fetch(`${base}/api/browser/sessions`, { method: "POST", headers, body: JSON.stringify(body) });
}

function act(base: string, cookie: string, id: string, action: string, body?: unknown): Promise<Response> {
  return fetch(`${base}/api/browser/sessions/${id}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function lastDone(body: string): BrowserTaskEvent & { type: "done" } {
  const done = parseSse<BrowserTaskEvent>(body).findLast((event) => event.type === "done");
  if (!done || done.type !== "done") throw new Error("missing done event");
  return done;
}

function sessionCookie(response: Response): string {
  const lines = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
  const pair = lines.map((line) => line.split(";")[0] ?? "").find((line) => line.startsWith("scout_session="));
  if (!pair) throw new Error("missing session cookie");
  return pair;
}

function ownerOf(cookie: string): string {
  return cookie.slice("scout_session=".length);
}

function assertNoSecrets(text: string, secrets: string[]): void {
  for (const secret of secrets) assert.equal(text.includes(secret), false, secret);
}
