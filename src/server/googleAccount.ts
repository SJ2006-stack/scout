import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Account } from "./db/userDirectory.ts";

/** Read, send, archive, and trash. Permanent delete stays with Google. */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
/** Read, create, change, and remove files across Drive. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

export const GOOGLE_TOOL_NAMES = [
  "connect_google",
  "gmail_recent",
  "gmail_send",
  "gmail_change",
  "drive_find",
  "drive_read",
  "drive_write",
  "drive_trash",
] as const;

export type GoogleService = "gmail" | "drive";
export type GoogleToolName = (typeof GOOGLE_TOOL_NAMES)[number];
export type GoogleOutcome = { ok: boolean; content: string; note?: string };

const USER_ID = /^[a-f0-9]{32}$/;
const STATE_TTL_MS = 10 * 60 * 1000;
const SERVICES: readonly GoogleService[] = ["gmail", "drive"];

type OAuthConfig = { clientId: string; clientSecret: string; redirectUri: string };
type LinkRow = { email: string; sealed: string };

export function googleKeyFromEnv(raw: string | undefined): Buffer | null {
  const text = raw?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(text)) return null;
  return Buffer.from(text, "hex");
}

export function googleOAuthFromEnv(env: NodeJS.ProcessEnv): OAuthConfig {
  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? "",
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? "",
    redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI?.trim() ?? "",
  };
}

export function googleRedirectUri(request: IncomingMessage, configured: string): string {
  if (configured.length > 0) return configured;
  const forwardedHost = header(request, "x-forwarded-host");
  const host = forwardedHost || header(request, "host") || "127.0.0.1:8787";
  const proto = header(request, "x-forwarded-proto") || (host.startsWith("127.0.0.1") || host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/api/google/callback`;
}

export class GoogleAccounts {
  private readonly db: DatabaseSync;
  private readonly key: Buffer | null;
  private readonly oauth: OAuthConfig;
  private readonly now: () => number;

  constructor(path: string, key: Buffer | null, oauth: OAuthConfig, now: () => number) {
    this.key = key;
    this.oauth = oauth;
    this.now = now;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 3000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS google_links (
      user_id TEXT NOT NULL,
      service TEXT NOT NULL,
      email TEXT NOT NULL,
      refresh_sealed TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, service)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS google_oauth_states (
      state TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      service TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
  }

  get configured(): boolean {
    return this.oauth.clientId.length > 0 && this.oauth.clientSecret.length > 0;
  }

  connections(userId: string): { service: GoogleService; connected: boolean; email: string | null }[] {
    return SERVICES.map((service) => {
      const row = this.row(userId, service);
      return { service, connected: row != null && this.openRefresh(row) != null, email: row?.email ?? null };
    });
  }

  status(userId: string): { configured: boolean; reason: string | null; links: ReturnType<GoogleAccounts["connections"]> } {
    return { configured: this.configured && this.key != null, reason: this.blockReason(), links: this.connections(userId) };
  }

  start(userId: string, service: GoogleService, redirectUri: string): { ok: true; url: string } | { ok: false; error: string } {
    const blocked = this.blockReason();
    if (blocked) return { ok: false, error: blocked };
    if (!USER_ID.test(userId)) return { ok: false, error: "Sign in to Scout first." };
    const state = randomBytes(32).toString("hex");
    const expires = this.now() + STATE_TTL_MS;
    this.db.prepare("DELETE FROM google_oauth_states WHERE expires_at < ?").run(this.now());
    this.db.prepare("INSERT INTO google_oauth_states (state, user_id, service, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?)").run(state, userId, service, redirectUri, expires);
    const scope = ["openid", "email", service === "gmail" ? GMAIL_SCOPE : DRIVE_SCOPE].join(" ");
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", this.oauth.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scope);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("state", state);
    return { ok: true, url: url.toString() };
  }

  async finish(query: URLSearchParams, fetchImpl: typeof fetch): Promise<{ ok: true; service: GoogleService; email: string } | { ok: false; error: string }> {
    const denied = query.get("error");
    if (denied) return { ok: false, error: denied === "access_denied" ? "You cancelled Google sign-in." : "Google did not finish sign-in." };
    const code = query.get("code") ?? "";
    const state = query.get("state") ?? "";
    const pending = this.takeState(state);
    if (!pending) return { ok: false, error: "That sign-in link expired. Open Scout and tap Connect again." };
    if (!this.key) return { ok: false, error: "This server cannot store a Google sign-in until BROWSER_PROFILE_KEY is set." };
    const token = await postForm(fetchImpl, "https://oauth2.googleapis.com/token", {
      code,
      client_id: this.oauth.clientId,
      client_secret: this.oauth.clientSecret,
      redirect_uri: pending.redirect,
      grant_type: "authorization_code",
    });
    const refresh = textField(token, "refresh_token");
    const access = textField(token, "access_token");
    if (!refresh || !access) return { ok: false, error: "Google did not give Scout a way to stay signed in. Tap Connect again." };
    const profile = await getJson(fetchImpl, "https://www.googleapis.com/oauth2/v2/userinfo", access);
    const email = textField(profile, "email") ?? "connected";
    this.db.prepare(
      `INSERT INTO google_links (user_id, service, email, refresh_sealed, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, service) DO UPDATE SET email = excluded.email, refresh_sealed = excluded.refresh_sealed, updated_at = excluded.updated_at`,
    ).run(pending.userId, pending.service, email, seal(this.key, refresh), this.now());
    return { ok: true, service: pending.service, email };
  }

  disconnect(userId: string, service: GoogleService): void {
    if (!USER_ID.test(userId)) return;
    this.db.prepare("DELETE FROM google_links WHERE user_id = ? AND service = ?").run(userId, service);
  }

  async run(userId: string, name: GoogleToolName, args: Record<string, unknown>, fetchImpl: typeof fetch, redirectUri: string): Promise<GoogleOutcome> {
    if (name === "connect_google") return this.connectTool(userId, args.service, redirectUri);
    const service: GoogleService = name.startsWith("gmail_") ? "gmail" : "drive";
    const access = await this.access(userId, service, fetchImpl);
    if (!access.ok) return access;
    switch (name) {
      case "gmail_recent":
        return gmailRecent(fetchImpl, access.token);
      case "gmail_send":
        return gmailSend(fetchImpl, access.token, args);
      case "gmail_change":
        return gmailChange(fetchImpl, access.token, args);
      case "drive_find":
        return driveFind(fetchImpl, access.token, args);
      case "drive_read":
        return driveRead(fetchImpl, access.token, args);
      case "drive_write":
        return driveWrite(fetchImpl, access.token, args);
      case "drive_trash":
        return driveTrash(fetchImpl, access.token, args);
      default: {
        const neverName: never = name;
        return neverName;
      }
    }
  }

  private connectTool(userId: string, service: unknown, redirectUri: string): GoogleOutcome {
    if (service !== "gmail" && service !== "drive") return { ok: false, content: "Pass service as gmail or drive." };
    const started = this.start(userId, service, redirectUri);
    if (!started.ok) return { ok: false, content: started.error };
    const label = service === "gmail" ? "Gmail" : "Google Drive";
    return {
      ok: true,
      note: `Sign in to ${label}: ${started.url}`,
      content: `Tell them to open this link and allow Scout to control ${label}. The link must stay in your reply unchanged: ${started.url}`,
    };
  }

  private async access(userId: string, service: GoogleService, fetchImpl: typeof fetch): Promise<{ ok: true; token: string } | GoogleOutcome> {
    const blocked = this.blockReason();
    if (blocked) return { ok: false, content: blocked };
    const row = this.row(userId, service);
    const refresh = row ? this.openRefresh(row) : null;
    if (!refresh) {
      const label = service === "gmail" ? "Gmail" : "Google Drive";
      return { ok: false, content: `${label} is not connected. Call connect_google with service ${service}. Scout sends them to Google to allow read and write, then keeps that on this server.` };
    }
    const token = await postForm(fetchImpl, "https://oauth2.googleapis.com/token", {
      client_id: this.oauth.clientId,
      client_secret: this.oauth.clientSecret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    });
    const access = textField(token, "access_token");
    if (!access) return { ok: false, content: `Scout could not use the saved ${service} sign-in. Connect it again.` };
    return { ok: true, token: access };
  }

  private blockReason(): string | null {
    if (!this.configured) return "Gmail and Drive sign-in is off until GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are set on this server.";
    if (!this.key) return "Scout cannot keep a Google sign-in until BROWSER_PROFILE_KEY is set on this server.";
    return null;
  }

  private row(userId: string, service: GoogleService): LinkRow | null {
    if (!USER_ID.test(userId)) return null;
    const row = this.db.prepare("SELECT email, refresh_sealed FROM google_links WHERE user_id = ? AND service = ?").get(userId, service) as { email: string; refresh_sealed: string } | undefined;
    return row ? { email: row.email, sealed: row.refresh_sealed } : null;
  }

  private openRefresh(row: LinkRow): string | null {
    if (!this.key) return null;
    try {
      return unseal(this.key, row.sealed);
    } catch {
      return null;
    }
  }

  private takeState(state: string): { userId: string; service: GoogleService; redirect: string } | null {
    const row = this.db.prepare("SELECT user_id, service, redirect_uri, expires_at FROM google_oauth_states WHERE state = ?").get(state) as
      | { user_id: string; service: string; redirect_uri: string; expires_at: number }
      | undefined;
    this.db.prepare("DELETE FROM google_oauth_states WHERE state = ?").run(state);
    if (!row || row.expires_at < this.now()) return null;
    if (row.service !== "gmail" && row.service !== "drive") return null;
    return { userId: row.user_id, service: row.service, redirect: row.redirect_uri };
  }
}

export const GOOGLE_TOOLS: readonly Record<string, unknown>[] = [
  {
    name: "connect_google",
    description: "Send the user to Google to connect Gmail or Drive. service is gmail or drive. Gmail consent covers reading, sending, archiving, and trashing mail. Drive consent covers reading, creating, changing, and removing files. Put the returned link in the reply unchanged.",
    input_schema: { type: "object", additionalProperties: false, properties: { service: { type: "string", enum: ["gmail", "drive"] } }, required: ["service"] },
  },
  {
    name: "gmail_recent",
    description: "List the latest inbox messages from their connected Gmail.",
    input_schema: { type: "object", additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: "gmail_send",
    description: "Send an email from their connected Gmail. Only when they asked to send that message.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "gmail_change",
    description: "Change one Gmail message they already saw. action is archive, trash, read, or unread. messageId comes from gmail_recent.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { messageId: { type: "string" }, action: { type: "string", enum: ["archive", "trash", "read", "unread"] } },
      required: ["messageId", "action"],
    },
  },
  {
    name: "drive_find",
    description: "Find files in their connected Google Drive by name.",
    input_schema: { type: "object", additionalProperties: false, properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "drive_read",
    description: "Read a Drive file as text. fileId comes from drive_find.",
    input_schema: { type: "object", additionalProperties: false, properties: { fileId: { type: "string" } }, required: ["fileId"] },
  },
  {
    name: "drive_write",
    description: "Create a text file in their Google Drive. Only when they asked Scout to save or write that file.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string" }, text: { type: "string" } },
      required: ["name", "text"],
    },
  },
  {
    name: "drive_trash",
    description: "Move a Drive file to trash. Only when they asked to remove that file. fileId comes from drive_find.",
    input_schema: { type: "object", additionalProperties: false, properties: { fileId: { type: "string" } }, required: ["fileId"] },
  },
];

const GOOGLE_PROMPT = "Gmail and Drive are optional. When they ask about mail, call gmail_recent, gmail_send, or gmail_change. When they ask about Drive, call drive_find, drive_read, drive_write, or drive_trash. Send, write, archive, trash, or delete only when they asked for that. If a tool says an account is not connected, call connect_google. Never ask for their Google password.";

export function googlePrompt(enabled: boolean): string {
  return enabled ? GOOGLE_PROMPT : "";
}

export async function routeGoogle(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  google: GoogleAccounts | undefined,
  account: Account | null,
): Promise<void> {
  if (!google) {
    send(response, 503, { error: "Gmail and Drive are not connected on this server." });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/google/callback") {
    const result = await google.finish(url.searchParams, fetch);
    const label = result.ok ? (result.service === "gmail" ? "Gmail" : "Google Drive") : "Google";
    const message = result.ok ? `${label} is connected as ${escapeHtml(result.email)}. Go back to Scout.` : escapeHtml(result.error);
    html(response, message);
    return;
  }
  if (!account) {
    send(response, 401, { error: "Sign in with Google first." });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/google/connections") {
    send(response, 200, google.status(account.id));
    return;
  }
  const body = await readBody(request);
  const record = body && typeof body === "object" ? body as Record<string, unknown> : null;
  const service = record?.service;
  if (service !== "gmail" && service !== "drive") {
    send(response, 400, { error: "Choose Gmail or Drive." });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/google/connect") {
    const started = google.start(account.id, service, googleRedirectUri(request, googleOAuthFromEnv(process.env).redirectUri));
    if (!started.ok) {
      send(response, 503, { error: started.error });
      return;
    }
    send(response, 200, { url: started.url });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/google/disconnect") {
    google.disconnect(account.id, service);
    send(response, 200, google.status(account.id));
    return;
  }
  send(response, 404, { error: "Not found" });
}

function seal(key: Buffer, text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64url");
}

function unseal(key: Buffer, payload: string): string {
  const body = Buffer.from(payload, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, body.subarray(0, 12));
  decipher.setAuthTag(body.subarray(12, 28));
  return Buffer.concat([decipher.update(body.subarray(28)), decipher.final()]).toString("utf8");
}

async function gmailRecent(fetchImpl: typeof fetch, token: string): Promise<GoogleOutcome> {
  const list = await getJson(fetchImpl, "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=in:inbox", token);
  const ids = messageIds(list).slice(0, 5);
  if (ids.length === 0) return { ok: true, content: "The inbox has no messages Scout can see." };
  const lines: string[] = [];
  for (const id of ids) {
    const message = await getJson(fetchImpl, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, token);
    const headers = headerMap(message);
    const snippet = textField(message, "snippet")?.slice(0, 140) ?? "";
    lines.push(`${id}: ${headers.get("from") ?? "unknown"} — ${headers.get("subject") ?? "(no subject)"} (${headers.get("date") ?? ""}). ${snippet}`);
  }
  return { ok: true, content: lines.join("\n") };
}

async function gmailSend(fetchImpl: typeof fetch, token: string, args: Record<string, unknown>): Promise<GoogleOutcome> {
  const to = typeof args.to === "string" ? args.to.trim() : "";
  const subject = typeof args.subject === "string" ? args.subject.trim() : "";
  const body = typeof args.body === "string" ? args.body : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || to.length > 200) return { ok: false, content: "That is not an email address." };
  if (subject.length === 0 || subject.length > 200 || /[\r\n]/.test(subject) || /[\r\n]/.test(to)) return { ok: false, content: "Give a one-line subject." };
  if (body.trim().length === 0 || body.length > 4000) return { ok: false, content: "The message needs text under 4000 characters." };
  const raw = Buffer.from(`To: ${to}\r\nSubject: ${encodeHeader(subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`, "utf8").toString("base64url");
  const sent = await postJson(fetchImpl, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", token, { raw });
  if (sent.status >= 300) return { ok: false, content: googleError(sent, "Gmail did not send that.") };
  return { ok: true, content: `Sent the email to ${to}.`, note: `Sent mail to ${to}.` };
}

async function gmailChange(fetchImpl: typeof fetch, token: string, args: Record<string, unknown>): Promise<GoogleOutcome> {
  const id = typeof args.messageId === "string" ? args.messageId : "";
  if (!/^[a-zA-Z0-9]+$/.test(id)) return { ok: false, content: "That message id is not one Scout listed." };
  if (args.action === "trash") {
    const trashed = await postJson(fetchImpl, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/trash`, token, {});
    if (trashed.status >= 300) return { ok: false, content: googleError(trashed, "Gmail did not trash that.") };
    return { ok: true, content: "Moved that message to trash.", note: "Moved a Gmail message to trash." };
  }
  const labels = args.action === "archive"
    ? { removeLabelIds: ["INBOX"] }
    : args.action === "read"
      ? { removeLabelIds: ["UNREAD"] }
      : args.action === "unread"
        ? { addLabelIds: ["UNREAD"] }
        : null;
  if (!labels) return { ok: false, content: "action is archive, trash, read, or unread." };
  const changed = await postJson(fetchImpl, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`, token, labels);
  if (changed.status >= 300) return { ok: false, content: googleError(changed, "Gmail did not change that.") };
  return { ok: true, content: `Marked that message ${args.action}.` };
}

async function driveFind(fetchImpl: typeof fetch, token: string, args: Record<string, unknown>): Promise<GoogleOutcome> {
  const query = typeof args.query === "string" ? args.query.replace(/['\\]/g, "").trim().slice(0, 80) : "";
  if (query.length === 0) return { ok: false, content: "Say which file name to look for." };
  const url = `https://www.googleapis.com/drive/v3/files?pageSize=8&fields=files(id,name,mimeType)&orderBy=modifiedTime desc&q=${encodeURIComponent(`name contains '${query}' and trashed = false`)}`;
  const found = await getJson(fetchImpl, url, token);
  const files = Array.isArray(found.json && typeof found.json === "object" ? (found.json as { files?: unknown }).files : null)
    ? (found.json as { files: unknown[] }).files
    : [];
  const lines = files.flatMap((file) => {
    if (!file || typeof file !== "object") return [];
    const item = file as { id?: unknown; name?: unknown; mimeType?: unknown };
    if (typeof item.id !== "string" || typeof item.name !== "string") return [];
    return [`${item.id}: ${item.name} (${typeof item.mimeType === "string" ? item.mimeType : "file"})`];
  });
  return { ok: true, content: lines.length > 0 ? lines.join("\n") : `Drive has no file named ${query}.` };
}

async function driveRead(fetchImpl: typeof fetch, token: string, args: Record<string, unknown>): Promise<GoogleOutcome> {
  const id = fileId(args.fileId);
  if (!id) return { ok: false, content: "That is not a Drive file id." };
  const meta = await getJson(fetchImpl, `https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType`, token);
  const mime = textField(meta, "mimeType") ?? "";
  const name = textField(meta, "name") ?? "file";
  const exportType = mime === "application/vnd.google-apps.document" || mime === "application/vnd.google-apps.presentation"
    ? "text/plain"
    : mime === "application/vnd.google-apps.spreadsheet"
      ? "text/csv"
      : null;
  const url = exportType
    ? `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportType)}`
    : mime.startsWith("text/") || mime === "application/json"
      ? `https://www.googleapis.com/drive/v3/files/${id}?alt=media`
      : null;
  if (!url) return { ok: false, content: `Scout can see ${name} but cannot read that kind of file.` };
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) return { ok: false, content: "Drive did not open that file." };
  const text = (await response.text()).slice(0, 6000);
  return { ok: true, content: `${name}:\n${text}` };
}

async function driveWrite(fetchImpl: typeof fetch, token: string, args: Record<string, unknown>): Promise<GoogleOutcome> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const text = typeof args.text === "string" ? args.text : "";
  if (name.length === 0 || name.length > 120 || /[\\/]/.test(name)) return { ok: false, content: "Give a file name." };
  if (text.length === 0 || text.length > 20_000) return { ok: false, content: "The file needs text under 20000 characters." };
  const boundary = `scout${randomBytes(8).toString("hex")}`;
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType: "text/plain" })}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
  const response = await fetchImpl("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!response.ok) return { ok: false, content: "Drive did not save that file." };
  const saved = (await response.json()) as { name?: unknown };
  return { ok: true, content: `Saved ${typeof saved.name === "string" ? saved.name : name} in Drive.`, note: `Saved ${name} in Drive.` };
}

async function driveTrash(fetchImpl: typeof fetch, token: string, args: Record<string, unknown>): Promise<GoogleOutcome> {
  const id = fileId(args.fileId);
  if (!id) return { ok: false, content: "That is not a Drive file id." };
  const trashed = await postJson(fetchImpl, `https://www.googleapis.com/drive/v3/files/${id}/trash`, token, {});
  if (trashed.status >= 300) return { ok: false, content: googleError(trashed, "Drive did not trash that file.") };
  return { ok: true, content: "Moved that Drive file to trash.", note: "Moved a Drive file to trash." };
}

function fileId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{10,80}$/.test(value) ? value : null;
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function messageIds(result: { json: unknown }): string[] {
  const messages = result.json && typeof result.json === "object" ? (result.json as { messages?: unknown }).messages : null;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((item) => (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? [(item as { id: string }).id] : []));
}

function headerMap(result: { json: unknown }): Map<string, string> {
  const payload = result.json && typeof result.json === "object" ? (result.json as { payload?: { headers?: unknown } }).payload : null;
  const headers = payload && Array.isArray(payload.headers) ? payload.headers : [];
  const map = new Map<string, string>();
  for (const header of headers) {
    if (!header || typeof header !== "object") continue;
    const name = (header as { name?: unknown }).name;
    const value = (header as { value?: unknown }).value;
    if (typeof name === "string" && typeof value === "string") map.set(name.toLowerCase(), value);
  }
  return map;
}

function textField(result: { json: unknown } | null, key: string): string | null {
  if (!result?.json || typeof result.json !== "object") return null;
  const value = (result.json as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function googleError(result: { json: unknown }, fallback: string): string {
  const message = result.json && typeof result.json === "object" ? (result.json as { error?: { message?: unknown } }).error?.message : null;
  return typeof message === "string" && message.length < 180 ? message : fallback;
}

async function postForm(fetchImpl: typeof fetch, url: string, fields: Record<string, string>): Promise<{ json: unknown }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  return { json: await response.json().catch(() => null) };
}

async function getJson(fetchImpl: typeof fetch, url: string, token: string): Promise<{ status: number; json: unknown }> {
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function postJson(fetchImpl: typeof fetch, url: string, token: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim() ?? "";
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function html(response: ServerResponse, message: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scout</title><p>${message}</p>`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char] ?? char);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 4096) return null;
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}
