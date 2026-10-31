import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { EmailAuth } from "../src/server/auth/emailAuth.ts";
import {
  admit,
  capacityAudit,
  describeBudget,
  idleMsFromEnv,
  idleSessionIds,
  limitsFromEnv,
  runPlanBenchmarks,
  sessionHost,
  type BenchName,
  type BenchResult,
} from "../src/server/browser/budget.ts";
import type { BrowserDriver, ElementTarget, IsolatedPage } from "../src/server/browser/driver.ts";
import { browserRuntimeFromEnv, signRuntimeTicket, verifyRuntimeTicket } from "../src/server/browser/runtimeTicket.ts";
import { BrowserStore } from "../src/server/browser/store.ts";
import { BrowserWorker } from "../src/server/browser/worker.ts";
import { useLocalBrowserWorker } from "../src/server/deps.ts";
import { withApi } from "./helpers.ts";

const LIMITS = { globalLimit: 2, userLimit: 1, domainLimit: 1, rssCeilingMb: 4096 };
const RUNTIME_KEY = "browser-runtime-test-key-32char!";
const OTHER_KEY = "other-browser-runtime-key-32chars";
const OWNER = "a".repeat(32);
const FORGED = "c".repeat(32);

describe("browser budget", () => {
  it("compares a duplicated Chromium on each app with one central browser", () => {
    const audit = capacityAudit();
    assert.equal(audit.estimate, "planning estimate");
    assert.match(audit.note, /planning estimate/i);
    assert.equal(audit.machine.sku, "P1v3");
    assert.equal(audit.machine.vcpu, 2);
    assert.equal(audit.machine.ramMb, 8192);
    assert.deepEqual([...audit.apps], [
      "sj-scout",
      "sj-event-scout",
      "sj-travel-scout",
      "sj-food-scout",
      "sj-shop-scout",
      "sj-home-scout",
    ]);
    assert.equal(audit.apps.includes("appointments"), false);
    assert.equal(audit.constants.nodeIdleMb, 90);
    assert.equal(audit.constants.chromiumWarmMb, 280);
    assert.equal(audit.constants.extraContextMb, 120);
    assert.equal(audit.duplicated.mode, "duplicated");
    assert.equal(audit.central.mode, "central");
    assert.equal(audit.duplicated.chromiumProcesses, 6);
    assert.equal(audit.central.chromiumProcesses, 1);
    assert.equal(audit.duplicated.nodeProcesses, 6);
    assert.equal(audit.central.nodeProcesses, 6);
    assert.equal(audit.duplicated.idleRamMb, 6 * 90 + 6 * 280);
    assert.equal(audit.central.idleRamMb, 6 * 90 + 280);
    assert.ok(audit.duplicated.idleRamMb > audit.central.idleRamMb);
    assert.equal(audit.duplicated.idleCpu, 1.2);
    assert.equal(audit.central.idleCpu, 0.45);
  });

  it("admits within global, user, domain, and rss limits", () => {
    const open = admit({ ownerId: OWNER, host: "example.com", live: [], rssMb: 0, limits: { ...LIMITS, rssCeilingMb: 1 } });
    assert.equal(open.ok, true);
    const heavyUnknown = admit({ ownerId: OWNER, host: "example.com", live: [], rssMb: 0, limits: LIMITS });
    assert.equal(heavyUnknown.ok, true);
    const underCeiling = admit({ ownerId: OWNER, host: "example.com", live: [], rssMb: 4095, limits: LIMITS });
    assert.equal(underCeiling.ok, true);
    const overCeiling = admit({ ownerId: OWNER, host: "secret.example", live: [], rssMb: 4096, limits: LIMITS });
    assert.equal(overCeiling.ok, false);
    if (!overCeiling.ok) {
      assert.equal(overCeiling.reason, "The browser worker is out of memory.");
      assert.equal(overCeiling.reason.includes("secret.example"), false);
    }
    const global = admit({
      ownerId: OWNER,
      host: "fresh.example",
      live: [
        { ownerId: "b".repeat(32), host: "a.example" },
        { ownerId: "d".repeat(32), host: "b.example" },
      ],
      rssMb: 100,
      limits: LIMITS,
    });
    assert.equal(global.ok, false);
    if (!global.ok) assert.equal(global.reason, "Too many browser sessions are open. Close one and try again.");
    const user = admit({
      ownerId: OWNER,
      host: "other.example",
      live: [{ ownerId: OWNER, host: "example.com" }],
      rssMb: 100,
      limits: LIMITS,
    });
    assert.equal(user.ok, false);
    if (!user.ok) assert.equal(user.reason, "You already have a browser session open.");
    const domain = admit({
      ownerId: "b".repeat(32),
      host: "Secret.Example.",
      live: [{ ownerId: OWNER, host: "secret.example" }],
      rssMb: 100,
      limits: LIMITS,
    });
    assert.equal(domain.ok, false);
    if (!domain.ok) {
      assert.equal(domain.reason, "That site already has a browser session open.");
      assert.equal(domain.reason.includes("?"), false);
      assert.equal(domain.reason.includes("secret"), false);
    }
  });

  it("closes idle open sessions and keeps paused sessions", () => {
    const now = 10_000;
    assert.deepEqual(idleSessionIds([
      { id: "open-old", status: "open", updatedAt: 0 },
      { id: "paused-old", status: "paused", updatedAt: 0 },
      { id: "open-fresh", status: "open", updatedAt: 9_500 },
      { id: "closed-old", status: "closed", updatedAt: 0 },
    ], now, 1_000), ["open-old"]);
    assert.deepEqual(idleSessionIds([{ id: "open-old", status: "open", updatedAt: 0 }], now, 0), []);
  });

  it("reads admission limits from the environment", () => {
    assert.deepEqual(limitsFromEnv({}), LIMITS);
    assert.equal(limitsFromEnv({ BROWSER_GLOBAL_LIMIT: "" }).globalLimit, 2);
    assert.equal(limitsFromEnv({ BROWSER_GLOBAL_LIMIT: "9" }).globalLimit, 4);
    assert.equal(limitsFromEnv({ BROWSER_GLOBAL_LIMIT: "0" }).globalLimit, 1);
    assert.equal(limitsFromEnv({ BROWSER_USER_LIMIT: "3" }).userLimit, 3);
    assert.equal(limitsFromEnv({ BROWSER_DOMAIN_LIMIT: "2" }).domainLimit, 2);
    assert.equal(limitsFromEnv({ BROWSER_RSS_CEILING_MB: "2048" }).rssCeilingMb, 2048);
    assert.equal(idleMsFromEnv({}), undefined);
    assert.equal(idleMsFromEnv({ BROWSER_IDLE_MS: "" }), undefined);
    assert.equal(idleMsFromEnv({ BROWSER_IDLE_MS: "nope" }), undefined);
    assert.equal(idleMsFromEnv({ BROWSER_IDLE_MS: "120000" }), 120_000);
    assert.equal(useLocalBrowserWorker({ SCOUT_ROLE: "browser", BROWSER_RUNTIME_URL: "http://127.0.0.1:9" }, true), true);
    assert.equal(useLocalBrowserWorker({ BROWSER_RUNTIME_URL: "http://127.0.0.1:9", BROWSER_WORKER_ENABLED: "1" }, true), false);
    assert.equal(useLocalBrowserWorker({}, true), true);
    assert.equal(useLocalBrowserWorker({ SCOUT_ROLE: "browser" }, false), false);
    const missingKey = browserRuntimeFromEnv({ BROWSER_RUNTIME_URL: "http://127.0.0.1:9", BROWSER_RUNTIME_KEY: "short" });
    assert.equal(missingKey?.key, null);
    assert.equal(browserRuntimeFromEnv({}) , undefined);
    const configured = browserRuntimeFromEnv({ BROWSER_RUNTIME_KEY: RUNTIME_KEY });
    assert.equal(configured?.url, "");
    assert.equal(configured?.key?.length, 32);
  });

  it("keeps hosts only in the budget report", () => {
    assert.equal(sessionHost("https://shop.example/item?token=super-secret"), "shop.example");
    assert.equal(sessionHost(""), "");
    const report = describeBudget({
      sessions: [
        { ownerId: OWNER, url: "https://shop.example/item?token=super-secret" },
        { ownerId: OWNER, url: "https://shop.example/other" },
        { ownerId: "b".repeat(32), url: "" },
      ],
      rssMb: 0,
      limits: LIMITS,
      idleMs: null,
    });
    const text = JSON.stringify(report);
    assert.equal(text.includes("super-secret"), false);
    assert.equal(text.includes("token"), false);
    assert.equal(text.includes("?"), false);
    assert.equal(text.includes(OWNER), false);
    assert.equal(text.includes("/item"), false);
    assert.deepEqual(report.live, {
      sessions: 3,
      owners: 2,
      hosts: [{ host: "shop.example", count: 2 }],
    });
    assert.equal(report.rssMb, 0);
    assert.equal(report.central.chromiumProcesses, 1);
    assert.equal(report.duplicated.chromiumProcesses, 6);
  });

  it("round-trips a runtime ticket and rejects a bad or expired one", () => {
    assert.equal(RUNTIME_KEY.length, 32);
    const now = 1_700_000_000_000;
    const pathname = "/api/browser/sessions";
    const ticket = signRuntimeTicket({ ownerId: OWNER, method: "post", pathname, now, key: RUNTIME_KEY });
    assert.ok(ticket);
    assert.match(ticket ?? "", /^v1\.[a-f0-9]{32}\.\d+\.[a-f0-9]{64}$/);
    assert.equal(ticket?.includes(RUNTIME_KEY), false);
    const verified = verifyRuntimeTicket(ticket ?? "", { method: "POST", pathname, now, key: RUNTIME_KEY });
    assert.deepEqual(verified, { ok: true, ownerId: OWNER });
    const stillValid = verifyRuntimeTicket(ticket ?? "", { method: "POST", pathname, now: now + 59_999, key: RUNTIME_KEY });
    assert.equal(stillValid.ok, true);
    const expired = verifyRuntimeTicket(ticket ?? "", { method: "POST", pathname, now: now + 60_000, key: RUNTIME_KEY });
    assert.equal(expired.ok, false);
    const wrongPath = verifyRuntimeTicket(ticket ?? "", { method: "POST", pathname: "/api/browser/budget", now, key: RUNTIME_KEY });
    assert.equal(wrongPath.ok, false);
    const wrongKey = verifyRuntimeTicket(ticket ?? "", { method: "POST", pathname, now, key: OTHER_KEY });
    assert.equal(wrongKey.ok, false);
    const broken = `${ticket?.slice(0, -1)}0`;
    assert.equal(verifyRuntimeTicket(broken, { method: "POST", pathname, now, key: RUNTIME_KEY }).ok, false);
    assert.equal(signRuntimeTicket({ ownerId: "short", method: "POST", pathname, now, key: RUNTIME_KEY }), null);
    assert.equal(verifyRuntimeTicket("v1.nope.1.ab", { method: "POST", pathname, now, key: RUNTIME_KEY }).ok, false);
  });

  it("proxy uses the cookie owner and ignores a body user id", async () => {
    const now = 1_700_000_000_000;
    const forgedHeader = `v1.${FORGED}.1.${"ab".repeat(32)}`;
    await withRecording(async (upstream, seen) => {
      await withApi({
        browserRuntime: { url: upstream, key: RUNTIME_KEY },
        now: () => now,
      }, async (site) => {
        const response = await fetch(`${site}/api/browser/sessions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `scout_session=${OWNER}`,
            "x-scout-runtime": forgedHeader,
          },
          body: JSON.stringify({ url: "https://example.com/item?token=super-secret", userId: FORGED, ownerId: FORGED }),
        });
        assert.equal(response.status, 200);
        const verified = verifyRuntimeTicket(seen.ticket ?? "", {
          method: "POST",
          pathname: "/api/browser/sessions",
          now,
          key: RUNTIME_KEY,
        });
        assert.deepEqual(verified, { ok: true, ownerId: OWNER });
        assert.equal(seen.cookie, undefined);
        assert.equal(seen.body.includes(FORGED), true);
        assert.notEqual(seen.ticket, forgedHeader);
      });
    });

    const runtime = await openWorker({ limits: LIMITS, rssMb: () => 128, nowStart: now });
    const auth = rejectingAuth();
    try {
      await withApi({
        browser: runtime.worker,
        browserRuntime: { url: "", key: RUNTIME_KEY },
        now: () => now,
        auth: auth.auth,
      }, async (runtimeBase) => {
        const stale = signRuntimeTicket({
          ownerId: FORGED,
          method: "POST",
          pathname: "/api/browser/sessions",
          now: now - 120_000,
          key: RUNTIME_KEY,
        });
        const rejected = await fetch(`${runtimeBase}/api/browser/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-scout-runtime": stale ?? "" },
          body: JSON.stringify({ url: "https://example.com/", userId: FORGED }),
        });
        assert.equal(rejected.status, 401);
        assert.equal(runtime.driver.pages.length, 0);
        const unsigned = await fetch(`${runtimeBase}/api/browser/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://example.com/" }),
        });
        assert.equal(unsigned.status, 401);
        const unsignedBody = (await unsigned.json()) as { error: string };
        assert.match(unsignedBody.error, /Sign in/);
        assert.equal(auth.calls() > 0, true);

        await withApi({
          browserRuntime: { url: runtimeBase, key: RUNTIME_KEY },
          now: () => now,
        }, async (site) => {
          const callsBefore = auth.calls();
          const opened = await fetch(`${site}/api/browser/sessions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: `scout_session=${OWNER}`,
              "x-scout-runtime": forgedHeader,
            },
            body: JSON.stringify({ url: "https://example.com/item?token=super-secret", userId: FORGED, ownerId: FORGED }),
          });
          const openedText = await opened.text();
          assert.equal(opened.status, 200, openedText);
          assert.equal(openedText.includes("event: status"), true);
          assert.equal(auth.calls(), callsBefore);
          assert.equal(runtime.store.live().length, 1);
          assert.equal(runtime.store.live()[0]?.ownerId, OWNER);
          const budget = await fetch(`${site}/api/browser/budget`, { headers: { cookie: `scout_session=${OWNER}` } });
          const budgetText = await budget.text();
          assert.equal(budget.status, 200);
          assert.equal(budgetText.includes("super-secret"), false);
          assert.equal(budgetText.includes(OWNER), false);
          assert.equal(budgetText.includes(RUNTIME_KEY), false);
          assert.match(budgetText, /planning estimate/);
          assert.match(budgetText, /example\.com/);
          const report = JSON.parse(budgetText) as { central: { chromiumProcesses: number }; duplicated: { chromiumProcesses: number }; rssMb: number };
          assert.equal(report.central.chromiumProcesses, 1);
          assert.equal(report.duplicated.chromiumProcesses, 6);
          assert.equal(report.rssMb, 128);
        });
      });
    } finally {
      await runtime.close();
    }

    await withApi({ browserRuntime: { url: "http://127.0.0.1:9", key: null } }, async (site) => {
      const response = await fetch(`${site}/api/browser/budget`);
      const body = (await response.json()) as { error: string };
      assert.equal(response.status, 503);
      assert.equal(body.error, "Browser runtime is not configured.");
      assert.equal(JSON.stringify(body).includes("127.0.0.1"), false);
    });
  });

  it("enforces limits on the worker and idle-closes an open session", async () => {
    const started = 1_000_000;
    const runtime = await openWorker({ limits: LIMITS, rssMb: () => 100, idleMs: 5_000, nowStart: started });
    const owner2 = "b".repeat(32);
    const owner3 = "d".repeat(32);
    try {
      const first = await runtime.worker.create(OWNER, "https://example.com/item?token=super-secret", null);
      assert.equal(first.kind, "events");
      const sameUser = await runtime.worker.create(OWNER, "https://other.example/", null);
      assert.equal(sameUser.kind, "json");
      if (sameUser.kind === "json") {
        assert.equal(sameUser.httpStatus, 429);
        assert.equal((sameUser.body as { error: string }).error, "You already have a browser session open.");
      }
      const sameSite = await runtime.worker.create(owner2, "https://example.com/other", null);
      assert.equal(sameSite.kind, "json");
      if (sameSite.kind === "json") {
        assert.equal(sameSite.httpStatus, 429);
        assert.equal((sameSite.body as { error: string }).error, "That site already has a browser session open.");
      }
      assert.equal(runtime.driver.pages.length, 1);
      const second = await runtime.worker.create(owner2, "https://other.example/", null);
      assert.equal(second.kind, "events");
      const third = await runtime.worker.create(owner3, "https://third.example/", null);
      assert.equal(third.kind, "json");
      if (third.kind === "json") {
        assert.equal(third.httpStatus, 429);
        assert.equal((third.body as { error: string }).error, "Too many browser sessions are open. Close one and try again.");
      }
      assert.equal(runtime.driver.pages.length, 2);
      const before = runtime.worker.budget();
      const beforeText = JSON.stringify(before);
      assert.equal(beforeText.includes("super-secret"), false);
      assert.equal(beforeText.includes(OWNER), false);
      assert.deepEqual(before.live.hosts, [
        { host: "example.com", count: 1 },
        { host: "other.example", count: 1 },
      ]);
      const paused = runtime.store.live().find((session) => session.ownerId === owner2);
      const idle = runtime.store.live().find((session) => session.ownerId === OWNER);
      assert.ok(paused && idle);
      await runtime.worker.pause(owner2, paused.id);
      runtime.setNow(started + 5_000);
      await runtime.worker.sweep();
      assert.equal(runtime.store.session(idle.id)?.status, "closed");
      assert.equal(runtime.store.session(paused.id)?.status, "paused");
      assert.equal(runtime.driver.pages[0]?.closed, true);
      assert.equal(runtime.driver.pages[1]?.closed, false);
      const events = runtime.store.events(idle.taskId);
      assert.equal(events.some((event) => event.type === "status" && event.message === "Browser session was idle."), true);
    } finally {
      await runtime.close();
    }

    const full = await openWorker({ limits: LIMITS, rssMb: () => 5_000 });
    try {
      const refused = await full.worker.create(OWNER, "https://example.com/", null);
      assert.equal(refused.kind, "json");
      if (refused.kind === "json") {
        assert.equal(refused.httpStatus, 429);
        assert.equal((refused.body as { error: string }).error, "The browser worker is out of memory.");
      }
      assert.equal(full.driver.pages.length, 0);
    } finally {
      await full.close();
    }
  });

  it("keeps the seven benchmark cases finite", () => {
    const rows = runPlanBenchmarks();
    assert.deepEqual(rows.map((row) => row.name), [
      "allSixIdle",
      "oneTask",
      "threeConcurrent",
      "fiveConcurrent",
      "multipleUsers",
      "slowSameDomain",
      "crashedInFlight",
    ]);
    const expected: Record<BenchName, Pick<BenchResult, "admitted" | "queued" | "failed" | "latencyP50Ms" | "latencyP95Ms" | "queueTimeMs" | "peakRssMb" | "peakCpu">> = {
      allSixIdle: { admitted: 0, queued: 0, failed: 0, latencyP50Ms: 0, latencyP95Ms: 0, queueTimeMs: 0, peakRssMb: 820, peakCpu: 0.45 },
      oneTask: { admitted: 1, queued: 0, failed: 0, latencyP50Ms: 1_000, latencyP95Ms: 1_000, queueTimeMs: 0, peakRssMb: 940, peakCpu: 0.85 },
      threeConcurrent: { admitted: 3, queued: 1, failed: 0, latencyP50Ms: 1_000, latencyP95Ms: 2_000, queueTimeMs: 333, peakRssMb: 1060, peakCpu: 1.25 },
      fiveConcurrent: { admitted: 5, queued: 3, failed: 0, latencyP50Ms: 2_000, latencyP95Ms: 3_000, queueTimeMs: 800, peakRssMb: 1060, peakCpu: 1.25 },
      multipleUsers: { admitted: 4, queued: 2, failed: 0, latencyP50Ms: 1_000, latencyP95Ms: 2_000, queueTimeMs: 500, peakRssMb: 1060, peakCpu: 1.25 },
      slowSameDomain: { admitted: 3, queued: 1, failed: 0, latencyP50Ms: 4_000, latencyP95Ms: 5_000, queueTimeMs: 1333, peakRssMb: 1060, peakCpu: 1.25 },
      crashedInFlight: { admitted: 3, queued: 1, failed: 1, latencyP50Ms: 1_000, latencyP95Ms: 1_400, queueTimeMs: 133, peakRssMb: 1060, peakCpu: 1.25 },
    };
    for (const row of rows) {
      for (const value of [
        row.admitted,
        row.queued,
        row.failed,
        row.latencyP50Ms,
        row.latencyP95Ms,
        row.queueTimeMs,
        row.throughputPerSec,
        row.peakRssMb,
        row.peakCpu,
        row.failureRate,
      ]) {
        assert.equal(Number.isFinite(value), true, row.name);
      }
      assert.equal(row.estimate, "planning estimate");
      assert.deepEqual({
        admitted: row.admitted,
        queued: row.queued,
        failed: row.failed,
        latencyP50Ms: row.latencyP50Ms,
        latencyP95Ms: row.latencyP95Ms,
        queueTimeMs: row.queueTimeMs,
        peakRssMb: row.peakRssMb,
        peakCpu: row.peakCpu,
      }, expected[row.name]);
    }
    const byName = Object.fromEntries(rows.map((row) => [row.name, row])) as Record<BenchName, BenchResult>;
    assert.equal(byName.allSixIdle.throughputPerSec, 0);
    assert.equal(byName.allSixIdle.failureRate, 0);
    assert.equal(byName.oneTask.throughputPerSec, 1);
    assert.equal(byName.threeConcurrent.throughputPerSec, 1.5);
    assert.equal(byName.fiveConcurrent.throughputPerSec, 5 / 3);
    assert.equal(byName.multipleUsers.throughputPerSec, 2);
    assert.equal(byName.slowSameDomain.throughputPerSec, 0.6);
    assert.equal(byName.crashedInFlight.throughputPerSec, 3 / 1.4);
    assert.equal(byName.crashedInFlight.failureRate, 1 / 3);
    assert.ok(byName.fiveConcurrent.peakRssMb < 6 * 90 + 6 * 280);
  });
});

