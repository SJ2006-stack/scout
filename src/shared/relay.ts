/**
 * Phone relay wire format. A signed-in phone holds one WebSocket to the server;
 * every TCP connection Chromium makes to a store rides it as a numbered stream.
 * Frame: [kind: 1 byte][stream id: 4 bytes, big-endian][payload].
 */
export const RELAY_PATH = "/api/relay";

export const RelayKind = {
  open: 1,
  opened: 2,
  data: 3,
  close: 4,
  fail: 5,
  vault: 6,
} as const;

export type RelayKindValue = (typeof RelayKind)[keyof typeof RelayKind];

export type RelayFrame = { kind: RelayKindValue; stream: number; payload: Uint8Array };

/**
 * The only hosts a phone will connect to: store and event pages with their APIs,
 * plus the Cloudflare challenge host, whose token is bound to the address that solved it.
 */
const RELAY_SUFFIXES = [
  "blinkit.com",
  "grofers.com",
  "zepto.com",
  "zeptonow.com",
  "zepto.co.in",
  "swiggy.com",
  "swiggy.in",
  "swiggystatic.com",
  "bookmyshow.com",
  "bmscdn.com",
  "district.in",
  "luma.com",
  "lu.ma",
  "challenges.cloudflare.com",
] as const;

export function relayHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return RELAY_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

/** Relayed connections are TLS only, so the phone passes bytes it cannot read. */
export function relayTarget(value: string): { host: string; port: number } | null {
  const match = /^([a-z0-9.-]{1,253}):(\d{1,5})$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  const port = Number(match[2]);
  if (port !== 443 || !relayHost(match[1])) return null;
  return { host: match[1].toLowerCase(), port };
}

export function encodeFrame(kind: RelayKindValue, stream: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = kind;
  new DataView(frame.buffer).setUint32(1, stream >>> 0);
  frame.set(payload, 5);
  return frame;
}

export function decodeFrame(data: Uint8Array): RelayFrame | null {
  if (data.length < 5) return null;
  const kind = data[0];
  if (!Object.values(RelayKind).includes(kind as RelayKindValue)) return null;
  const stream = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1);
  return { kind: kind as RelayKindValue, stream, payload: data.subarray(5) };
}

/**
 * Saved site sign-ins mirrored to the phone. The blob is the server's sealed
 * record (AES-256-GCM, bound to user and site), so the phone keeps a copy it
 * cannot read and the server accepts back only what its own key opens.
 * "put" and "drop" go to the phone; "offer" comes back from it on connect.
 * Payload: [header length: 4 bytes, big-endian][header JSON][blob].
 */
export type VaultMessage =
  | { op: "put" | "offer"; domain: string; updatedAt: number; expiresAt: number; lastValidatedAt: number; blob: Uint8Array }
  | { op: "drop"; domain: string; at: number };

export const MAX_VAULT_BLOB = 1_100_000;

export function encodeVault(message: VaultMessage): Uint8Array {
  const { blob, ...header } = message.op === "drop" ? { ...message, blob: new Uint8Array() } : message;
  const head = new TextEncoder().encode(JSON.stringify(header));
  const payload = new Uint8Array(4 + head.length + blob.length);
  new DataView(payload.buffer).setUint32(0, head.length);
  payload.set(head, 4);
  payload.set(blob, 4 + head.length);
  return encodeFrame(RelayKind.vault, 0, payload);
}

export function decodeVault(payload: Uint8Array): VaultMessage | null {
  if (payload.length < 4) return null;
  const size = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0);
  if (size > 4_096 || 4 + size > payload.length) return null;
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(payload.subarray(4, 4 + size))) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!header || typeof header.domain !== "string" || header.domain.length > 253) return null;
  const blob = payload.subarray(4 + size);
  if (header.op === "drop") return typeof header.at === "number" ? { op: "drop", domain: header.domain, at: header.at } : null;
  if (header.op !== "put" && header.op !== "offer") return null;
  if (typeof header.updatedAt !== "number" || typeof header.expiresAt !== "number" || typeof header.lastValidatedAt !== "number") return null;
  if (blob.length === 0 || blob.length > MAX_VAULT_BLOB) return null;
  return { op: header.op, domain: header.domain, updatedAt: header.updatedAt, expiresAt: header.expiresAt, lastValidatedAt: header.lastValidatedAt, blob };
}
