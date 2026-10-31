import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { gmailAddress } from "../../shared/onboarding.ts";
import type { UserDirectory } from "../db/userDirectory.ts";

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export type AuthMailer = {
  configured: boolean;
  send(to: string, subject: string, text: string): Promise<void>;
};

export type AuthResult =
  | { ok: true; kind: "sent"; email: string }
  | { ok: true; kind: "session"; userId: string; email: string }
  | { ok: false; status: number; error: string };

export class EmailAuth {
  private readonly directory: UserDirectory;
  private readonly mailer: AuthMailer;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly sentAt = new Map<string, number>();

  constructor(directory: UserDirectory, mailer: AuthMailer, now: () => number, minIntervalMs = 60_000) {
    this.directory = directory;
    this.mailer = mailer;
    this.now = now;
    this.minIntervalMs = minIntervalMs;
  }

  account(userId: string | null): { id: string; email: string; phone: string | null; name: string | null } | null {
    if (!userId) return null;
    return this.directory.account(userId);
  }

  async requestCode(rawEmail: string): Promise<AuthResult> {
    const email = gmailAddress(rawEmail);
    if (!email) return { ok: false, status: 400, error: "Use a Gmail address." };
    if (!this.mailer.configured) return { ok: false, status: 503, error: "Email is not connected." };
    const previous = this.sentAt.get(email);
    const now = this.now();
    if (previous != null && now - previous < this.minIntervalMs) {
      return { ok: false, status: 429, error: "Wait a minute before asking for another code." };
    }
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const salt = randomBytes(16).toString("hex");
    this.directory.saveCode(email, salt, hashCode(salt, code), now + CODE_TTL_MS);
    try {
      await this.mailer.send(email, "Your Scout code", `Your Scout sign-in code is ${code}. It expires in 10 minutes.`);
    } catch {
      this.directory.clearCode(email);
      return { ok: false, status: 502, error: "The code could not be sent." };
    }
    this.sentAt.set(email, now);
    return { ok: true, kind: "sent", email };
  }

  verify(rawEmail: string, rawCode: string): AuthResult {
    const email = gmailAddress(rawEmail);
    const code = rawCode.trim();
    if (!email || !/^\d{6}$/.test(code)) return { ok: false, status: 400, error: "Enter the 6-digit code from your email." };
    const pending = this.directory.codeFor(email);
    if (!pending) return { ok: false, status: 401, error: "That code is not valid. Ask for a new one." };
    if (this.now() >= pending.expiresAt || pending.attempts >= MAX_ATTEMPTS) {
      this.directory.clearCode(email);
      return { ok: false, status: 401, error: "That code has expired. Ask for a new one." };
    }
    const expected = Buffer.from(pending.codeHash, "hex");
    const actual = Buffer.from(hashCode(pending.salt, code), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      this.directory.bumpCode(email);
      const again = this.directory.codeFor(email);
      if (again && again.attempts >= MAX_ATTEMPTS) this.directory.clearCode(email);
      return { ok: false, status: 401, error: "That code does not match." };
    }
    this.directory.clearCode(email);
    const user = this.directory.ensureEmailUser(email, this.now());
    return { ok: true, kind: "session", userId: user.id, email: user.email };
  }
}

export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > 254 || !EMAIL.test(email)) return null;
  return email;
}

function hashCode(salt: string, code: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}
