export const SCOUT_SITE_APPS = [
  "sj-scout",
  "sj-event-scout",
  "sj-travel-scout",
  "sj-food-scout",
  "sj-shop-scout",
  "sj-home-scout",
] as const;

export const PLAN_NODE_IDLE_MB = 90;
export const PLAN_CHROMIUM_WARM_MB = 280;
export const PLAN_EXTRA_CONTEXT_MB = 120;

const NODE_IDLE_CPU_MILLI = 50;
const CHROMIUM_WARM_CPU_MILLI = 150;
const CONTEXT_CPU_MILLI = 400;

export type PlanMode = "duplicated" | "central";

export type AdmissionLimits = {
  globalLimit: number;
  userLimit: number;
  domainLimit: number;
  rssCeilingMb: number;
};

export type AdmitLimit = "global" | "user" | "domain" | "rss";

export type AdmitDecision =
  | { ok: true }
  | { ok: false; reason: string; limit: AdmitLimit };

export type PlanSide = {
  mode: PlanMode;
  chromiumProcesses: number;
  nodeProcesses: number;
  idleRamMb: number;
  idleCpu: number;
};

export type BudgetReport = {
  estimate: "planning estimate";
  note: string;
  machine: { sku: "P1v3"; vcpu: 2; ramMb: 8192; region: "Central India" };
  apps: readonly string[];
  constants: { nodeIdleMb: number; chromiumWarmMb: number; extraContextMb: number };
  duplicated: PlanSide;
  central: PlanSide;
  live: {
    sessions: number;
    owners: number;
    hosts: Array<{ host: string; count: number }>;
  };
  rssMb: number;
  limits: AdmissionLimits | null;
  idleMs: number | null;
};

export type BenchName =
  | "allSixIdle"
  | "oneTask"
  | "threeConcurrent"
  | "fiveConcurrent"
  | "multipleUsers"
  | "slowSameDomain"
  | "crashedInFlight";

export type BenchResult = {
  name: BenchName;
  admitted: number;
  queued: number;
  failed: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  queueTimeMs: number;
  throughputPerSec: number;
  peakRssMb: number;
  peakCpu: number;
  failureRate: number;
  estimate: "planning estimate";
};

type LiveSeat = {
  ownerId: string;
  host: string;
};

type AdmitInput = {
  ownerId: string;
  host: string;
  live: readonly LiveSeat[];
  rssMb: number;
  limits: AdmissionLimits;
};

const ADMIT_REASONS: Record<AdmitLimit, string> = {
  global: "Too many browser sessions are open. Close one and try again.",
  user: "You already have a browser session open.",
  domain: "That site already has a browser session open.",
  rss: "The browser worker is out of memory.",
};

const BENCH_LIMITS: AdmissionLimits = {
  globalLimit: 2,
  userLimit: 1,
  domainLimit: 1,
  rssCeilingMb: 4096,
};

