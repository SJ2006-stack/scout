export type PaymentAction = "pay" | "book";

export type ApprovalRecord = {
  id: string;
  sessionId: string;
  merchant: string;
  quoteId: string;
  fingerprint: string;
  maxAmount: number | null;
  expiresAt: number;
  action: PaymentAction;
};

export type PrepareInput = {
  merchant: string;
  amount: number;
  currency: "INR";
  reference: string;
};

export type PreparedPayment = {
  preparedId: string;
  merchant: string;
  amount: number;
  currency: "INR";
};

export type AuthorizeInput = {
  preparedId: string;
  approvalId: string;
};

export type AuthorizedPayment = {
  authorizationId: string;
  preparedId: string;
  approvalId: string;
};

export type ExecuteInput = {
  authorizationId: string;
  idempotencyKey: string;
  amount: number;
};

export type PaymentOutcome = "succeeded" | "declined" | "expired" | "timeout";

export type ExecuteResult = {
  outcome: PaymentOutcome;
  idempotencyKey: string;
  transactionId: string;
  amount: number;
  simulated: boolean;
};

export type PaymentStatus = ExecuteResult & {
  resolved: boolean;
};

export type ReceiptCheck = {
  ok: boolean;
  simulated: boolean;
  transactionId: string;
};

export type GateExecuteInput = {
  approvalId: string;
  sessionId: string;
  amount: number;
  fingerprint: string;
  idempotencyKey: string;
  merchant: string;
  quoteId: string;
  action: PaymentAction;
};

export type GateRejection = "missing" | "session" | "scope" | "expired" | "mismatch";

export type GateResult =
  | { ok: true; result: ExecuteResult; receipt: ReceiptCheck }
  | { ok: false; reason: GateRejection };

export interface PaymentAdapter {
  prepare(input: PrepareInput): PreparedPayment;
  authorize(input: AuthorizeInput): AuthorizedPayment;
  execute(input: ExecuteInput): ExecuteResult;
  getStatus(idempotencyKey: string): PaymentStatus | null;
  verifyReceipt(result: ExecuteResult): ReceiptCheck;
}
