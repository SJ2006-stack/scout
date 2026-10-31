import { createSign } from "node:crypto";

const PROJECT_NUMBER = "153984242644";
const APP_ID = "1:153984242644:android:f6b6eee7dc1dfaf683bc41";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

export type InviteResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

export type AppInvite = {
  configured: boolean;
  send(email: string): Promise<InviteResult>;
};

type Release = { name?: unknown; createTime?: unknown };

export function inviteEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > 254) return null;
  if (!EMAIL.test(email)) return null;
  return email;
}

export function distributionFromEnv(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): AppInvite {
  const clientEmail = env.FIREBASE_DISTRIBUTION_CLIENT_EMAIL?.trim() ?? "";
  const privateKey = (env.FIREBASE_DISTRIBUTION_PRIVATE_KEY ?? "").replace(/\\n/g, "\n").trim();
  if (clientEmail.length === 0 || !privateKey.includes("BEGIN PRIVATE KEY")) {
    return { configured: false, async send() { return { ok: false, status: 503, error: "The install link is not connected." }; } };
  }
  return new AppReleaseInvite({
    fetchImpl,
    now: Date.now,
    accessToken: () => googleAccessToken(clientEmail, privateKey, fetchImpl),
  });
}

export class AppReleaseInvite {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly accessToken: () => Promise<string>;
  private readonly minIntervalMs: number;
  private readonly sentAt = new Map<string, number>();
  readonly configured = true;

  constructor(options: {
    fetchImpl: typeof fetch;
    now: () => number;
    accessToken: () => Promise<string>;
    minIntervalMs?: number;
  }) {
    this.fetchImpl = options.fetchImpl;
    this.now = options.now;
    this.accessToken = options.accessToken;
    this.minIntervalMs = options.minIntervalMs ?? 10 * 60 * 1000;
  }

  async send(raw: string): Promise<InviteResult> {
    const email = inviteEmail(raw);
    if (!email) return { ok: false, status: 400, error: "Enter an email address." };
    const previous = this.sentAt.get(email);
    const now = this.now();
    if (previous != null && now - previous < this.minIntervalMs) {
      return { ok: false, status: 429, error: "That invite was just sent. Check your email." };
    }
    let token: string;
    try {
      token = await this.accessToken();
    } catch {
      return { ok: false, status: 502, error: "The install link could not be sent." };
    }
    const added = await this.post(token, `/projects/${PROJECT_NUMBER}/testers:batchAdd`, { emails: [email] });
    if (!added.ok) return added;
    const release = await this.latestRelease(token);
    if (!release.ok) return release;
    const sent = await this.post(
      token,
      `/projects/${PROJECT_NUMBER}/apps/${encodeURIComponent(APP_ID)}/releases/${release.id}:distribute`,
      { testerEmails: [email] },
    );
    if (!sent.ok) return sent;
    this.sentAt.set(email, now);
    return { ok: true };
  }

  private async latestRelease(token: string): Promise<{ ok: true; id: string } | { ok: false; status: number; error: string }> {
    const url = `https://firebaseappdistribution.googleapis.com/v1/projects/${PROJECT_NUMBER}/apps/${encodeURIComponent(APP_ID)}/releases`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    } catch {
      return { ok: false, status: 502, error: "The install link could not be sent." };
    }
    if (!response.ok) return { ok: false, status: 502, error: "The install link could not be sent." };
    const payload = await response.json() as { releases?: Release[] };
    const releases = Array.isArray(payload.releases) ? payload.releases : [];
    const newest = releases
      .map((item) => ({
        id: typeof item.name === "string" ? releaseId(item.name) : "",
        createTime: typeof item.createTime === "string" ? item.createTime : "",
      }))
      .filter((item) => item.id.length > 0 && item.createTime.length > 0)
      .sort((a, b) => a.createTime < b.createTime ? 1 : -1)[0];
    if (!newest) return { ok: false, status: 503, error: "The install link is not ready yet." };
    return { ok: true, id: newest.id };
  }

  private async post(token: string, path: string, body: unknown): Promise<InviteResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`https://firebaseappdistribution.googleapis.com/v1${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, status: 502, error: "The install link could not be sent." };
    }
    if (response.ok) return { ok: true };
    return { ok: false, status: 502, error: "The install link could not be sent." };
  }
}

export async function googleAccessToken(clientEmail: string, privateKey: string, fetchImpl: typeof fetch): Promise<string> {
  const assertion = signServiceJwt(clientEmail, privateKey, Date.now());
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!response.ok) throw new Error("Google refused the install token.");
  const payload = await response.json() as { access_token?: unknown };
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new Error("Google refused the install token.");
  }
  return payload.access_token;
}

export function signServiceJwt(clientEmail: string, privateKey: string, now: number): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(JSON.stringify({
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
}

function releaseId(name: string): string {
  const slash = name.lastIndexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : "";
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
