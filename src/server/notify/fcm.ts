import { createSign } from "node:crypto";

export type FcmConfig = { projectId: string; clientEmail: string; privateKey: string };
export type PushMessage = { id: string; type: string; title: string; body: string; url: string | null };
export type PushResult = "sent" | "unregistered" | "failed";

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function fcmFromEnv(env: NodeJS.ProcessEnv): FcmConfig | null {
  const projectId = (env.FCM_PROJECT_ID ?? env.FIREBASE_PROJECT_ID ?? "scout-b4da3").trim();
  const clientEmail = (env.FCM_CLIENT_EMAIL ?? env.FIREBASE_DISTRIBUTION_CLIENT_EMAIL ?? "").trim();
  const privateKey = (env.FCM_PRIVATE_KEY ?? env.FIREBASE_DISTRIBUTION_PRIVATE_KEY ?? "").replace(/\\n/g, "\n").trim();
  if (!projectId || !clientEmail || !privateKey.includes("PRIVATE KEY")) return null;
  return { projectId, clientEmail, privateKey };
}

export class FcmSender {
  private access: { token: string; expiresAt: number } | null = null;
  private readonly config: FcmConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(config: FcmConfig, fetchImpl: typeof fetch, now: () => number) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async send(pushToken: string, message: PushMessage): Promise<PushResult> {
    const access = await this.accessToken();
    if (!access) return "failed";
    try {
      const response = await this.fetchImpl(`https://fcm.googleapis.com/v1/projects/${this.config.projectId}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token: pushToken,
            data: { id: message.id, type: message.type, title: message.title, body: message.body, url: message.url ?? "" },
            android: { priority: "high" },
          },
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (response.ok) return "sent";
      if (response.status === 404 || response.status === 400) {
        const text = await response.text();
        if (/UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT/.test(text)) return "unregistered";
      }
      console.error(`FCM send failed with ${response.status}.`);
      return "failed";
    } catch {
      return "failed";
    }
  }

  private async accessToken(): Promise<string | null> {
    const nowMs = this.now();
    if (this.access && this.access.expiresAt - 60_000 > nowMs) return this.access.token;
    const issuedAt = Math.floor(nowMs / 1000);
    const assertion = signJwt(
      { iss: this.config.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: issuedAt, exp: issuedAt + 3600 },
      this.config.privateKey,
    );
    if (!assertion) return null;
    try {
      const response = await this.fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
        signal: AbortSignal.timeout(8_000),
      });
      const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
      if (!response.ok || typeof body.access_token !== "string") {
        console.error(`FCM token request failed with ${response.status}.`);
        return null;
      }
      const seconds = typeof body.expires_in === "number" ? body.expires_in : 3600;
      this.access = { token: body.access_token, expiresAt: nowMs + seconds * 1000 };
      return body.access_token;
    } catch {
      return null;
    }
  }
}

function signJwt(claims: Record<string, unknown>, privateKey: string): string | null {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify(claims));
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
  } catch {
    return null;
  }
}

function base64Url(text: string): string {
  return Buffer.from(text).toString("base64url");
}
