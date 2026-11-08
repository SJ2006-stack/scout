import { useState } from "react";
import type { ErrandForm, ErrandQuestion } from "../shared/errands.ts";
import { readAttachment } from "./ocr.ts";

/** A scout's questions in one card: Main Scout's for every task in a message, or one scout's ask_user. Sending it carries on. */
export function ErrandFormCard({
  form,
  answered,
  busy,
  onSubmit,
}: {
  form: ErrandForm;
  answered: boolean;
  busy: boolean;
  onSubmit: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [reading, setReading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (id: string, value: string) => setValues((current) => ({ ...current, [id]: value }));
  const missing = form.questions.filter((question) => !(values[question.id] ?? "").trim()).length;
  const several = form.tasks.length > 1;

  async function attach(question: ErrandQuestion, file: File | undefined): Promise<void> {
    if (!file) return;
    setReading(question.id);
    setProblem(null);
    try {
      set(question.id, await readAttachment(file));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That photo could not be read.");
    } finally {
      setReading(null);
    }
  }

  return (
    <article className="review errand-form">
      <header>
        <strong>{several ? "Before I start" : "A few details"}</strong>
        {several ? <span>{form.tasks.length} tasks</span> : null}
      </header>
      {several ? (
        <ol className="errand-tasks">
          {form.tasks.map((task, index) => (
            <li key={`${index}-${task}`}>{task}</li>
          ))}
        </ol>
      ) : form.tasks[0] ? (
        <p className="review-note">{form.tasks[0]}</p>
      ) : null}
      {form.questions.map((question) => (
        <fieldset className="errand-question" key={question.id} disabled={answered || busy}>
          <legend>{question.prompt}</legend>
          {question.kind === "photo" ? (
            <>
              <label className="chip">
                {reading === question.id ? "Reading the photo…" : "Attach a photo"}
                <input type="file" accept="image/*" hidden onChange={(event) => void attach(question, event.target.files?.[0])} />
              </label>
              <textarea value={values[question.id] ?? ""} rows={4} placeholder="Or type or paste it here" onChange={(event) => set(question.id, event.target.value)} />
            </>
          ) : (
            <>
              {question.options.length > 0 ? (
                <div className="prompt-row">
                  {question.options.map((option) => (
                    <button
                      type="button"
                      key={option}
                      className={values[question.id] === option ? "chip on" : "chip"}
                      aria-pressed={values[question.id] === option}
                      onClick={() => set(question.id, option)}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              ) : null}
              <input
                type="text"
                placeholder={question.options.length > 0 ? "Or type your own" : "Type here"}
                value={question.options.includes(values[question.id] ?? "") ? "" : values[question.id] ?? ""}
                onChange={(event) => set(question.id, event.target.value)}
              />
            </>
          )}
        </fieldset>
      ))}
      {problem ? <p className="review-note">{problem}</p> : null}
      <button type="button" disabled={answered || busy || reading != null} onClick={() => onSubmit(values)}>
        {answered ? "Sent" : `${several ? "Start everything" : "Send answers"}${missing > 0 ? ` (${missing} left blank)` : ""}`}
      </button>
    </article>
  );
}
