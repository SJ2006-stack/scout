import { createVerify, X509Certificate } from "node:crypto";

const CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

export type FirebaseIdentity = { email: string; uid: string };

type VerifyOptions = {
  projectId: string;
  now: number;
  fetchImpl?: typeof fetch;
};

/** Checks a Firebase ID token from the phone's Google sign-in. The email is that person's Gmail. */
export async function verifyFirebaseIdToken(token: string, options: VerifyOptions): Promise<{ ok: true } & FirebaseIdentity | { ok: false; error: string }> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return { ok: false, error: "That sign-in could not be checked." };
  let header: { alg?: unknown; kid?: unknown };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(decode(parts[0]).toString("utf8")) as { alg?: unknown; kid?: unknown };
    claims = JSON.parse(decode(parts[1]).toString("utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "That sign-in could not be checked." };
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length === 0) return { ok: false, error: "That sign-in could not be checked." };
  const projectId = options.projectId.trim();
  if (projectId.length === 0) return { ok: false, error: "Google sign-in is not connected." };
  const issuer = `https://securetoken.google.com/${projectId}`;
  const audience = claims.aud;
  const audienceOk = audience === projectId || (Array.isArray(audience) && audience.length === 1 && audience[0] === projectId);
  const expires = typeof claims.exp === "number" ? claims.exp : 0;
  if (!audienceOk || claims.iss !== issuer || expires * 1000 <= options.now) return { ok: false, error: "That sign-in has expired. Try again." };
  if (claims.email_verified !== true || typeof claims.email !== "string") return { ok: false, error: "Use a verified Gmail address." };
  if (typeof claims.sub !== "string" || claims.sub.length === 0) return { ok: false, error: "That sign-in could not be checked." };
  const certs = await loadCerts(options.fetchImpl ?? fetch);
  const pem = certs?.[header.kid];
  if (!pem || !signatureMatches(parts, pem)) return { ok: false, error: "That sign-in could not be checked." };
  return { ok: true, email: claims.email, uid: claims.sub };
}

function signatureMatches(parts: string[], pem: string): boolean {
  try {
    const cert = new X509Certificate(pem);
    if (new Date(cert.validTo).getTime() <= Date.now()) return false;
    const verify = createVerify("RSA-SHA256");
    verify.update(`${parts[0]}.${parts[1]}`);
    return verify.verify(cert.publicKey, decode(parts[2]));
  } catch {
    return false;
  }
}

async function loadCerts(fetchImpl: typeof fetch): Promise<Record<string, string> | null> {
  try {
    const response = await fetchImpl(CERTS_URL);
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object") return null;
    const certs: Record<string, string> = {};
    for (const [kid, pem] of Object.entries(body)) {
      if (typeof pem === "string" && pem.includes("BEGIN CERTIFICATE")) certs[kid] = pem;
    }
    return certs;
  } catch {
    return null;
  }
}

function decode(part: string): Buffer {
  return Buffer.from(part, "base64url");
}
