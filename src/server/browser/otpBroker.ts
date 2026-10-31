import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type ChallengeChannel = "sms" | "email" | "manual";

export type ChallengeRef = {
  userId: string;
  sessionId: string;
  taskId: string;
  domain: string;
  channel: ChallengeChannel;
};

export type ChallengeTicket = {
  challengeId: string;
  token: string;
  expiresAt: number;
};

export type ChallengeView = ChallengeRef & {
  challengeId: string;
  expiresAt: number;
  state: ChallengeState;
};

type ChallengeState = "open" | "used" | "cancelled" | "expired";

export type SubmitRejection = "unknown" | "owner" | "device" | "token" | "expired" | "used" | "cancelled" | "format";

export type SubmitInput = {
  userId: string;
  deviceId: string | null;
  /** True when the signed-in user typed the code themselves in Scout. */
  manual?: boolean;
  challengeId: string;
  token: string;
  code: string;
};

type Challenge = ChallengeRef & {
  id: string;
  tokenHash: Buffer;
  expiresAt: number;
  state: ChallengeState;
  devices: ReadonlySet<string> | null;
  waiter: { resolve: (code: string) => void; reject: (reason: Error) => void } | null;
  early: string | null;
};

const ID = /^[a-f0-9]{32}$/;
const CODE = /^\d{4,8}$/;
const DEFAULT_TTL_MS = 5 * 60_000;
const SETTLED_KEEP_MS = 10 * 60_000;

export class ChallengeClosed extends Error {
  readonly reason: "expired" | "cancelled";

  constructor(reason: "expired" | "cancelled") {
    super(reason === "expired" ? "The verification code did not arrive in time." : "The verification was cancelled.");
    this.reason = reason;
  }
}

/**
 * Holds one-time verification codes in memory only. A code is handed to the
 * browser task that opened the challenge and then dropped; it is never stored.
 */
export class OtpBroker {
  private readonly challenges = new Map<string, Challenge>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(now: () => number, ttlMs = DEFAULT_TTL_MS) {
    this.now = now;
    this.ttlMs = ttlMs;
  }

  open(ref: ChallengeRef, devices: readonly string[] | null = null): ChallengeTicket {
    this.sweep();
    for (const existing of this.challenges.values()) {
      if (existing.state === "open" && existing.userId === ref.userId && existing.taskId === ref.taskId) {
        this.close(existing, "cancelled");
      }
    }
    const id = randomBytes(16).toString("hex");
    const token = randomBytes(16).toString("hex");
    const expiresAt = this.now() + this.ttlMs;
    this.challenges.set(id, {
      ...ref,
      id,
      tokenHash: digest(token),
      expiresAt,
      state: "open",
      devices: devices && devices.length > 0 ? new Set(devices) : null,
      waiter: null,
      early: null,
    });
    return { challengeId: id, token, expiresAt };
  }

  /** Resolves with the code for this challenge, or rejects when it expires or is cancelled. */
  wait(challengeId: string, signal?: AbortSignal): Promise<string> {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) return Promise.reject(new ChallengeClosed("cancelled"));
    if (challenge.early != null) {
      const code = challenge.early;
      challenge.early = null;
      return Promise.resolve(code);
    }
    if (challenge.state !== "open") return Promise.reject(new ChallengeClosed(challenge.state === "expired" ? "expired" : "cancelled"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(challenge, "expired"), Math.max(0, challenge.expiresAt - this.now()));
      const onAbort = () => this.close(challenge, "cancelled");
      signal?.addEventListener("abort", onAbort, { once: true });
      challenge.waiter = {
        resolve: (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(code);
        },
        reject: (reason) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(reason);
        },
      };
    });
  }

  submit(input: SubmitInput): { ok: true; taskId: string; sessionId: string } | { ok: false; reason: SubmitRejection } {
    if (!ID.test(input.challengeId) || !ID.test(input.token) || !CODE.test(input.code)) return { ok: false, reason: "format" };
    const challenge = this.challenges.get(input.challengeId);
    if (!challenge) return { ok: false, reason: "unknown" };
    if (challenge.userId !== input.userId) return { ok: false, reason: "owner" };
    if (!timingSafeEqual(challenge.tokenHash, digest(input.token))) return { ok: false, reason: "token" };
    if (challenge.state === "open" && this.now() >= challenge.expiresAt) this.close(challenge, "expired");
    if (challenge.state !== "open") return { ok: false, reason: challenge.state };
    if (challenge.devices && input.manual !== true && (input.deviceId == null || !challenge.devices.has(input.deviceId))) return { ok: false, reason: "device" };
    challenge.state = "used";
    const waiter = challenge.waiter;
    challenge.waiter = null;
    if (waiter) waiter.resolve(input.code);
    else challenge.early = input.code;
    return { ok: true, taskId: challenge.taskId, sessionId: challenge.sessionId };
  }

  /** Finds the user's single open challenge, for a code typed into the web app. */
  openFor(userId: string): ChallengeView | null {
    this.sweep();
    const open = [...this.challenges.values()].filter((item) => item.userId === userId && item.state === "open");
    return open.length === 1 && open[0] ? view(open[0]) : null;
  }

  cancelTask(taskId: string): void {
    for (const challenge of this.challenges.values()) {
      if (challenge.taskId === taskId && challenge.state === "open") this.close(challenge, "cancelled");
    }
  }

  cancelSession(sessionId: string): void {
    for (const challenge of this.challenges.values()) {
      if (challenge.sessionId === sessionId && challenge.state === "open") this.close(challenge, "cancelled");
    }
  }

  get(challengeId: string): ChallengeView | null {
    const challenge = this.challenges.get(challengeId);
    return challenge ? view(challenge) : null;
  }

  sweep(): void {
    const now = this.now();
    for (const challenge of [...this.challenges.values()]) {
      if (challenge.state === "open" && now >= challenge.expiresAt) this.close(challenge, "expired");
      if (challenge.state !== "open" && now >= challenge.expiresAt + SETTLED_KEEP_MS) this.challenges.delete(challenge.id);
    }
  }

  private close(challenge: Challenge, state: "expired" | "cancelled"): void {
    if (challenge.state !== "open") return;
    challenge.state = state;
    challenge.early = null;
    const waiter = challenge.waiter;
    challenge.waiter = null;
    waiter?.reject(new ChallengeClosed(state));
  }
}

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function view(challenge: Challenge): ChallengeView {
  return {
    challengeId: challenge.id,
    userId: challenge.userId,
    sessionId: challenge.sessionId,
    taskId: challenge.taskId,
    domain: challenge.domain,
    channel: challenge.channel,
    expiresAt: challenge.expiresAt,
    state: challenge.state,
  };
}
