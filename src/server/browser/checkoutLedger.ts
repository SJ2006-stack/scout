import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PayLink } from "../../shared/payLink.ts";

export type CartLine = { title: string; quantity: number; paise: number };
export type CartFee = { label: string; paise: number };

export type CartReview = {
  skill: string;
  merchant: string;
  pageUrl: string;
  lines: CartLine[];
  fees: CartFee[];
  totalPaise: number;
};

export type CheckoutState = "proposed" | "approved" | "initiating" | "handoff" | "confirmed" | "changed" | "timed_out" | "cancelled" | "failed";

export type CheckoutRecord = {
  id: string;
  userId: string;
  review: CartReview;
  fingerprint: string;
  state: CheckoutState;
  createdAt: number;
  expiresAt: number;
  approvedAt: number | null;
  idempotencyKey: string | null;
  handoff: { pay: PayLink | null; at: number; deadline: number } | null;
  confirmation: { orderId: string | null; at: number } | null;
  note: string | null;
};

export type Initiation =
  | { action: "click"; record: CheckoutRecord }
  | { action: "replay"; record: CheckoutRecord }
  | { action: "reject"; reason: "missing" | "owner" | "not_approved" | "expired" | "changed" | "closed"; record: CheckoutRecord | null };

const APPROVAL_TTL_MS = 10 * 60_000;
const PAYMENT_WINDOW_MS = 15 * 60_000;
const KEEP_MS = 24 * 60 * 60_000;
const KEY = /^[A-Za-z0-9_-]{8,80}$/;

/**
 * The approval record for one exact cart. The browser presses a payment
 * button only for an approved record whose fingerprint still matches the
 * cart on screen, and only once per record.
 */
export class CheckoutLedger {
  private readonly file: string;
  private readonly now: () => number;

  constructor(file: string, now: () => number) {
    this.file = file;
    this.now = now;
  }

  propose(userId: string, review: CartReview): CheckoutRecord {
    const fingerprint = cartFingerprint(review);
    return this.mutate((records) => {
      const now = this.now();
      const open = records.find((item) => item.userId === userId && item.fingerprint === fingerprint && item.state === "proposed" && now < item.expiresAt);
      if (open) return open;
      const record: CheckoutRecord = {
        id: randomBytes(16).toString("hex"),
        userId,
        review,
        fingerprint,
        state: "proposed",
        createdAt: now,
        expiresAt: now + APPROVAL_TTL_MS,
        approvedAt: null,
        idempotencyKey: null,
        handoff: null,
        confirmation: null,
        note: null,
      };
      records.push(record);
      return record;
    });
  }

  /** The user approves the exact cart they were shown, named by its fingerprint. */
  approve(userId: string, id: string, fingerprint: string): { ok: true; record: CheckoutRecord } | { ok: false; reason: "missing" | "owner" | "expired" | "mismatch" | "closed" } {
    return this.mutate((records) => {
      const record = records.find((item) => item.id === id);
      if (!record) return { ok: false, reason: "missing" };
      if (record.userId !== userId) return { ok: false, reason: "owner" };
      if (record.state === "approved") return { ok: true, record };
      if (record.state !== "proposed") return { ok: false, reason: "closed" };
      if (this.now() >= record.expiresAt) {
        record.state = "cancelled";
        record.note = "The approval window closed.";
        return { ok: false, reason: "expired" };
      }
      if (record.fingerprint !== fingerprint) return { ok: false, reason: "mismatch" };
      record.state = "approved";
      record.approvedAt = this.now();
      return { ok: true, record };
    });
  }

