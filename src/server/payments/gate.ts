import type {
  ApprovalRecord,
  ExecuteResult,
  GateExecuteInput,
  GateRejection,
  GateResult,
  PaymentAdapter,
} from "./types.ts";

const QUOTE_TTL_MS = 10 * 60_000;

export function quoteExpiry(now: number): number {
  return now + QUOTE_TTL_MS;
}

export class PaymentGate {
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly byApproval = new Map<string, string>();
  private readonly adapter: PaymentAdapter;
  private readonly now: () => number;
  private readonly ids: () => string;

  constructor(adapter: PaymentAdapter, now: () => number, ids: () => string) {
    this.adapter = adapter;
    this.now = now;
    this.ids = ids;
  }

  issueApproval(input: Omit<ApprovalRecord, "id">): ApprovalRecord {
    const record: ApprovalRecord = { ...input, id: this.ids() };
    this.approvals.set(record.id, record);
    return record;
  }

  issuedCount(): number {
    return this.approvals.size;
  }

  status(idempotencyKey: string): ExecuteResult | null {
    return this.adapter.getStatus(idempotencyKey);
  }

  execute(input: GateExecuteInput): GateResult {
    const boundKey = this.byApproval.get(input.approvalId);
    if (boundKey) {
      const existing = this.adapter.getStatus(boundKey);
      if (existing) return this.accepted(existing);
    }
    const replay = this.adapter.getStatus(input.idempotencyKey);
    if (replay) return this.accepted(replay);

    const rejection = this.rejection(input);
    if (rejection) return { ok: false, reason: rejection };
    const again = this.rejection(input);
    if (again) return { ok: false, reason: again };

    const prepared = this.adapter.prepare({
      merchant: input.merchant,
      amount: input.amount,
      currency: "INR",
      reference: input.quoteId,
    });
    const authorized = this.adapter.authorize({
      preparedId: prepared.preparedId,
      approvalId: input.approvalId,
    });
    const result = this.adapter.execute({
      authorizationId: authorized.authorizationId,
      idempotencyKey: input.idempotencyKey,
      amount: input.amount,
    });
    this.byApproval.set(input.approvalId, input.idempotencyKey);
    return this.accepted(result);
  }

  private rejection(input: GateExecuteInput): GateRejection | null {
    return assess(this.approvals.get(input.approvalId), input, this.now());
  }

  private accepted(result: ExecuteResult): GateResult {
    return { ok: true, result, receipt: this.adapter.verifyReceipt(result) };
  }
}

function assess(record: ApprovalRecord | undefined, input: GateExecuteInput, now: number): GateRejection | null {
  if (!record) return "missing";
  if (record.sessionId !== input.sessionId) return "session";
  if (record.quoteId !== input.quoteId || record.merchant !== input.merchant || record.fingerprint !== input.fingerprint || record.action !== input.action) {
    return "mismatch";
  }
  if (now >= record.expiresAt) return "expired";
  if (record.maxAmount == null || input.amount > record.maxAmount) return "scope";
  return null;
}
