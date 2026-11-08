import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { verifyFirebaseIdToken } from "../src/server/auth/firebaseToken.ts";

const PROJECT = "scout-b4da3";
const NOW = Date.parse("2026-11-06T18:00:00.000Z");

describe("Firebase sign-in token", () => {
  const { key, cert } = testCert();

  it("accepts a verified Gmail token signed by Google's key", async () => {
    const token = signToken(key, {
      alg: "RS256",
      kid: "key-1",
    }, {
      iss: `https://securetoken.google.com/${PROJECT}`,
      aud: PROJECT,
      sub: "firebase-user",
      exp: Math.floor(NOW / 1000) + 3600,
      email: "Person@Gmail.com",
      email_verified: true,
    });
    const identity = await verifyFirebaseIdToken(token, { projectId: PROJECT, now: NOW, fetchImpl: certs(cert) });
    assert.equal(identity.ok && identity.email, "Person@Gmail.com");
    assert.equal(identity.ok && identity.uid, "firebase-user");
  });

  it("rejects a token signed by a different key, an expired token, and an unverified email", async () => {
    const other = testCert();
    const forged = signToken(other.key, { alg: "RS256", kid: "key-1" }, claims());
    const expired = signToken(key, { alg: "RS256", kid: "key-1" }, claims({ exp: Math.floor(NOW / 1000) - 10 }));
    const unverified = signToken(key, { alg: "RS256", kid: "key-1" }, claims({ email_verified: false }));
    const wrongProject = signToken(key, { alg: "RS256", kid: "key-1" }, claims({ aud: "other-project", iss: "https://securetoken.google.com/other-project" }));
    for (const token of [forged, expired, unverified, wrongProject]) {
      const identity = await verifyFirebaseIdToken(token, { projectId: PROJECT, now: NOW, fetchImpl: certs(cert) });
      assert.equal(identity.ok, false);
    }
  });
});

function claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    sub: "firebase-user",
    exp: Math.floor(NOW / 1000) + 3600,
    email: "person@gmail.com",
    email_verified: true,
    ...extra,
  };
}

function certs(cert: string): typeof fetch {
  return (async () => Response.json({ "key-1": cert })) as typeof fetch;
}

function signToken(key: string, header: Record<string, unknown>, body: Record<string, unknown>): string {
  const encoded = `${b64(header)}.${b64(body)}`;
  const signature = createSign("RSA-SHA256").update(encoded).sign(key).toString("base64url");
  return `${encoded}.${signature}`;
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function testCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "scout-cert-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath, "-days", "2", "-nodes", "-subj", "/CN=scout-test"]);
  return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
}
