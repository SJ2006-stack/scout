import { useEffect, useRef, useState } from "react";
import {
  compactReading,
  kindLabel,
  screenAsksForAction,
  screenSuggestions,
  sourceLabel,
  type ScreenReading,
} from "../shared/screenReading.ts";
import { understandScreen } from "./screenUnderstand.ts";
import { fillOpenScreen, finishScreenShot, type ScreenUi } from "./scoutScreen.ts";
import "./scoutScreen.css";

type ScreenCardProps = {
  view: Exclude<ScreenUi, { phase: "closed" }>;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onCapture: () => void;
  onDiscard: () => void;
  onClose: () => void;
  onSend: (text: string, reading: ScreenReading) => void;
  onToast: (message: string) => void;
  prior: string;
  person: { name: string | null; email: string | null; phone: string | null };
};

/** Review a recorded clip, then send the latest moment. A command already given is carried out. Nothing leaves the phone until then. */
export function ScreenCard({ view, busy, onStart, onStop, onCapture, onDiscard, onClose, onSend, onToast, prior, person }: ScreenCardProps) {
  const [question, setQuestion] = useState(prior || "What am I looking at?");
  const [reading, setReading] = useState<ScreenReading | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const shotId = view.phase === "preview" ? view.shot.id : view.phase;
  const acted = useRef("");
  const toastRef = useRef(onToast);
  const sendRef = useRef(onSend);
  const closeRef = useRef(onClose);
  sendRef.current = onSend;
  closeRef.current = onClose;
  toastRef.current = onToast;

  useEffect(() => {
    setReading(null);
    setAnalyzing(false);
    setQuestion(prior || "What am I looking at?");
  }, [shotId, prior]);

  useEffect(() => {
    if (view.phase !== "preview" || busy || !screenAsksForAction(prior) || acted.current === view.shot.id) return;
    const shot = view.shot;
    const file = view.file;
    acted.current = shot.id;
    let cancel = false;
    setAnalyzing(true);
    understandScreen(file)
      .then((next) => {
        if (cancel) return;
        setReading(next);
        finishScreenShot(shot);
        sendRef.current(prior, compactReading(next));
        closeRef.current();
      })
      .catch((error: unknown) => {
        if (!cancel) toastRef.current(error instanceof Error ? error.message : "Scout could not read the screen right now.");
      })
      .finally(() => {
        if (!cancel) setAnalyzing(false);
      });
    return () => {
      cancel = true;
    };
  }, [shotId, busy, prior, view]);

  useEffect(() => {
    if (view.phase !== "progress" || view.state !== "waiting") return;
    const submit = /\b(submit|send|finish|complete)\b/i.test(prior);
    let attempts = 0;
    let stop = false;
    const tick = () => {
      if (stop || attempts >= 8) return;
      attempts += 1;
      const result = fillOpenScreen({
        name: person.name ?? "",
        email: person.email ?? "",
        phone: person.phone ?? "",
        note: prior,
        submit,
      });
      if (result && result.filled > 0) {
        stop = true;
        if (result.message) toastRef.current(result.message);
      }
    };
    const timer = window.setInterval(tick, 3000);
    const first = window.setTimeout(tick, 1200);
    return () => {
      stop = true;
      window.clearInterval(timer);
      window.clearTimeout(first);
    };
  }, [view.phase === "progress" ? view.state : view.phase, prior, person.name, person.email, person.phone]);

  async function analyze(): Promise<void> {
    if (view.phase !== "preview" || busy || analyzing) return;
    setAnalyzing(true);
    try {
      const next = await understandScreen(view.file);
      setReading(next);
    } catch (error: unknown) {
      onToast(error instanceof Error ? error.message : "Scout could not read the screen right now.");
    } finally {
      setAnalyzing(false);
    }
  }

  function send(text: string, next: ScreenReading): void {
    if (busy || view.phase !== "preview") return;
    finishScreenShot(view.shot);
    onSend(text, compactReading(next));
    onClose();
  }

  if (view.phase === "explain") {
    return (
      <section className="screen-card" aria-label="Understand my screen">
        <header className="screen-head">
          <strong>Understand my screen</strong>
          <span className="muted">Android will ask to share a screen. Prefer sharing one app window when the phone offers it. Scout then records a short clip. It uploads the latest moment only if you send it{prior ? `, and it will carry out “${prior}”` : ""}.</span>
        </header>
        <div className="screen-actions">
          <button type="button" className="text-button" onClick={onClose}>Cancel</button>
          <button type="button" className="screen-send" onClick={onStart}>Continue</button>
        </div>
      </section>
    );
  }

  if (view.phase === "progress") {
    const waiting = view.state === "waiting";
    return (
      <section className="screen-card" aria-label="Screen capture">
        <header className="screen-head">
          <strong>{waiting ? "Scout is recording" : "Allow screen recording"}</strong>
          <span className="muted">
            {waiting
              ? `Open the form or app. Scout types your name, email, and phone into the fields it can see${prior ? `, and follows “${prior}”` : ""}. It taps Submit only if you asked. Tap Stop when you are done.`
              : "Approve Android's screen-capture prompt. Scout records until you tap Stop."}
          </span>
        </header>
        <div className="screen-actions">
          <button type="button" className="text-button" onClick={onStop}>Stop</button>
          {waiting ? <button type="button" className="screen-send" onClick={onCapture}>Save this moment</button> : null}
        </div>
      </section>
    );
  }

  if (view.phase === "error") {
    return (
      <section className="screen-card" aria-label="Screen capture">
        <header className="screen-head">
          <strong>Screen capture</strong>
          <span className="muted">{view.message}</span>
        </header>
        <div className="screen-actions">
          <button type="button" className="text-button" onClick={onClose}>Close</button>
          <button type="button" className="screen-send" onClick={onStart}>Try again</button>
        </div>
      </section>
    );
  }

  const items = reading?.items.slice(0, 6) ?? [];
  return (
    <section className="screen-card" aria-label="Captured screen">
      <header className="screen-head">
        <strong>{reading ? kindLabel(reading.kind) : "Captured screen"}</strong>
        <span className="muted">
          {reading
            ? reading.summary
            : view.shot.frames > 1
              ? `Recorded ${view.shot.frames} moments. The latest is still on the phone. Send it for Scout to read, or discard it.`
              : "This moment is still on the phone. Send it for Scout to read, or discard it."}
        </span>
      </header>
      <img className="screen-preview" src={view.url} alt="Captured screen" />
      {reading?.sensitive.length ? <p className="screen-notes">Scout hid secrets it recognised ({reading.sensitive.join(", ")}).</p> : null}
      {reading?.embeddedInstructions ? <p className="screen-notes">Text on that screen looked like an instruction to an assistant. Scout will not follow it.</p> : null}
      {items.length > 0 ? (
        <ul className="screen-fields">
          {items.map((item) => (
            <li key={item.title}>
              <strong>{item.title}</strong>
              {item.fields.slice(0, 4).map((field) => (
                <span key={`${item.title}-${field.label}`}> {field.label}: {field.value} ({sourceLabel(field.source)})</span>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
      {reading ? (
        <>
          <textarea
            className="screen-ask"
            value={question}
            rows={2}
            aria-label="Ask Scout about this screen"
            onChange={(event) => setQuestion(event.target.value)}
          />
          <div className="screen-ideas">
            {screenSuggestions(reading).map((idea) => (
              <button key={idea.label} type="button" disabled={busy} onClick={() => send(idea.label, reading)}>
                {idea.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
      <div className="screen-actions">
        <button type="button" className="text-button" disabled={analyzing} onClick={onDiscard}>Discard</button>
        {reading ? (
          <button type="button" className="screen-send" disabled={busy || question.trim().length === 0} onClick={() => send(question.trim(), reading)}>
            Ask Scout
          </button>
        ) : (
          <button type="button" className="screen-send" disabled={busy || analyzing} onClick={() => void analyze()}>
            {analyzing ? "Reading screen…" : "Send for analysis"}
          </button>
        )}
      </div>
    </section>
  );
}
