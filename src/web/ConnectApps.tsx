import { useState } from "react";
import type { BrowserTaskEvent } from "../shared/browser.ts";
import { CONNECT_APPS, type ConnectApp } from "../shared/onboarding.ts";
import { apiUrl } from "./backend.ts";
import { readSse } from "./sse.ts";

export function ConnectApps({ onSaved }: { onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [opened, setOpened] = useState<ConnectApp | null>(null);

  async function open(app: ConnectApp): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSessionId(null);
    setOpened(app);
    try {
      const response = await fetch(apiUrl("/api/browser/sessions"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: app.url }),
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: unknown };
        setError(typeof payload.error === "string" ? payload.error : "The browser could not be opened.");
        setOpened(null);
        return;
      }
      let id = "";
      await readSse<BrowserTaskEvent>(response, (item) => {
        if (item.sessionId) id = item.sessionId;
      });
      if (id.length === 0) {
        setError("The browser session did not start.");
        setOpened(null);
        return;
      }
      setSessionId(id);
    } catch {
      setError("Scout could not reach the browser worker.");
      setOpened(null);
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (busy || sessionId == null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(apiUrl(`/api/browser/sessions/${sessionId}/close`), {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: unknown };
        setError(typeof payload.error === "string" ? payload.error : "That sign-in could not be saved.");
        return;
      }
      await response.text();
      const profile = await fetch(apiUrl("/api/browser/profile"), { credentials: "include" });
      const body = (await profile.json()) as { profile?: { state?: string } };
      if (!profile.ok || body.profile?.state !== "saved") {
        setError("Sign in in the window, then save it again.");
        return;
      }
      onSaved();
    } catch {
      setError("That sign-in could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="connect-apps">
      <div className="prompt-row">
        {CONNECT_APPS.map((app) => (
          <button className={opened?.id === app.id ? "chip on" : "chip"} type="button" key={app.id} disabled={busy} onClick={() => void open(app)}>
            {app.name}
          </button>
        ))}
      </div>
      {sessionId && opened ? (
        <>
          <p>Sign in to {opened.name} in the window on this computer. Scout stores that browser sign-in in the vault. It does not store the password.</p>
          <button className="auth-submit" type="button" disabled={busy} onClick={() => void save()}>Save this sign-in</button>
        </>
      ) : (
        <p>Pick an app. Scout opens it in the browser worker so you can sign in once.</p>
      )}
      {error ? <p className="note">{error}</p> : null}
    </div>
  );
}
