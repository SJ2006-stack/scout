import { useEffect, useState } from "react";
import { VAULT_TEMPLATE } from "../shared/vault.ts";
import { apiUrl } from "./backend.ts";

/** The signed-in person's Vault. They edit the markdown. Scout can only read the saved copy. */
export function VaultPanel({ onToast }: { onToast: (text: string) => void }) {
  const [markdown, setMarkdown] = useState(VAULT_TEMPLATE);
  const [saved, setSaved] = useState(VAULT_TEMPLATE);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch(apiUrl("/api/vault"), { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { markdown?: unknown };
        if (cancelled || typeof body.markdown !== "string" || body.markdown.length === 0) return;
        setMarkdown(body.markdown);
        setSaved(body.markdown);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(apiUrl("/api/vault"), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown }),
      });
      const body = (await response.json()) as { error?: unknown; markdown?: unknown };
      if (!response.ok) {
        onToast(typeof body.error === "string" ? body.error : "The Vault could not be saved.");
        return;
      }
      const next = typeof body.markdown === "string" && body.markdown.length > 0 ? body.markdown : markdown;
      setMarkdown(next);
      setSaved(next);
      onToast("Vault saved. Scout can read it and cannot change it.");
    } catch {
      onToast("The Vault could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const dirty = markdown !== saved;
  return (
    <section className="vault" aria-label="Vault">
      <p className="vault-lead">Personal details Scout can read. You edit this page. Scout cannot change it. Leave passwords, PINs, OTPs, CVVs, and full card or Aadhaar numbers out.</p>
      <textarea
        className="vault-editor"
        value={markdown}
        spellCheck={false}
        aria-label="Vault markdown"
        disabled={loading}
        onChange={(event) => setMarkdown(event.target.value)}
      />
      <button className="auth-submit vault-save" type="button" disabled={loading || busy || !dirty} onClick={() => void save()}>
        {busy ? "Saving…" : "Save"}
      </button>
    </section>
  );
}
