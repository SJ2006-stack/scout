import { useEffect, useState } from "react";
import { appName, type AutomationApp } from "../shared/deviceActions.ts";
import {
  PAY_MARKS_KEY,
  browserCartUrl,
  groupPayReady,
  marksEqual,
  nextPayStatus,
  readPayMarks,
  serializePayMarks,
  syncPayMarks,
  visiblePayRows,
  type PayMark,
  type PayReady,
} from "../shared/payReady.ts";
import type { PhoneRun } from "../shared/phoneRun.ts";
import { requestOpenCheckout } from "./openCheckout.ts";

export function PayTray({ runs }: { runs: readonly PhoneRun[] }) {
  const [now, setNow] = useState(() => Date.now());
  const [marks, setMarks] = useState<PayMark[]>(() => readPayMarks(storedMarks()));
  const [notes, setNotes] = useState<Partial<Record<AutomationApp, string>>>({});

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setMarks((current) => {
      const next = syncPayMarks(runs, Date.now(), current);
      if (marksEqual(current, next)) return current;
      storeMarks(serializePayMarks(next));
      return next;
    });
  }, [runs, now]);

  const rows = visiblePayRows(groupPayReady(runs, now, marks));
  if (rows.length === 0) return null;

  function remember(row: PayReady, action: "open" | "paid" | "fail"): void {
    const status = nextPayStatus(row.status, action, row.holdExpiresAt, now);
    setMarks((current) => {
      const next = current.some((mark) => mark.taskId === row.taskId)
        ? current.map((mark) => (mark.taskId === row.taskId ? { ...mark, status } : mark))
        : [...current, { taskId: row.taskId, readyAt: row.readyAt, status }];
      storeMarks(serializePayMarks(next));
      return next;
    });
  }

  function pay(row: PayReady): void {
    if (row.status === "paid" || row.status === "expired") return;
    const native = requestOpenCheckout(row.app);
    if (native) {
      if (native.status === "app_missing" || !native.accepted) {
        const missing = native.status === "app_missing";
        const text = missing ? `${appName(row.app)} is not installed on this phone.` : `The Scout app could not open ${appName(row.app)}.`;
        setNotes((current) => ({ ...current, [row.app]: text }));
        remember(row, "fail");
        return;
      }
      setNotes((current) => ({ ...current, [row.app]: `Opened ${appName(row.app)}. You tap Place Order. Scout never does.` }));
      remember(row, "open");
      return;
    }
    const url = browserCartUrl(row.app, linkFor(runs, row.app));
    if (url && url.startsWith("https://")) window.open(url, "_blank", "noopener,noreferrer");
    const where = row.kind === "booking" ? "The seats are on your phone." : "The cart is on your phone.";
    setNotes((current) => ({ ...current, [row.app]: `Opened a copy in a new tab. ${where} You place the order there.` }));
    remember(row, "open");
  }

  return (
    <section className="pay-tray" aria-label="Ready to pay">
      {rows.map((row) => (
        <article className="pay-tray-row" key={row.taskId}>
          <header>
            <strong>{appName(row.app)}</strong>
            <span>{rupees(row.total)}</span>
          </header>
          <ul>
            {row.lines.map((line, index) => <li key={`${row.taskId}-${index}`}>{line}</li>)}
          </ul>
          {row.holdExpiresAt != null ? <p className="pay-hold">{holdLabel(row.holdExpiresAt, now)}</p> : null}
          {notes[row.app] ? <p className="pay-note">{notes[row.app]}</p> : null}
          <div className="pay-actions">
            <button className="pay-go" type="button" disabled={row.status === "expired" || row.status === "paid"} onClick={() => pay(row)}>
              Pay in {appName(row.app)}
            </button>
            <button className="pay-paid" type="button" disabled={row.status === "failed" || row.status === "paid"} onClick={() => remember(row, "paid")}>
              I paid
            </button>
          </div>
        </article>
      ))}
      <p className="pay-note">Scout never taps Pay or Place Order.</p>
    </section>
  );
}

function linkFor(runs: readonly PhoneRun[], app: AutomationApp): string | undefined {
  let link: string | undefined;
  for (const run of runs) if (run.app === app) link = run.link;
  return link;
}

function holdLabel(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return "Seat hold ended";
  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  return `Seat hold ${minutes}:${String(seconds).padStart(2, "0")}`;
}

function rupees(value: number | null): string {
  return value == null ? "Not shown" : `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function storedMarks(): string | null {
  try {
    return localStorage.getItem(PAY_MARKS_KEY);
  } catch {
    return null;
  }
}

function storeMarks(raw: string): void {
  try {
    localStorage.setItem(PAY_MARKS_KEY, raw);
  } catch {
    // The tray still works for this page view when storage is blocked.
  }
}
