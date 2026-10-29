import type {
  AuthorizeInput,
  AuthorizedPayment,
  ExecuteInput,
  ExecuteResult,
  PaymentAdapter,
  PaymentOutcome,
  PaymentStatus,
  PrepareInput,
  PreparedPayment,
  ReceiptCheck,
} from "./types.ts";

export type SandboxScenario = "success" | "decline" | "expiry" | "timeout";

export class SandboxPayments implements PaymentAdapter {
  private readonly transactions = new Map<string, ExecuteResult>();
  private readonly scenario: SandboxScenario;
  private readonly ids: () => string;
  executeCount = 0;

  constructor(scenario: SandboxScenario, ids: () => string) {
    this.scenario = scenario;
    this.ids = ids;
  }

  prepare(input: PrepareInput): PreparedPayment {
    return {
      preparedId: this.ids(),
      merchant: input.merchant,
      amount: input.amount,
      currency: "INR",
    };
  }

  authorize(input: AuthorizeInput): AuthorizedPayment {
    return {
      authorizationId: this.ids(),
      preparedId: input.preparedId,
      approvalId: input.approvalId,
    };
  }

  execute(input: ExecuteInput): ExecuteResult {
    const existing = this.transactions.get(input.idempotencyKey);
    if (existing) return existing;
    this.executeCount += 1;
    const result: ExecuteResult = {
      outcome: outcomeFor(this.scenario),
      idempotencyKey: input.idempotencyKey,
      transactionId: this.ids(),
      amount: input.amount,
      simulated: true,
    };
    this.transactions.set(input.idempotencyKey, result);
    return result;
  }

  getStatus(idempotencyKey: string): PaymentStatus | null {
    const found = this.transactions.get(idempotencyKey);
    if (!found) return null;
    return { ...found, resolved: found.outcome !== "timeout" };
  }

  verifyReceipt(result: ExecuteResult): ReceiptCheck {
    const stored = this.transactions.get(result.idempotencyKey);
    const ok = stored != null && stored.transactionId === result.transactionId && stored.outcome === "succeeded";
    return { ok, simulated: true, transactionId: result.transactionId };
  }
}

function outcomeFor(scenario: SandboxScenario): PaymentOutcome {
  switch (scenario) {
    case "success":
      return "succeeded";
    case "decline":
      return "declined";
    case "expiry":
      return "expired";
    case "timeout":
      return "timeout";
    default: {
      const neverScenario: never = scenario;
      return neverScenario;
    }
  }
}
