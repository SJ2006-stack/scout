import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { thoughtLabel } from "../shared/thinking.ts";

export function Thinking({
  steps,
  startedAt,
  finishedAt,
}: {
  steps: readonly string[];
  startedAt: number;
  finishedAt: number | null;
}) {
  const live = finishedAt == null;
  const [open, setOpen] = useState(live);

  useEffect(() => {
    setOpen(live);
  }, [live]);

  return (
    <div className="thinking">
      <button className="thinking-toggle" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={16} className={open ? "thinking-chevron open" : "thinking-chevron"} />
        <span className={live ? "thinking-label live" : "thinking-label"}>{thoughtLabel(startedAt, finishedAt)}</span>
      </button>
      {open && steps.length > 0 ? (
        <ol className="thinking-steps">
          {steps.map((step, index) => (
            <li key={`${index}-${step}`}>{step}</li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
