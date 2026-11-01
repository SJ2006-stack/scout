import { useCallback, useEffect, useState } from "react";
import { CONNECTOR_GROUPS, type Connector } from "../shared/onboarding.ts";
import type { ScoutTaskView } from "../shared/scoutTask.ts";
import { apiUrl, backendHeaders } from "./backend.ts";
import { ScoutTaskCard } from "./ScoutTaskCard.tsx";

const REFRESH_MS = 3_000;

type SiteSession = {
  domain: string;
  lastValidatedAt: number | null;
  updatedAt: number;
  state: "verified" | "unverified" | "expired" | "revoked";
};

type Running = { connector: Connector; taskId: string };

/** The sites each Scout signs in to: status, a one-tap Connect, and Disconnect. */
export function Connectors() {
  const [sites, setSites] = useState<SiteSession[]>([]);
  const [running, setRunning] = useState<Running | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<SiteSession[]> => {
    const response = await fetch(apiUrl("/api/browser/scout/sessions"), { credentials: "include", headers: backendHeaders() });
    const payload = (await response.json()) as { sites?: SiteSession[]; error?: unknown };
    if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "Scout could not read your connections.");
    const next = payload.sites ?? [];
    setSites(next);
    return next;
  }, []);

  useEffect(() => {
    load().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Scout could not read your connections."));
  }, [load]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      load()
        .then((next) => {
          if (sessionFor(next, running.connector)?.state === "verified") setRunning(null);
        })
        .catch(() => undefined);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [running, load]);

  async function connect(connector: Connector): Promise<void> {
    setBusy(connector.id);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/browser/scout/tasks"), {
        method: "POST",
        credentials: "include",
        headers: backendHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ action: "sign_in", skill: connector.id }),
      });
      const payload = (await response.json()) as { task?: ScoutTaskView; error?: unknown };
      if (!response.ok || !payload.task) {
        setError(typeof payload.error === "string" ? payload.error : `Scout could not start the ${connector.name} sign-in.`);
        return;
      }
      setRunning({ connector, taskId: payload.task.id });
    } catch {
      setError("Scout could not reach the browser worker.");
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(connector: Connector): Promise<void> {
    setBusy(connector.id);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/browser/scout/sessions/revoke"), {
        method: "POST",
        credentials: "include",
        headers: backendHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ domain: connector.domain }),
      });
      const payload = (await response.json()) as { sites?: SiteSession[]; error?: unknown };
      if (!response.ok) {
        setError(typeof payload.error === "string" ? payload.error : `Scout could not disconnect ${connector.name}.`);
        return;
      }
      setSites(payload.sites ?? []);
    } catch {
      setError("Scout could not reach the browser worker.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="connectors">
      <p className="connectors-note">Scout signs in with your phone number or Gmail. The code the site sends is read from your phone's notification, or you can type it here.</p>
      {CONNECTOR_GROUPS.map((group) => (
        <div className="connector-group" key={group.scout}>
          <h4>{group.scout}</h4>
          {group.connectors.map((connector) => {
            const session = sessionFor(sites, connector);
            const connected = session?.state === "verified";
            return (
              <div className="setting-row" key={connector.id}>
                <div>
                  <strong>{connector.name}</strong>
                  <p>{statusText(session, connector)}</p>
                </div>
                {connected ? (
                  <button className="ghost-button" type="button" disabled={busy != null} onClick={() => void disconnect(connector)}>Disconnect</button>
                ) : (
                  <button className="primary-button" type="button" disabled={busy != null || running != null} onClick={() => void connect(connector)}>
                    {busy === connector.id ? "Starting" : session?.state === "expired" ? "Reconnect" : "Connect"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {running ? <ScoutTaskCard key={running.taskId} taskId={running.taskId} title={`Connect ${running.connector.name}`} /> : null}
      {error ? <p className="note">{error}</p> : null}
    </div>
  );
}

function sessionFor(sites: readonly SiteSession[], connector: Connector): SiteSession | undefined {
  return sites
    .filter((site) => site.domain === connector.domain && site.state !== "revoked")
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

function statusText(session: SiteSession | undefined, connector: Connector): string {
  const uses = connector.uses === "email" ? "your Gmail" : connector.uses === "phone" ? "your phone number" : "your phone number or Gmail";
  if (!session) return `Not connected. Signs in with ${uses}.`;
  switch (session.state) {
    case "verified":
      return `Connected. Last checked ${when(session.lastValidatedAt ?? session.updatedAt)}.`;
    case "unverified":
      return "Saved, not checked yet. Connect again to check it.";
    case "expired":
      return "The sign-in expired. Reconnect to keep using it.";
    case "revoked":
      return `Not connected. Signs in with ${uses}.`;
    default: {
      const neverState: never = session.state;
      return neverState;
    }
  }
}

function when(ms: number): string {
  return new Date(ms).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}
