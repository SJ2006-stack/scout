import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "./backend.ts";

type Link = { service: "gmail" | "drive"; connected: boolean; email: string | null };
type Status = { configured: boolean; reason: string | null; links: Link[] };

const LABELS = { gmail: "Gmail", drive: "Google Drive" } as const;

/** Optional Gmail and Drive connections. Connect opens Google for read and write access. */
export function GoogleLinks() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"gmail" | "drive" | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/api/google/connections"), { credentials: "include" });
      const payload = (await response.json()) as Status & { error?: unknown };
      if (!response.ok) {
        setError(typeof payload.error === "string" ? payload.error : "Scout could not check Gmail and Drive.");
        return;
      }
      setStatus(payload);
    } catch {
      setError("Scout could not check Gmail and Drive.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  async function connect(service: "gmail" | "drive"): Promise<void> {
    setBusy(service);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/google/connect"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ service }),
      });
      const payload = (await response.json()) as { url?: unknown; error?: unknown };
      if (!response.ok || typeof payload.url !== "string") {
        setError(typeof payload.error === "string" ? payload.error : `Scout could not open ${LABELS[service]}.`);
        return;
      }
      window.location.assign(payload.url);
    } catch {
      setError(`Scout could not open ${LABELS[service]}.`);
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(service: "gmail" | "drive"): Promise<void> {
    setBusy(service);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/google/disconnect"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ service }),
      });
      const payload = (await response.json()) as Status & { error?: unknown };
      if (!response.ok) {
        setError(typeof payload.error === "string" ? payload.error : `Scout could not disconnect ${LABELS[service]}.`);
        return;
      }
      setStatus(payload);
    } catch {
      setError(`Scout could not disconnect ${LABELS[service]}.`);
    } finally {
      setBusy(null);
    }
  }

  const links = status?.links ?? [
    { service: "gmail" as const, connected: false, email: null },
    { service: "drive" as const, connected: false, email: null },
  ];

  return (
    <div className="connectors">
      {links.map((link) => (
        <div className="setting-row" key={link.service}>
          <div>
            <strong>{LABELS[link.service]}</strong>
            <p>{link.connected ? `Connected${link.email ? ` as ${link.email}` : ""}.` : link.service === "gmail" ? "Read, send, archive, and trash mail." : "Read, create, change, and remove files."}</p>
          </div>
          {link.connected ? (
            <button className="ghost-button" type="button" disabled={busy != null} onClick={() => void disconnect(link.service)}>Disconnect</button>
          ) : (
            <button className="primary-button" type="button" disabled={busy != null || status?.configured === false} onClick={() => void connect(link.service)}>
              {busy === link.service ? "Opening" : "Connect"}
            </button>
          )}
        </div>
      ))}
      {status?.reason ? <p className="form-error">{status.reason}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </div>
  );
}
