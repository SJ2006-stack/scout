import { useEffect, useState } from "react";
import type { PayLink } from "../shared/payLink.ts";
import { TASK_STATE_TEXT, type CartView, type ScoutTaskEvent, type ScoutTaskState, type ScoutTaskView } from "../shared/scoutTask.ts";
import { apiUrl, backendHeaders, newSessionId } from "./backend.ts";
import { openPayLink } from "./CommerceCard.tsx";

const POLL_MS = 1_500;

type Approval = NonNullable<ScoutTaskEvent["approval"]>;
type Challenge = NonNullable<ScoutTaskEvent["challenge"]>;

/** A live Blinkit or Zepto task: sign-in code, cart approval, UPI handoff, and order check. */
export function ScoutTaskCard({ taskId, title }: { taskId: string; title: string }) {
  const [currentId, setCurrentId] = useState(taskId);
  const [view, setView] = useState<ScoutTaskView | null>(null);
  const [checkoutId, setCheckoutId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(apiUrl(`/api/browser/scout/tasks/${currentId}`), { credentials: "include", headers: backendHeaders() });
        const payload = (await response.json()) as { task?: ScoutTaskView; error?: unknown };
        if (stopped) return;
        if (!response.ok || !payload.task) {
          setError(typeof payload.error === "string" ? payload.error : "Scout lost track of this task.");
          return;
        }
        setView(payload.task);
        const approval = latest(payload.task, "approval");
        if (approval) setCheckoutId(approval.checkoutId);
        const signedIn = payload.task.kind === "sign_in" && payload.task.state === "authenticated";
        if (keepsPolling(payload.task.state) && !signedIn) timer = window.setTimeout(() => void load(), POLL_MS);
      } catch {
        if (!stopped) timer = window.setTimeout(() => void load(), POLL_MS * 2);
      }
    };
    void load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [currentId]);

  const post = async (path: string, body: unknown): Promise<{ task?: ScoutTaskView; error?: unknown } | null> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(apiUrl(path), {
        method: "POST",
        credentials: "include",
        headers: backendHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { task?: ScoutTaskView; error?: unknown };
      if (!response.ok) setError(typeof payload.error === "string" ? payload.error : "That did not go through.");
      return response.ok ? payload : null;
    } catch {
      setError("Scout could not reach the server.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const follow = (payload: { task?: ScoutTaskView } | null): void => {
    if (!payload?.task) return;
    setView(payload.task);
    setCurrentId(payload.task.id);
  };

  const sendCode = async (challenge: Challenge): Promise<void> => {
    const typed = code.trim();
    if (!/^\d{4,8}$/.test(typed)) {
      setError("Enter the code from the SMS.");
      return;
    }
    const sent = await post(`/api/browser/scout/challenges/${challenge.challengeId}/code`, { token: challenge.token, code: typed });
    if (sent) setCode("");
  };

  const approve = async (approval: Approval): Promise<void> => {
    follow(await post(`/api/browser/scout/checkouts/${approval.checkoutId}/approve`, { fingerprint: approval.fingerprint, idempotencyKey: newSessionId() }));
  };

  const confirm = async (): Promise<void> => {
    if (checkoutId) follow(await post(`/api/browser/scout/checkouts/${checkoutId}/confirm`, {}));
  };

  const cancel = async (): Promise<void> => {
    follow(await post(`/api/browser/scout/tasks/${currentId}/cancel`, {}));
  };

  const state = view?.state ?? "connecting";
  const last = view?.events.at(-1);
  const challenge = state === "waiting_verification" ? latest(view, "challenge") : null;
  const approval = state === "approval_required" ? latest(view, "approval") : null;
  const pay = state === "payment_handoff" ? latest(view, "pay") : null;
  const orderId = state === "provider_confirmed" ? last?.orderId ?? null : null;

  return (
    <article className="review scout-task" aria-live="polite">
      <header>
        <strong>{title}</strong>
        <span>{TASK_STATE_TEXT[state]}</span>
      </header>
      {last ? <p>{last.message}</p> : <p>Starting.</p>}
      {challenge ? (
        <form
          className="scout-task-code"
          onSubmit={(event) => {
            event.preventDefault();
            void sendCode(challenge);
          }}
        >
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="Code from the SMS"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            aria-label="Verification code"
          />
          <button className="card-book" type="submit" disabled={busy}>Send code</button>
        </form>
      ) : null}
      {approval ? <CartLines cart={approval.cart} /> : null}
      {approval ? (
        <button className="card-book" type="button" disabled={busy} onClick={() => void approve(approval)}>
          Approve ₹{approval.cart.totalRupees}
        </button>
      ) : null}
      {pay ? <PayStep pay={pay} busy={busy} onPaid={() => void confirm()} /> : null}
      {orderId ? <p>Order ID {orderId}</p> : null}
      {keepsPolling(state) || state === "approval_required" ? (
        <button type="button" disabled={busy} onClick={() => void cancel()}>Cancel</button>
      ) : null}
      {error ? <p className="review-note">{error}</p> : null}
      <p className="review-note">Scout presses pay only after you approve. It never asks for a UPI PIN.</p>
    </article>
  );
}

function CartLines({ cart }: { cart: CartView }) {
  return (
    <ul>
      {cart.lines.map((line) => (
        <li key={`${line.title}-${line.rupees}`}>
          <span>{line.quantity} × {line.title}</span>
          <span>₹{line.rupees}</span>
        </li>
      ))}
      {cart.fees.map((fee) => (
        <li key={fee.label}>
          <span>{fee.label}</span>
          <span>₹{fee.rupees}</span>
        </li>
      ))}
      <li>
        <strong>Total</strong>
        <strong>₹{cart.totalRupees}</strong>
      </li>
    </ul>
  );
}

function PayStep({ pay, busy, onPaid }: { pay: PayLink; busy: boolean; onPaid: () => void }) {
  return (
    <>
      <button className="card-book" type="button" onClick={() => openPayLink(pay)}>Pay {pay.amount ?? ""} in your UPI app</button>
      <button type="button" disabled={busy} onClick={onPaid}>I have paid, check the order</button>
    </>
  );
}

function latest<K extends "approval" | "challenge" | "pay">(view: ScoutTaskView | null, field: K): NonNullable<ScoutTaskEvent[K]> | null {
  if (!view) return null;
  for (let index = view.events.length - 1; index >= 0; index -= 1) {
    const value = view.events[index]?.[field];
    if (value != null) return value as NonNullable<ScoutTaskEvent[K]>;
  }
  return null;
}

function keepsPolling(state: ScoutTaskState): boolean {
  switch (state) {
    case "connecting":
    case "opening":
    case "signing_in":
    case "waiting_verification":
    case "authenticated":
    case "searching":
    case "comparing":
    case "cart_prepared":
      return true;
    case "approval_required":
    case "payment_handoff":
    case "provider_confirmed":
    case "needs_user":
    case "failed":
    case "cancelled":
      return false;
    default: {
      const neverState: never = state;
      return neverState;
    }
  }
}
