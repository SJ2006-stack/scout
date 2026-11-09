import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { thoughtLabel, type ThinkingBrief } from "../shared/thinking.ts";

export function Thinking({
  steps,
  startedAt,
  finishedAt,
  brief,
}: {
  steps: readonly string[];
  startedAt: number;
  finishedAt: number | null;
  brief?: ThinkingBrief | null;
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
      {open && brief ? <ScoutBrief brief={brief} /> : null}
    </div>
  );
}

function ScoutBrief({ brief }: { brief: ThinkingBrief }) {
  return (
    <div className="thinking-brief">
      <p className="thinking-kicker">{brief.fed ? `System prompt sent to ${brief.scout}` : `System prompt ${brief.scout} has`}</p>
      {brief.fed ? null : <p className="thinking-note">Not sent on this pass. {brief.scout} fetched the sites directly.</p>}
      <pre className="thinking-prompt">{brief.prompt}</pre>
      <p className="thinking-kicker">Tools {brief.scout} has</p>
      {brief.tools.length === 0 ? <p className="thinking-note">No tools on this pass.</p> : (
        <ul className="thinking-tools">
          {brief.tools.map((tool) => (
            <li key={tool.name}>
              <strong>{tool.name}</strong>
              {tool.description ? <span>{tool.description}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