  /**
   * Called with the cart as it is on screen right before the payment click.
   * Returns "click" exactly once. A repeat returns the earlier result.
   */
  beginInitiation(userId: string, id: string, idempotencyKey: string, current: CartReview): Initiation {
    return this.mutate((records) => {
      const record = records.find((item) => item.id === id) ?? null;
      if (!record) return { action: "reject", reason: "missing", record: null };
      if (record.userId !== userId) return { action: "reject", reason: "owner", record: null };
      if (record.state === "initiating" || record.state === "handoff" || record.state === "confirmed") return { action: "replay", record };
      if (record.state !== "approved") return { action: "reject", reason: record.state === "proposed" ? "not_approved" : "closed", record };
      if (!KEY.test(idempotencyKey)) return { action: "reject", reason: "closed", record };
      if (this.now() >= record.expiresAt) {
        record.state = "cancelled";
        record.note = "The approval window closed.";
        return { action: "reject", reason: "expired", record };
      }
      if (cartFingerprint(current) !== record.fingerprint) {
        record.state = "changed";
        record.note = `The cart changed after approval. It was ₹${rupees(record.review.totalPaise)} and is now ₹${rupees(current.totalPaise)}.`;
        return { action: "reject", reason: "changed", record };
      }
      const replay = records.find((item) => item.userId === userId && item.idempotencyKey === idempotencyKey && item.id !== id);
      if (replay) return { action: "replay", record: replay };
      record.state = "initiating";
      record.idempotencyKey = idempotencyKey;
      return { action: "click", record };
    });
  }

  recordHandoff(id: string, pay: PayLink | null): CheckoutRecord | null {
    return this.mutate((records) => {
      const record = records.find((item) => item.id === id);
      if (!record || record.state !== "initiating") return record ?? null;
      const now = this.now();
      record.state = "handoff";
      record.handoff = { pay, at: now, deadline: now + PAYMENT_WINDOW_MS };
      return record;
    });
  }

  fail(id: string, note: string): CheckoutRecord | null {
    return this.mutate((records) => {
      const record = records.find((item) => item.id === id);
      if (!record || record.state === "confirmed") return record ?? null;
      record.state = "failed";
      record.note = note;
      return record;
    });
  }

  /** Only a provider page that shows the order counts as confirmation. */
  confirm(id: string, orderId: string | null): CheckoutRecord | null {
    return this.mutate((records) => {
      const record = records.find((item) => item.id === id);
      if (!record || record.state !== "handoff") return record ?? null;
      record.state = "confirmed";
      record.confirmation = { orderId, at: this.now() };
      return record;
    });
  }

  get(userId: string, id: string): CheckoutRecord | null {
    return this.mutate((records) => {
      const record = records.find((item) => item.id === id);
      return record && record.userId === userId ? record : null;
    });
  }

  private settle(records: CheckoutRecord[]): CheckoutRecord[] {
    const now = this.now();
    for (const record of records) {
      if (record.state === "handoff" && record.handoff && now >= record.handoff.deadline) {
        record.state = "timed_out";
        record.note = "No order confirmation arrived before the payment window closed.";
      }
      if (record.state === "proposed" && now >= record.expiresAt) {
        record.state = "cancelled";
        record.note = "The approval window closed.";
      }
    }
    return records.filter((record) => now < record.createdAt + KEEP_MS);
  }

  private mutate<T>(fn: (records: CheckoutRecord[]) => T): T {
    const records = this.settle(this.read());
    const result = fn(records);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, records }), { mode: 0o600 });
    renameSync(tmp, this.file);
    return result;
  }

  private read(): CheckoutRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { version?: number; records?: unknown };
      return parsed.version === 1 && Array.isArray(parsed.records) ? (parsed.records as CheckoutRecord[]) : [];
    } catch {
      return [];
    }
  }
}

export function cartFingerprint(review: CartReview): string {
  const canonical = {
    skill: review.skill,
    lines: [...review.lines].map((line) => [line.title.trim().toLowerCase(), line.quantity, line.paise]).sort(),
    fees: [...review.fees].map((fee) => [fee.label.trim().toLowerCase(), fee.paise]).sort(),
    total: review.totalPaise,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
}

function rupees(paise: number): string {
  return (paise / 100).toFixed(paise % 100 === 0 ? 0 : 2);
}
