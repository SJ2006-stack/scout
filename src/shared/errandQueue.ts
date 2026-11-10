/** One row in the phone's task queue. The card updates in place as the queue moves. */
export type QueueState = "waiting" | "running" | "done" | "failed";

export type QueueItem = {
  label: string;
  state: QueueState;
};

export type ErrandQueue = {
  items: QueueItem[];
};

const QUEUE_LIMIT = 6;

export function readErrandQueue(value: unknown): ErrandQueue | null {
  if (!value || typeof value !== "object") return null;
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0 || items.length > QUEUE_LIMIT) return null;
  const read: QueueItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") return null;
    const row = item as { label?: unknown; state?: unknown };
    if (typeof row.label !== "string") return null;
    const label = row.label.trim().slice(0, 160);
    if (label.length === 0) return null;
    const state = queueState(row.state);
    if (!state) return null;
    read.push({ label, state });
  }
  return { items: read };
}

function queueState(value: unknown): QueueState | null {
  switch (value) {
    case "waiting":
    case "running":
    case "done":
    case "failed":
      return value;
    default:
      return null;
  }
}
