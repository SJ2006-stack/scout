import { useEffect, useState, type FormEvent } from "react";
import type { BrowserSessionStatus, BrowserSessionView, BrowserTaskEvent, BrowserTaskStatus } from "../shared/browser.ts";
import { apiUrl } from "./backend.ts";
import { readSse } from "./sse.ts";

const headers = { "bypass-tunnel-reminder": "true" };

export function BrowserTasks() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<BrowserSessionView[]>([]);
  const [detail, setDetail] = useState<BrowserSessionView | null>(null);
  const [activity, setActivity] = useState<string[]>([]);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh(): Promise<void> {
    try {
      const response = await fetch(apiUrl("/api/browser/sessions"), { credentials: "include", headers });
      const payload = (await response.json()) as { sessions?: BrowserSessionView[]; error?: unknown };
      if (!response.ok || !payload.sessions) {
        setError(typeof payload.error === "string" ? payload.error : "Scout could not list browser sessions.");
        return;
      }
      setSessions(payload.sessions);
    } catch {
      setError("Scout could not reach the browser worker.");
    }
  }

  async function start(event: FormEvent): Promise<void> {
    event.preventDefault();
    const target = url.trim();
    if (target.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setDetail(null);
    try {
      const response = await fetch(apiUrl("/api/browser/sessions"), {
        method: "POST",
        credentials: "include",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ url: target }),
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: unknown };
        setError(typeof payload.error === "string" ? payload.error : "The browser session could not be started.");
        return;
      }
      let sessionId = "";
      const lines: string[] = [];
      await readSse<BrowserTaskEvent>(response, (item) => {
        if (item.sessionId) sessionId = item.sessionId;
        const line = activityLine(item);
        if (line) lines.push(line);
      });
      setActivity(lines);
      await refresh();
      if (sessionId) await viewStatus(sessionId, false);
    } catch {
      setError("Scout could not reach the browser worker.");
    } finally {
      setBusy(false);
    }
  }

  async function viewStatus(id: string, replaceActivity = true): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(apiUrl(`/api/browser/sessions/${id}`), { credentials: "include", headers });
      const payload = (await response.json()) as { session?: BrowserSessionView; error?: unknown };
      if (!response.ok || !payload.session) {
        setError(typeof payload.error === "string" ? payload.error : "Scout could not read that browser session.");
        return;
      }
      setDetail(payload.session);
      if (!replaceActivity) return;
      const events = await fetch(apiUrl(`/api/browser/tasks/${payload.session.taskId}/events`), { credentials: "include", headers });
      if (!events.ok) {
        const failure = (await events.json()) as { error?: unknown };
        setError(typeof failure.error === "string" ? failure.error : "Scout could not read the task activity.");
        return;
      }
      const lines: string[] = [];
      await readSse<BrowserTaskEvent>(events, (item) => {
        const line = activityLine(item);
        if (line) lines.push(line);
      });
      setActivity(lines);
    } catch {
      setError("Scout could not reach the browser worker.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="task-panel">
      <h2>Browser session</h2>
      <p className="plain">Open an allowlisted https page in an isolated browser. Payment, one-time codes, and saved logins are not part of this.</p>
      <form className="task-form" onSubmit={(event) => void start(event)}>
        <label htmlFor="browser-url">Page URL</label>
        <input
          id="browser-url"
          className="task-url"
          type="url"
          inputMode="url"
          placeholder="https://example.com/"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <div className="task-actions">
          <button type="submit" disabled={busy || url.trim().length === 0}>Start browser session</button>
        </div>
      </form>
      {error ? <p className="note">{error}</p> : null}
      {sessions.length === 0 && error == null ? <p className="plain">No browser session yet.</p> : null}
      {sessions.map((session) => (
        <div className="task-row" key={session.id}>
          <p>{statusLabel(session.status)} · {session.url || "No page opened"}</p>
          <button type="button" disabled={busy} onClick={() => void viewStatus(session.id)}>View browser status</button>
        </div>
      ))}
      {detail ? (
        <div className="review">
          <p><span>Status</span><span>{statusLabel(detail.status)}</span></p>
          <p><span>Task</span><span>{taskLabel(detail.taskStatus)}</span></p>
          <p><span>Page</span><span>{detail.title || "No page title"}</span></p>
          <p><span>URL</span><span>{detail.url || "No page opened"}</span></p>
        </div>
      ) : null}
      {activity.length > 0 ? (
        <ol className="task-activity">
          {activity.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
        </ol>
      ) : null}
    </div>
  );
}

function activityLine(event: BrowserTaskEvent): string | null {
  switch (event.type) {
    case "status":
    case "error":
      return event.message;
    case "snapshot":
      return `Page snapshot has ${event.elements.length} controls.`;
    case "done":
      return null;
    default: {
      const neverEvent: never = event;
      return neverEvent;
    }
  }
}

function statusLabel(status: BrowserSessionStatus): string {
  switch (status) {
    case "open":
      return "Open";
    case "paused":
      return "Paused";
    case "closed":
      return "Closed";
    case "expired":
      return "Expired";
    case "failed":
      return "Failed";
    default: {
      const neverStatus: never = status;
      return neverStatus;
    }
  }
}

function taskLabel(status: BrowserTaskStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "closed":
      return "Closed";
    case "expired":
      return "Expired";
    case "failed":
      return "Failed";
    default: {
      const neverStatus: never = status;
      return neverStatus;
    }
  }
}
