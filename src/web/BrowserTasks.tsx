import { useEffect, useState, type FormEvent } from "react";
import { ShieldCheck } from "lucide-react";
import type { BrowserSessionStatus, BrowserSessionView, BrowserTaskEvent, BrowserTaskStatus, ProfileState } from "../shared/browser.ts";
import { apiUrl } from "./backend.ts";
import { readSse } from "./sse.ts";
import { Thinking } from "./Thinking.tsx";
import { friendlyBrowserError } from "./uiText.ts";

const headers = { "bypass-tunnel-reminder": "true" };

export function BrowserTasks() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<BrowserSessionView[]>([]);
  const [detail, setDetail] = useState<BrowserSessionView | null>(null);
  const [activity, setActivity] = useState<string[]>([]);
  const [traceStart, setTraceStart] = useState<number | null>(null);
  const [traceEnd, setTraceEnd] = useState<number | null>(null);
  const [profile, setProfile] = useState<ProfileState>("absent");

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh(): Promise<void> {
    try {
      const response = await fetch(apiUrl("/api/browser/sessions"), { credentials: "include", headers });
      const payload = (await response.json()) as { sessions?: BrowserSessionView[]; error?: unknown };
      if (!response.ok || !payload.sessions) {
        setError(typeof payload.error === "string" ? payload.error : "Scout could not load your pages.");
        return;
      }
      setSessions(payload.sessions);
      const profileResponse = await fetch(apiUrl("/api/browser/profile"), { credentials: "include", headers });
      if (!profileResponse.ok) return;
      const profilePayload = (await profileResponse.json()) as { profile?: { state?: ProfileState } };
      const state = profilePayload.profile?.state;
      if (state) setProfile(state);
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
    setTraceStart(Date.now());
    setTraceEnd(null);
    setActivity([]);
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
      setTraceEnd(Date.now());
      setBusy(false);
    }
  }

  async function act(id: string, action: "resume" | "close"): Promise<void> {
    setBusy(true);
    setError(null);
    setTraceStart(Date.now());
    setTraceEnd(null);
    setActivity([]);
    try {
      const response = await fetch(apiUrl(`/api/browser/sessions/${id}/${action}`), {
        method: "POST",
        credentials: "include",
        headers,
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: unknown };
        setError(typeof payload.error === "string" ? payload.error : "The browser session could not be updated.");
        return;
      }
      const lines: string[] = [];
      await readSse<BrowserTaskEvent>(response, (item) => {
        const line = activityLine(item);
        if (line) lines.push(line);
      });
      setActivity(lines);
      await refresh();
      await viewStatus(id, false);
    } catch {
      setError("Scout could not reach the browser worker.");
    } finally {
      setTraceEnd(Date.now());
      setBusy(false);
    }
  }

  async function revoke(): Promise<void> {
    setBusy(true);
    setError(null);
    setTraceStart(Date.now());
    setTraceEnd(null);
    setActivity([]);
    try {
      const response = await fetch(apiUrl("/api/browser/profile/revoke"), { method: "POST", credentials: "include", headers });
      const type = response.headers.get("content-type") ?? "";
      if (type.includes("text/event-stream")) {
        const lines: string[] = [];
        await readSse<BrowserTaskEvent>(response, (item) => {
          const line = activityLine(item);
          if (line) lines.push(line);
        });
        setActivity(lines);
      } else if (!response.ok) {
        const payload = (await response.json()) as { error?: unknown };
        setError(typeof payload.error === "string" ? payload.error : "The saved sign-in could not be revoked.");
        return;
      }
      setDetail(null);
      await refresh();
    } catch {
      setError("Scout could not reach the browser worker.");
    } finally {
      setTraceEnd(Date.now());
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
      setTraceStart(Date.now());
      setTraceEnd(Date.now());
    } catch {
      setError("Scout could not reach the browser worker.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="task-panel">
      <section className="panel">
        <h3>Open a web page</h3>
        <p className="plain">Scout opens the page in the background and can tap its buttons for you. You won't see a browser window.</p>
        <p className="profile-state"><ShieldCheck size={16} aria-hidden="true" />{profileLabel(profile)}</p>
        <form className="task-form" onSubmit={(event) => void start(event)}>
          <label htmlFor="browser-url">Web address</label>
          <input
            id="browser-url"
            className="task-url"
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://example.com"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <div className="task-actions">
            <button className="primary-button" type="submit" disabled={busy || url.trim().length === 0}>
              {busy ? "Working…" : "Open page"}
            </button>
          </div>
        </form>
        {error ? <p className="form-error" role="alert">{friendlyBrowserError(error)}</p> : null}
      </section>
      <section className="task-list">
        <h3>Your pages</h3>
        {sessions.length === 0 && error == null ? <p className="plain">Nothing open yet. Paste a web address above to start.</p> : null}
        {sessions.map((session) => (
          <div className="task-row" key={session.id}>
            <div className="task-row-text">
              <span className={`status-pill ${session.status}`}>{statusLabel(session.status)}</span>
              <p>{session.url || "No page opened"}</p>
            </div>
            <button className="ghost-button" type="button" disabled={busy} onClick={() => void viewStatus(session.id)}>Details</button>
          </div>
        ))}
      </section>
      {detail ? (
        <section className="panel">
          <h3>Page details</h3>
          <dl className="detail-list">
            <div><dt>Status</dt><dd>{statusLabel(detail.status)}</dd></div>
            <div><dt>Task</dt><dd>{taskLabel(detail.taskStatus)}</dd></div>
            <div><dt>Page</dt><dd>{detail.title || "Untitled"}</dd></div>
            <div><dt>Address</dt><dd className="task-token">{detail.url || "No page opened"}</dd></div>
          </dl>
          <div className="task-actions">
            {detail.status === "paused" ? <button className="primary-button" type="button" disabled={busy} onClick={() => void act(detail.id, "resume")}>Resume</button> : null}
            {detail.status === "open" || detail.status === "paused" ? <button className="ghost-button" type="button" disabled={busy} onClick={() => void act(detail.id, "close")}>Close page</button> : null}
            <button className="ghost-button danger" type="button" disabled={busy} onClick={() => void revoke()}>Forget saved sign-in</button>
          </div>
        </section>
      ) : null}
      {traceStart != null ? <Thinking steps={activity} startedAt={traceStart} finishedAt={busy ? null : traceEnd} /> : null}
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

function profileLabel(state: ProfileState): string {
  switch (state) {
    case "saved":
      return "A saved sign-in is stored encrypted on this computer.";
    case "expired":
      return "Your saved sign-in expired. Scout will ask you to sign in again.";
    case "revoked":
      return "Your saved sign-in was removed.";
    case "absent":
      return "No saved sign-in yet. Scout will ask the first time it needs one.";
    default: {
      const neverState: never = state;
      return neverState;
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