class FakePage implements IsolatedPage {
  closed = false;

  async goto(url: string): Promise<{ url: string; title: string }> {
    return { url, title: "Example" };
  }

  async location(): Promise<{ url: string; title: string }> {
    return { url: "https://example.com/", title: "Example" };
  }

  async html(): Promise<string> {
    return "<html></html>";
  }

  async elements(): Promise<Array<{ role: string; name: string }>> {
    return [];
  }

  async click(_target: ElementTarget): Promise<void> {}

  async fill(_target: ElementTarget, _value: string): Promise<void> {}

  takePayment(): string | null {
    return null;
  }

  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  async storageState(): Promise<unknown> {
    return {};
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeDriver implements BrowserDriver {
  pages: FakePage[] = [];

  async openIsolated(): Promise<IsolatedPage> {
    const page = new FakePage();
    this.pages.push(page);
    return page;
  }

  async close(): Promise<void> {}
}

async function openWorker(options: {
  limits?: { globalLimit: number; userLimit: number; domainLimit: number; rssCeilingMb: number };
  rssMb?: () => number;
  idleMs?: number;
  nowStart?: number;
}): Promise<{
  worker: BrowserWorker;
  driver: FakeDriver;
  store: BrowserStore;
  setNow: (value: number) => void;
  close: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "scout-budget-"));
  const store = new BrowserStore(join(dir, "sessions.json"));
  const driver = new FakeDriver();
  let now = options.nowStart ?? 1_000_000;
  const worker = new BrowserWorker({
    driver,
    store,
    vault: null,
    canShowWindow: false,
    operationTimeoutMs: 1_000,
    sessionTtlMs: 60_000,
    maxSessions: 4,
    allowedHosts: null,
    now: () => now,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.rssMb ? { rssMb: options.rssMb } : {}),
    ...(options.idleMs == null ? {} : { idleMs: options.idleMs }),
  });
  return {
    worker,
    driver,
    store,
    setNow: (value: number) => {
      now = value;
    },
    close: async () => {
      await worker.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function rejectingAuth(): { auth: EmailAuth; calls: () => number } {
  let calls = 0;
  const auth = {
    account: () => {
      calls += 1;
      return null;
    },
  } as unknown as EmailAuth;
  return { auth, calls: () => calls };
}

async function withRecording(
  run: (base: string, seen: { cookie: string | undefined; ticket: string | undefined; body: string }) => Promise<void>,
): Promise<void> {
  const seen = { cookie: undefined as string | undefined, ticket: undefined as string | undefined, body: "" };
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    seen.cookie = request.headers.cookie;
    const ticket = request.headers["x-scout-runtime"];
    seen.ticket = typeof ticket === "string" ? ticket : undefined;
    seen.body = Buffer.concat(chunks).toString("utf8");
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`, seen);
  } finally {
    server.close();
    await once(server, "close");
  }
}
