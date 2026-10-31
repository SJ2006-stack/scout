import type { AuthMailer } from "./emailAuth.ts";

export function agentMailFromEnv(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): AuthMailer {
  const key = env.AGENTMAIL_API_KEY?.trim() ?? "";
  const inbox = env.AGENTMAIL_INBOX_ID?.trim() ?? "";
  return {
    configured: key.length > 0 && inbox.length > 0,
    async send(to, subject, text) {
      const response = await fetchImpl(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages/send`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ to, subject, text }),
      });
      if (!response.ok) throw new Error("AgentMail refused the message.");
    },
  };
}
