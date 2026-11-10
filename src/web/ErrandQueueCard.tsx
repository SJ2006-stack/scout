import type { ErrandQueue, QueueState } from "../shared/errandQueue.ts";

/** The live list of tasks from one message. Each row updates in place. */
export function ErrandQueueCard({ queue }: { queue: ErrandQueue }) {
  return (
    <section className="queue" aria-label="Task queue">
      <h3>Queue</h3>
      <ol>
        {queue.items.map((item, index) => (
          <li key={`${index}-${item.label}`} className={`queue-row ${item.state}`}>
            <span className="queue-label">{item.label}</span>
            <span className="queue-state">{stateText(item.state)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function stateText(state: QueueState): string {
  switch (state) {
    case "waiting":
      return "Waiting";
    case "running":
      return "Now";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    default: {
      const neverState: never = state;
      return neverState;
    }
  }
}
