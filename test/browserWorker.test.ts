import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { BrowserSessionView, BrowserTaskEvent } from "../src/shared/browser.ts";
import { parseAriaSnapshot } from "../src/server/browser/aria.ts";
import type { BrowserDriver, ElementTarget, IsolatedPage, PageElement } from "../src/server/browser/driver.ts";
import { chromiumLaunchOptions } from "../src/server/browser/chromiumLaunch.ts";
import { allowBrowserRequest, browserConfigFromEnv, browserHostIsPublic, browserRoleError, checkNavigationUrl, rememberedPublicHost } from "../src/server/browser/policy.ts";
import { assignRefs } from "../src/server/browser/refs.ts";
import { SessionVault } from "../src/server/browser/sessionVault.ts";
import { BrowserStore } from "../src/server/browser/store.ts";
import { BrowserWorker } from "../src/server/browser/worker.ts";
import { parseSse, withApi } from "./helpers.ts";

const SECRET_FILL = "storage-secret-value";
const SECRET_COOKIE = "secret-cookie-value";
const PROFILE_KEY = Buffer.from("ab".repeat(32), "hex");

describe("browser worker", () => {
  it("parses accessible controls and accepts any https site", async () => {
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
    assert.equal(checkNavigationUrl("https://notexample.com/").ok, true);
    const site = "--disable-blink-features=AutomationControlled";
    assert.deepEqual(chromiumLaunchOptions(false, {}), { headless: true, channel: "chromium", args: [site] });
    assert.deepEqual(chromiumLaunchOptions(true, { WEBSITE_SITE_NAME: "sj-event-scout" }), { headless: false, args: [site] });
    assert.deepEqual(chromiumLaunchOptions(false, { WEBSITE_SITE_NAME: "sj-event-scout" }), {
      headless: true,
      channel: "chromium",
      args: ["--no-sandbox", "--disable-dev-shm-usage", site],
    });
    assert.deepEqual(chromiumLaunchOptions(false, { SCOUT_CONTAINER: "1" }).args, ["--no-sandbox", "--disable-dev-shm-usage", site]);
    assert.equal(checkNavigationUrl("https://example.com.evil.com/").ok, true);
    assert.equal(checkNavigationUrl("javascript:alert(1)").ok, false);
    assert.equal(checkNavigationUrl("https://user:pass@example.com/").ok, false);
    assert.equal(checkNavigationUrl("https://127.0.0.1/").ok, false);
    assert.equal(checkNavigationUrl("https://169.254.169.254/latest").ok, false);
    assert.equal(checkNavigationUrl("https://metadata.google.internal/").ok, false);
    assert.equal(checkNavigationUrl("https://www.example.com/", ["example.com"]).ok, true);
    assert.equal(checkNavigationUrl("https://example.com.evil.com/", ["example.com"]).ok, false);
    assert.equal(allowBrowserRequest("http://cdn.example/logo.png"), false);
    assert.equal(allowBrowserRequest("wss://example.com/socket"), true);
    assert.equal(allowBrowserRequest("about:blank"), true);
    const listed = ["example.com"];
    assert.equal(checkNavigationUrl("https://luma.com/", listed).ok, false);
    const open = browserConfigFromEnv({ BROWSER_WORKER_ENABLED: "1", BROWSER_PROFILE_KEY: "ab".repeat(32), BROWSER_ALLOWED_HOSTS: "example.com" }, "/tmp");
    assert.equal(browserRoleError(open, "browser"), null);
    assert.equal(browserRoleError(browserConfigFromEnv({ BROWSER_WORKER_ENABLED: "1" }, "/tmp"), "browser")?.includes("BROWSER_PROFILE_KEY"), true);
    assert.equal(browserRoleError(open, "app"), null);
    assert.equal(await browserHostIsPublic("cdn.example", async () => [{ address: "93.184.216.34", family: 4 }]), true);
    assert.equal(await browserHostIsPublic("cdn.example", async () => [{ address: "169.254.169.254", family: 4 }]), false);
    assert.equal(await browserHostIsPublic("cdn.example", async () => {
      throw new Error("dns");
    }), false);
    const cache = new Map<string, { ok: boolean; expires: number }>();
    const inflight = new Map<string, Promise<boolean>>();
    const started = Date.now();
    assert.equal(await rememberedPublicHost("slow.example", cache, inflight, started, () => new Promise(() => undefined), 30), false);
    assert.ok(Date.now() - started < 500);
    let lookups = 0;
    const resolve = async () => {
      lookups += 1;
      return [{ address: "93.184.216.34" }];
    };
    assert.equal(await rememberedPublicHost("cdn.example", cache, inflight, started, resolve, 1_000), true);
    assert.equal(await rememberedPublicHost("cdn.example", cache, inflight, started + 1_000, resolve, 1_000), true);
    assert.equal(lookups, 1);
    assert.throws(() => browserConfigFromEnv({ BROWSER_ALLOWED_HOSTS: "127.0.0.1" }, "/tmp"), /cannot be opened/);
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
      assert.equal(driver.allows[0]?.("https://evil.example/left"), true);
      assert.equal(driver.allows[0]?.("http://example.com/"), false);
      assert.equal(driver.allows[0]?.("https://127.0.0.1/"), false);
      assert.equal(driver.allows[0]?.("http://169.254.169.254/"), false);

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

  it("rejects urls that are not https pages", async () => {
    await withWorker({}, async ({ base, driver }) => {
      const rejected = [
        "http://example.com/",
        "javascript:alert(1)",
        "file:///etc/passwd",
        "https://user:pass@example.com/",
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

      const allowed = await start(base, undefined, { url: "https://notexample.com/path" });
      const body = await allowed.text();
      assert.equal(allowed.status, 200);
      assert.equal(body.includes("Opened https://notexample.com/path"), true);
      assert.equal(lastDone(body).status, "open");
      assert.equal(driver.pages.length, 1);
    });
  });

  it("opens any https site and closes a session that lands off https", async () => {
    await withWorker({}, async ({ base, driver }) => {
      const opened = await start(base, undefined, { url: "https://example.com/bounce" });
      const openedBody = await opened.text();
      assert.equal(openedBody.includes("Opened https://evil.example/left"), true);
      assert.equal(lastDone(openedBody).status, "open");
      assert.equal(driver.pages[0]?.closed, false);

      const response = await start(base, undefined, { url: "https://example.com/drop-https" });
      const cookie = sessionCookie(response);
      const body = await response.text();
      assert.equal(body.includes("Navigation did not stay on an https page and the session was closed."), true);
      assert.equal(body.includes("Opened "), false);
      const done = lastDone(body);
      assert.equal(done.status, "failed");
      assert.equal(driver.pages[1]?.closed, true);
      const status = await fetch(`${base}/api/browser/sessions/${done.sessionId}`, { headers: { cookie } });
      const payload = (await status.json()) as { session: BrowserSessionView };
      assert.equal(payload.session.status, "failed");
      assert.equal(payload.session.url, "");
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
        vault: null,
        canShowWindow: false,
        operationTimeoutMs: 1_000,
        sessionTtlMs: 60_000,
        maxSessions: 4,
        allowedHosts: null,
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

  it("reuses an encrypted profile until it is revoked or expires", async () => {
    await withWorker({ profileTtlMs: 5_000 }, async ({ base, driver, file, profileDir, setNow }) => {
      const response = await start(base, undefined, { url: "https://example.com/" });
      const cookie = sessionCookie(response);
      const opened = lastDone(await response.text());
      assert.equal(driver.seeded[0], false);
      const closed = await act(base, cookie, opened.sessionId, "close");
      assert.equal(closed.status, 200);
      const saved = readdirSync(profileDir).filter((name) => name.endsWith(".bin"));
      assert.equal(saved.length, 1);
      const blob = readFileSync(join(profileDir, saved[0] ?? ""));
      assert.equal(blob.includes(SECRET_COOKIE), false);
      assert.equal(readFileSync(join(profileDir, "sites.json"), "utf8").includes(SECRET_COOKIE), false);
      assert.equal(readFileSync(file, "utf8").includes(SECRET_COOKIE), false);
      const listed = await fetch(`${base}/api/browser/profile`, { headers: { cookie } });
      const profile = (await listed.json()) as { profile: { state: string } };
      assert.equal(profile.profile.state, "saved");

      const again = await start(base, cookie, { url: "https://example.com/next" });
      await again.text();
      assert.equal(driver.seeded[1], true);
      const revoked = await fetch(`${base}/api/browser/profile/revoke`, { method: "POST", headers: { cookie } });
      assert.equal(revoked.status, 200);
      const after = await start(base, cookie, { url: "https://example.com/after" });
      await after.text();
      assert.equal(driver.seeded[2], false);

      const kept = await start(base, cookie, { url: "https://example.com/kept" });
      await kept.text();
      setNow(1_000_000 + 5_000);
      const gone = await fetch(`${base}/api/browser/profile`, { headers: { cookie } });
      const expiredProfile = (await gone.json()) as { profile: { state: string } };
      assert.equal(expiredProfile.profile.state, "expired");
      const expired = await start(base, cookie, { url: "https://example.com/expired" });
      await expired.text();
      assert.equal(driver.seeded.at(-1), false);
    });
  });

  it("opens a window for handoff and fills one code into the paused task", async () => {
    await withWorker({ canShowWindow: true }, async ({ base, driver, file }) => {
      const response = await start(base, undefined, { url: "https://example.com/" });
      const cookie = sessionCookie(response);
      const opened = lastDone(await response.text());
      const before = await fetch(`${base}/api/browser/sessions/${opened.sessionId}`, { headers: { cookie } });
      const beforePayload = (await before.json()) as { session: BrowserSessionView };
      assert.match(beforePayload.session.phoneToken ?? "", /^[a-f0-9]{32}$/);
      const handoff = await act(base, cookie, opened.sessionId, "handoff");
      const body = await handoff.text();
      assert.equal(body.includes("The browser window is open for this task."), true);
      assert.equal(body.includes(beforePayload.session.phoneToken ?? ""), true);
      assert.equal(lastDone(body).status, "paused");
      assert.equal(driver.headed.includes(true), true);
      const token = /Phone token: ([a-f0-9]{32})\./.exec(body)?.[1] ?? "";
      assert.equal(token.length, 32);
      const code = "91827364";
      const sent = await fetch(`${base}/api/browser/tasks/${opened.taskId}/code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, code }),
      });
      const sentBody = await sent.text();
      assert.equal(sent.status, 200);
      assert.equal(sentBody.includes("Filled a field."), true);
      assert.equal(sentBody.includes(code), false);
      assert.equal(driver.pages.some((page) => page.fills.includes(code)), true);
      assert.equal(readFileSync(file, "utf8").includes(code), false);
      const replay = await fetch(`${base}/api/browser/tasks/${opened.taskId}/code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, code }),
      });
      assert.equal(replay.status, 404);
    });
  });

  it("keeps the session open when the host cannot show a window", async () => {
    await withWorker({}, async ({ base, driver }) => {
      const response = await start(base, undefined, { url: "https://example.com/" });
      const cookie = sessionCookie(response);
      const opened = lastDone(await response.text());
      const handoff = await act(base, cookie, opened.sessionId, "handoff");
      const body = await handoff.text();
      assert.equal(body.includes("This host cannot open a browser window."), true);
      assert.equal(lastDone(body).status, "open");
      assert.equal(driver.headed.includes(true), false);
    });
  });

  it("opens a scanned https address in the only live session", async () => {
    await withWorker({}, async ({ base }) => {
      const response = await start(base, undefined, { url: "https://example.com/" });
      const cookie = sessionCookie(response);
      await response.text();
      const scanned = await fetch(`${base}/api/browser/phone/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.org/from-phone" }),
      });
      const body = await scanned.text();
      assert.equal(scanned.status, 200);
      assert.equal(body.includes("Opened https://example.org/from-phone"), true);
      const refused = await fetch(`${base}/api/browser/phone/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "http://example.com/" }),
      });
      assert.equal(refused.status, 400);
      const second = await start(base, cookie, { url: "https://example.com/two" });
      await second.text();
      const crowded = await fetch(`${base}/api/browser/phone/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.org/again" }),
      });
      assert.equal(crowded.status, 409);
    });
  });

  it("reads a public page without keeping a session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-read-"));
    const driver = new FakeDriver();
    const worker = new BrowserWorker({
      driver,
      store: new BrowserStore(join(dir, "sessions.json")),
      vault: null,
      canShowWindow: false,
      operationTimeoutMs: 1_000,
      sessionTtlMs: 60_000,
      maxSessions: 4,
      allowedHosts: ["district.in"],
      now: () => 1_000,
    });
    try {
      const read = await worker.readHtml("https://www.district.in/events/");
      assert.equal(read.ok, true);
      if (read.ok) assert.equal(read.html.includes("https://www.district.in/events/"), true);
      assert.equal(driver.pages[0]?.closed, true);
      const blocked = await worker.readHtml("https://example.com/");
      assert.equal(blocked.ok, false);
      const owner = "a".repeat(32);
      const vault = new SessionVault(join(dir, "profiles"), PROFILE_KEY, 60_000, () => 1_000);
      vault.save(owner, "district.in", { cookies: [{ name: "session", value: "kept-sign-in", domain: "www.district.in" }], origins: [] }, true);
      const signed = new BrowserWorker({
        driver,
        store: new BrowserStore(join(dir, "sessions.json")),
        vault,
        canShowWindow: false,
        operationTimeoutMs: 1_000,
        sessionTtlMs: 60_000,
        maxSessions: 4,
        allowedHosts: ["district.in"],
        now: () => 1_000,
      });
      const authed = await signed.readHtml("https://www.district.in/events/", undefined, owner);
      assert.equal(authed.ok, true);
      assert.equal(driver.seeded.at(-1), true);
      const anonymous = await signed.readHtml("https://www.district.in/events/");
      assert.equal(anonymous.ok, true);
      assert.equal(driver.seeded.at(-1), false);
      await signed.stop();
    } finally {
      await worker.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compares shop prices without pressing checkout or pay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-shop-"));
    const driver = new FakeDriver();
    const worker = new BrowserWorker({
      driver,
      store: new BrowserStore(join(dir, "sessions.json")),
      vault: null,
      canShowWindow: false,
      operationTimeoutMs: 1_000,
      sessionTtlMs: 60_000,
      maxSessions: 4,
      allowedHosts: null,
      now: () => 1_000,
    });
    try {
      const shop = await worker.compareShop("amul");
      assert.equal(shop.cheapest?.merchant, "Zepto");
      assert.equal(shop.cheapest?.rupees, 70);
      assert.equal(shop.offers.length, 3);
      assert.equal(shop.pay, null);
      assert.equal(driver.pages.some((page) => page.clicks.includes("Checkout") || page.clicks.includes("Add")), false);
      const stored = existsSync(join(dir, "sessions.json")) ? readFileSync(join(dir, "sessions.json"), "utf8") : "";
      assert.equal(stored.includes("upi://"), false);
      assert.equal(driver.pages.every((page) => page.closed), true);
      const pay = await worker.collectPay("https://www.district.in/events/free-comedy", "Free Comedy", "District");
      assert.equal(pay?.pay?.source, "deeplink");
      assert.equal(pay?.pay?.url.startsWith("upi://pay"), true);
    } finally {
      await worker.stop();
      rmSync(dir, { recursive: true, force: true });
    }
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
  payments: string[] = [];
  private readonly allow: (url: string) => boolean;

  constructor(allow: (url: string) => boolean, storageState?: unknown) {
    this.allow = allow;
    const cookies = storageCookies(storageState);
    for (const [name, value] of cookies) this.cookies.set(name, value);
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
    const finalUrl = url.includes("/drop-https") ? "http://evil.example/left" : url.includes("/bounce") ? "https://evil.example/left" : url;
    void this.allow(finalUrl);
    this.url = finalUrl;
    this.title = "Example";
    this.cookies.set("session", SECRET_COOKIE);
    return { url: finalUrl, title: this.title };
  }

  async location(signal: AbortSignal): Promise<{ url: string; title: string }> {
    if (signal.aborted) throw new Error("timed out");
    return { url: this.url, title: this.title };
  }

  async html(signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error("timed out");
    return `<html>${this.url}</html>`;
  }

  async elements(signal: AbortSignal): Promise<PageElement[]> {
    if (signal.aborted) throw new Error("timed out");
    const price = this.url.includes("zepto.com") ? 70 : this.url.includes("swiggy.com") ? 90 : this.url.includes("blinkit.com") ? 80 : 0;
    if (this.url.includes("district.in")) return [{ role: "button", name: "Book" }];
    if (price > 0) {
      if (this.fills.length === 0) return [{ role: "searchbox", name: "Search" }];
      if (!this.clicks.includes("Search")) return [{ role: "button", name: "Search" }];
      return [
        { role: "link", name: `Amul Taaza ₹${price}` },
        { role: "text", name: `₹${price}` },
        { role: "button", name: "Add" },
        { role: "button", name: "Apply offer" },
        { role: "button", name: "Checkout" },
      ];
    }
    return [
      { role: "button", name: "Continue" },
      { role: "textbox", name: "Notes" },
      ...(this.url.includes("example.com") ? [{ role: "link", name: "Log out" }] : []),
    ];
  }

  async click(target: ElementTarget, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("timed out");
    this.clicks.push(target.name);
    if (target.name === "Checkout" || target.name === "Book") {
      this.payments.push("upi://pay?pa=shop@upi&am=70&cu=INR");
    }
  }

  takePayment(): string | null {
    return this.payments.shift() ?? null;
  }

  async screenshot(signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted) throw new Error("timed out");
    return new Uint8Array();
  }

  async fill(_target: ElementTarget, value: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("timed out");
    this.fills.push(value);
    if (value === SECRET_FILL) throw new Error(`could not fill ${value}`);
  }

  async storageState(signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new Error("timed out");
    const domain = this.url ? new URL(this.url).hostname : "";
    return { cookies: [...this.cookies].map(([name, value]) => ({ name, value, domain })), origins: [] };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function storageCookies(state: unknown): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!state || typeof state !== "object" || !Array.isArray((state as { cookies?: unknown }).cookies)) return cookies;
  for (const cookie of (state as { cookies: unknown[] }).cookies) {
    if (!cookie || typeof cookie !== "object") continue;
    const name = (cookie as { name?: unknown }).name;
    const value = (cookie as { value?: unknown }).value;
    if (typeof name === "string" && typeof value === "string") cookies.set(name, value);
  }
  return cookies;
}

class FakeDriver implements BrowserDriver {
  pages: FakePage[] = [];
  allows: Array<(url: string) => boolean> = [];
  headed: boolean[] = [];
  seeded: boolean[] = [];

  async openIsolated(options: { allow: (url: string) => boolean; storageState?: unknown; headed?: boolean }): Promise<IsolatedPage> {
    this.allows.push(options.allow);
    this.headed.push(options.headed === true);
    const page = new FakePage(options.allow, options.storageState);
    this.seeded.push(page.cookies.has("session"));
    this.pages.push(page);
    return page;
  }

  async close(): Promise<void> {}
}

async function withWorker(
  options: { operationTimeoutMs?: number; sessionTtlMs?: number; maxSessions?: number; nowStart?: number; profileTtlMs?: number; canShowWindow?: boolean },
  run: (context: {
    base: string;
    driver: FakeDriver;
    file: string;
    profileDir: string;
    store: BrowserStore;
    setNow: (value: number) => void;
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "scout-browser-"));
  const file = join(dir, "sessions.json");
  const profileDir = join(dir, "profiles");
  const driver = new FakeDriver();
  const store = new BrowserStore(file);
  let now = options.nowStart ?? 1_000_000;
  const vault = options.profileTtlMs == null ? null : new SessionVault(profileDir, PROFILE_KEY, options.profileTtlMs, () => now);
  const worker = new BrowserWorker({
    driver,
    store,
    vault,
    canShowWindow: options.canShowWindow === true,
    operationTimeoutMs: options.operationTimeoutMs ?? 1_000,
    sessionTtlMs: options.sessionTtlMs ?? 60_000,
    maxSessions: options.maxSessions ?? 4,
    allowedHosts: null,
    now: () => now,
  });
  try {
    await withApi({ browser: worker, now: () => now }, async (base) => {
      await run({ base, driver, file, profileDir, store, setNow: (value) => { now = value; } });
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
