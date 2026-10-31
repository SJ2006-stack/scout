import type { PayLink } from "./payLink.ts";

export type ScoutTaskState =
  | "connecting"
  | "opening"
  | "signing_in"
  | "waiting_verification"
  | "authenticated"
  | "searching"
  | "comparing"
  | "cart_prepared"
  | "approval_required"
  | "payment_handoff"
  | "provider_confirmed"
  | "needs_user"
  | "failed"
  | "cancelled";

export type ScoutTaskKind = "sign_in" | "shop" | "checkout" | "confirm";

export type CartView = {
  merchant: string;
  lines: { title: string; quantity: number; rupees: number }[];
  fees: { label: string; rupees: number }[];
  totalRupees: number;
};

export type ScoutTaskEvent = {
  state: ScoutTaskState;
  at: number;
  message: string;
  /** Present only while a verification code is awaited. Never stored. */
  challenge?: { challengeId: string; token: string; channel: "sms" | "email" | "manual"; expiresAt: number };
  approval?: { checkoutId: string; fingerprint: string; cart: CartView; expiresAt: number };
  pay?: PayLink;
  orderId?: string | null;
};

export type ScoutTaskView = {
  id: string;
  kind: ScoutTaskKind;
  skill: string;
  state: ScoutTaskState;
  events: ScoutTaskEvent[];
  createdAt: number;
  updatedAt: number;
};

export const TASK_STATE_TEXT: Readonly<Record<ScoutTaskState, string>> = {
  connecting: "Connecting to provider",
  opening: "Opening website",
  signing_in: "Signing in",
  waiting_verification: "Waiting for verification",
  authenticated: "Authentication successful",
  searching: "Searching",
  comparing: "Comparing",
  cart_prepared: "Cart prepared",
  approval_required: "Approval required",
  payment_handoff: "Payment handoff",
  provider_confirmed: "Provider confirmation received",
  needs_user: "Your turn",
  failed: "Stopped",
  cancelled: "Cancelled",
};

export function isTerminalState(state: ScoutTaskState): boolean {
  switch (state) {
    case "provider_confirmed":
    case "failed":
    case "cancelled":
    case "approval_required":
    case "payment_handoff":
    case "needs_user":
    case "authenticated":
      return true;
    case "connecting":
    case "opening":
    case "signing_in":
    case "waiting_verification":
    case "searching":
    case "comparing":
    case "cart_prepared":
      return false;
    default: {
      const neverState: never = state;
      return neverState;
    }
  }
}