export function sessionHost(url: string): string {
  const text = url.trim();
  if (text.length === 0) return "";
  try {
    return new URL(text).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

export function limitsFromEnv(env: NodeJS.ProcessEnv): AdmissionLimits {
  return {
    globalLimit: bounded(env.BROWSER_GLOBAL_LIMIT, 2, 1, 4),
    userLimit: bounded(env.BROWSER_USER_LIMIT, 1, 1, 4),
    domainLimit: bounded(env.BROWSER_DOMAIN_LIMIT, 1, 1, 4),
    rssCeilingMb: bounded(env.BROWSER_RSS_CEILING_MB, 4096, 256, 8192),
  };
}

export function idleMsFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const text = env.BROWSER_IDLE_MS?.trim() ?? "";
  if (text.length === 0) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

export function planSide(mode: PlanMode): PlanSide {
  const apps = SCOUT_SITE_APPS.length;
  const chromiumProcesses = chromiumCount(mode);
  return {
    mode,
    chromiumProcesses,
    nodeProcesses: apps,
    idleRamMb: apps * PLAN_NODE_IDLE_MB + chromiumProcesses * PLAN_CHROMIUM_WARM_MB,
    idleCpu: (apps * NODE_IDLE_CPU_MILLI + chromiumProcesses * CHROMIUM_WARM_CPU_MILLI) / 1000,
  };
}

export function capacityAudit(): Pick<BudgetReport, "estimate" | "note" | "machine" | "apps" | "constants" | "duplicated" | "central"> {
  return {
    estimate: "planning estimate",
    note: "These RAM and CPU figures are planning estimates, not a live Azure sample. Appointments has no Azure site.",
    machine: { sku: "P1v3", vcpu: 2, ramMb: 8192, region: "Central India" },
    apps: SCOUT_SITE_APPS,
    constants: {
      nodeIdleMb: PLAN_NODE_IDLE_MB,
      chromiumWarmMb: PLAN_CHROMIUM_WARM_MB,
      extraContextMb: PLAN_EXTRA_CONTEXT_MB,
    },
    duplicated: planSide("duplicated"),
    central: planSide("central"),
  };
}

export function describeBudget(input: {
  sessions: readonly { ownerId: string; url: string }[];
  rssMb: number;
  limits: AdmissionLimits | null;
  idleMs: number | null;
}): BudgetReport {
  const hosts = new Map<string, number>();
  const owners = new Set<string>();
  for (const session of input.sessions) {
    if (session.ownerId.length > 0) owners.add(session.ownerId);
    const host = sessionHost(session.url);
    if (host.length === 0) continue;
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
  }
  const audit = capacityAudit();
  return {
    ...audit,
    live: {
      sessions: input.sessions.length,
      owners: owners.size,
      hosts: [...hosts.entries()]
        .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
        .map(([host, count]) => ({ host, count })),
    },
    rssMb: Number.isFinite(input.rssMb) && input.rssMb > 0 ? input.rssMb : 0,
    limits: input.limits,
    idleMs: input.idleMs,
  };
}

export function admit(input: AdmitInput): AdmitDecision {
  if (input.live.length >= input.limits.globalLimit) return denied("global");
  const ownerId = input.ownerId;
  let mine = 0;
  for (const session of input.live) {
    if (session.ownerId === ownerId) mine += 1;
  }
  if (mine >= input.limits.userLimit) return denied("user");
  const host = normalizeHost(input.host);
  if (host.length > 0) {
    let same = 0;
    for (const session of input.live) {
      if (normalizeHost(session.host) === host) same += 1;
    }
    if (same >= input.limits.domainLimit) return denied("domain");
  }
  if (input.rssMb > 0 && input.rssMb >= input.limits.rssCeilingMb) return denied("rss");
  return { ok: true };
}

export function idleSessionIds(
  sessions: readonly { id: string; status: string; updatedAt: number }[],
  now: number,
  idleMs: number,
): string[] {
  if (!Number.isFinite(idleMs) || idleMs <= 0) return [];
  const ids: string[] = [];
  for (const session of sessions) {
    if (session.status !== "open") continue;
    if (now - session.updatedAt >= idleMs) ids.push(session.id);
  }
  return ids;
}

export function plannedLoad(mode: PlanMode, contexts: number): { ramMb: number; cpu: number } {
  const side = planSide(mode);
  const open = Math.max(0, contexts);
  return {
    ramMb: side.idleRamMb + open * PLAN_EXTRA_CONTEXT_MB,
    cpu: (side.idleCpu * 1000 + open * CONTEXT_CPU_MILLI) / 1000,
  };
}

export function runPlanBenchmarks(): BenchResult[] {
  const names: BenchName[] = [
    "allSixIdle",
    "oneTask",
    "threeConcurrent",
    "fiveConcurrent",
    "multipleUsers",
    "slowSameDomain",
    "crashedInFlight",
  ];
  return names.map((name) => simulateBench(name, tasksFor(name)));
}

function tasksFor(name: BenchName): SimTask[] {
  switch (name) {
    case "allSixIdle":
      return [];
    case "oneTask":
      return [task(0, "user-1", "shop.example", 1_000)];
    case "threeConcurrent":
      return [0, 1, 2].map((index) => task(index, `user-${index + 1}`, `site-${index + 1}.example`, 1_000));
    case "fiveConcurrent":
      return [0, 1, 2, 3, 4].map((index) => task(index, `user-${index + 1}`, `site-${index + 1}.example`, 1_000));
    case "multipleUsers":
      return [
        task(0, "user-1", "a.example", 1_000),
        task(1, "user-1", "b.example", 1_000),
        task(2, "user-2", "c.example", 1_000),
        task(3, "user-2", "d.example", 1_000),
      ];
    case "slowSameDomain":
      return [
        task(0, "user-1", "shop.example", 4_000),
        task(1, "user-2", "shop.example", 1_000),
        task(2, "user-3", "other.example", 1_000),
      ];
    case "crashedInFlight":
      return [
        task(0, "user-1", "a.example", 1_000, 400),
        task(1, "user-2", "b.example", 1_000),
        task(2, "user-3", "c.example", 1_000),
      ];
    default: {
      const neverName: never = name;
      return neverName;
    }
  }
}

type SimTask = {
  seq: number;
  user: string;
  host: string;
  arrive: number;
  durationMs: number;
  crashAfterMs?: number;
};

type RunningTask = {
  seq: number;
  user: string;
  host: string;
  arrive: number;
  start: number;
  end: number;
  failed: boolean;
};

type FinishedTask = {
  latency: number;
  queueMs: number;
  failed: boolean;
  end: number;
};

function task(seq: number, user: string, host: string, durationMs: number, crashAfterMs?: number): SimTask {
  return crashAfterMs == null
    ? { seq, user, host, arrive: 0, durationMs }
    : { seq, user, host, arrive: 0, durationMs, crashAfterMs };
}

function simulateBench(name: BenchName, tasks: readonly SimTask[]): BenchResult {
  const waiting = [...tasks].sort((left, right) => left.arrive - right.arrive || left.seq - right.seq);
  const queue: SimTask[] = [];
  const running: RunningTask[] = [];
  const finished: FinishedTask[] = [];
  const queued = new Set<number>();
  let now = 0;
  let peak = 0;
  const guard = Math.max(8, tasks.length * 8 + 2);
  for (let step = 0; step < guard; step += 1) {
    while (waiting.length > 0 && (waiting[0]?.arrive ?? 0) <= now) {
      const next = waiting.shift();
      if (next) queue.push(next);
    }
    let index = 0;
    while (index < queue.length) {
      const current = queue[index];
      if (!current) break;
      const decision = admit({
        ownerId: current.user,
        host: current.host,
        live: running.map((item) => ({ ownerId: item.user, host: item.host })),
        rssMb: 0,
        limits: BENCH_LIMITS,
      });
      if (!decision.ok) {
        if (decision.limit === "global" || decision.limit === "rss") break;
        index += 1;
        continue;
      }
      queue.splice(index, 1);
      const failed = current.crashAfterMs != null;
      const span = failed ? current.crashAfterMs ?? current.durationMs : current.durationMs;
      running.push({
        seq: current.seq,
        user: current.user,
        host: current.host,
        arrive: current.arrive,
        start: now,
        end: now + span,
        failed,
      });
      peak = Math.max(peak, running.length);
    }
    for (const current of queue) {
      if (current.arrive <= now) queued.add(current.seq);
    }
    if (waiting.length === 0 && queue.length === 0 && running.length === 0) break;
    let nextEnd = Number.POSITIVE_INFINITY;
    for (const item of running) nextEnd = Math.min(nextEnd, item.end);
    const nextArrive = waiting[0]?.arrive ?? Number.POSITIVE_INFINITY;
    const next = Math.min(nextEnd, nextArrive);
    if (!Number.isFinite(next) || next === Number.POSITIVE_INFINITY || next <= now) break;
    now = next;
    for (let cursor = running.length - 1; cursor >= 0; cursor -= 1) {
      const item = running[cursor];
      if (!item || item.end > now) continue;
      running.splice(cursor, 1);
      finished.push({
        latency: item.end - item.arrive,
        queueMs: item.start - item.arrive,
        failed: item.failed,
        end: item.end,
      });
    }
  }
  const admitted = finished.length;
  const failed = finished.filter((item) => item.failed).length;
  const makespan = finished.reduce((max, item) => Math.max(max, item.end), 0);
  const queueTotal = finished.reduce((sum, item) => sum + item.queueMs, 0);
  const load = plannedLoad("central", peak);
  return {
    name,
    admitted,
    queued: queued.size,
    failed,
    latencyP50Ms: percentile(finished.map((item) => item.latency), 50),
    latencyP95Ms: percentile(finished.map((item) => item.latency), 95),
    queueTimeMs: admitted === 0 ? 0 : Math.round(queueTotal / admitted),
    throughputPerSec: makespan === 0 ? 0 : admitted / (makespan / 1000),
    peakRssMb: load.ramMb,
    peakCpu: load.cpu,
    failureRate: admitted === 0 ? 0 : failed / admitted,
    estimate: "planning estimate",
  };
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

function denied(limit: AdmitLimit): AdmitDecision {
  switch (limit) {
    case "global":
    case "user":
    case "domain":
    case "rss":
      return { ok: false, reason: ADMIT_REASONS[limit], limit };
    default: {
      const neverLimit: never = limit;
      return neverLimit;
    }
  }
}

function chromiumCount(mode: PlanMode): number {
  switch (mode) {
    case "duplicated":
      return SCOUT_SITE_APPS.length;
    case "central":
      return 1;
    default: {
      const neverMode: never = mode;
      return neverMode;
    }
  }
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function bounded(raw: string | undefined, fallback: number, min: number, max: number): number {
  const text = raw?.trim() ?? "";
  if (text.length === 0) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
