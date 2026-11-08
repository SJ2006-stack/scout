import { useEffect, useState } from "react";
import {
  compactReading,
  kindLabel,
  screenSuggestions,
  sourceLabel,
  type ScreenReading,
} from "../shared/screenReading.ts";
import { understandScreen } from "./screenUnderstand.ts";
import { finishScreenShot, type ScreenUi } from "./scoutScreen.ts";
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
};

/** Review a captured frame, then send it for structured reading. Nothing leaves the phone until Send. */
export function ScreenCard({ view, busy, onStart, onStop, onCapture, onDiscard, onClose, onSend, onToast }: ScreenCardProps) {
  const [question, setQuestion] = useState("What am I looking at?");
  const [reading, setReading] = useState<ScreenReading | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const shotId = view.phase === "preview" ? view.shot.id : view.phase;

  useEffect(() => {
    setReading(null);
    setAnalyzing(false);
    setQuestion("What am I looking at?");
  }, [shotId]);

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
          <span className="muted">Android will ask to share a screen. Prefer sharing one app window when the phone offers it. Scout takes one picture after you tap Capture, shows it here, and uploads it only if you send it.</span>
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
          <strong>{waiting ? "Scout is waiting to capture" : "Allow screen capture"}</strong>
          <span className="muted">
            {waiting
              ? "Open the app you want Scout to see, then tap Capture in the notice or here. Scout takes one picture and stops."
              : "Approve Android's screen-capture prompt. Scout will not take a picture until you tap Capture."}
          </span>
        </header>
        <div className="screen-actions">
          <button type="button" className="text-button" onClick={onStop}>Stop</button>
          {waiting ? <button type="button" className="screen-send" onClick={onCapture}>Capture</button> : null}
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
            : "This picture is still on the phone. Send it for Scout to read, or discard it."}
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
