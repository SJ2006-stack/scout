import { randomBytes } from "node:crypto";
import { PAIR_WINDOW_MS, SCOUT_USER, type PairTicket } from "../shared/pairCode.ts";

export class PairTickets {
  private windowStart = -1;
  private code = "";
  private readonly now: () => number;
  private readonly nextCode: () => string;

  constructor(now: () => number, nextCode: () => string = () => randomBytes(16).toString("hex")) {
    this.now = now;
    this.nextCode = nextCode;
  }

  current(): PairTicket {
    const issuedAt = Math.floor(this.now() / PAIR_WINDOW_MS) * PAIR_WINDOW_MS;
    if (issuedAt !== this.windowStart) {
      this.windowStart = issuedAt;
      this.code = this.nextCode();
    }
    return {
      userId: SCOUT_USER,
      code: this.code,
      issuedAt,
      expiresAt: issuedAt + PAIR_WINDOW_MS,
    };
  }
}
