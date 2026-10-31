const SESSION_KEY = "scout-session";

export function apiUrl(path: string): string {
  const configured = import.meta.env.VITE_API_BASE ?? "";
  return `${configured.replace(/\/$/, "")}${path}`;
}

export function backendHeaders(headers: Record<string, string> = {}, sessionId?: string): Record<string, string> {
  return { ...headers, "x-scout-session": sessionId ?? browserSession(), "bypass-tunnel-reminder": "true" };
}

export function rememberSignedInUser(id: string): void {
  if (/^[a-f0-9]{32}$/.test(id)) localStorage.setItem(SESSION_KEY, id);
}

export function forgetSignedInUser(): void {
  localStorage.removeItem(SESSION_KEY);
}

export function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function browserSession(): string {
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
  const id = newSessionId();
  localStorage.setItem(SESSION_KEY, id);
  return id;
}
