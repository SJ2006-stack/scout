import { connect, type Socket } from "node:net";
import WebSocket from "ws";
import { decodeFrame, decodeVault, encodeFrame, encodeVault, RelayKind, relayTarget } from "../../shared/relay.ts";
import type { DeviceVault } from "./deviceVault.ts";

export type DeviceOptions = {
  /** wss:// or ws:// URL of RELAY_PATH. */
  url: string;
  headers: Record<string, string>;
  /** Which "host:port" targets this device agrees to open. Defaults to the store allowlist on 443. */
  accept?: (value: string) => { host: string; port: number } | null;
  onEvent?: (message: string) => void;
  /** Where this device keeps sealed copies of the user's site sign-ins. */
  vault?: DeviceVault;
};

/**
 * The phone side of the relay: opens the store connections the server asks for
 * and passes bytes both ways. It sees only TLS bytes and never host traffic it did not allow.
 */
export function runRelayDevice(options: DeviceOptions): { ready: Promise<void>; closed: Promise<void>; close: () => void } {
  const accept = options.accept ?? relayTarget;
  const sockets = new Map<number, Socket>();
  const ws = new WebSocket(options.url, { headers: options.headers });
  const send = (kind: (typeof RelayKind)[keyof typeof RelayKind], stream: number, payload?: Uint8Array): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(kind, stream, payload));
  };
  const ready = new Promise<void>((resolve, reject) => {
    ws.once("open", () => {
      for (const copy of options.vault?.list() ?? []) ws.send(encodeVault({ op: "offer", ...copy }));
      resolve();
    });
    ws.once("unexpected-response", (_request, response) => reject(new Error(`Relay refused: ${response.statusCode ?? 0}`)));
    ws.once("error", reject);
  });
  ws.on("message", (raw, isBinary) => {
    if (!isBinary) return;
    const frame = decodeFrame(raw instanceof Buffer ? raw : Buffer.from(raw as ArrayBuffer));
    if (!frame) return;
    switch (frame.kind) {
      case RelayKind.open: {
        const target = accept(new TextDecoder().decode(frame.payload));
        if (!target) {
          options.onEvent?.("Refused a host outside the allowlist.");
          send(RelayKind.fail, frame.stream);
          return;
        }
        const socket = connect({ host: target.host, port: target.port });
        let opened = false;
        socket.setNoDelay(true);
        socket.once("connect", () => {
          opened = true;
          sockets.set(frame.stream, socket);
          send(RelayKind.opened, frame.stream);
          options.onEvent?.(`Opened ${target.host}`);
        });
        socket.on("data", (chunk) => send(RelayKind.data, frame.stream, chunk));
        socket.on("end", () => send(RelayKind.close, frame.stream));
        socket.on("error", () => send(opened ? RelayKind.close : RelayKind.fail, frame.stream));
        socket.on("close", () => sockets.delete(frame.stream));
        return;
      }
      case RelayKind.data:
        sockets.get(frame.stream)?.write(frame.payload);
        return;
      case RelayKind.close:
        sockets.get(frame.stream)?.end();
        return;
      case RelayKind.vault: {
        const message = decodeVault(frame.payload);
        if (!message || !options.vault) return;
        if (message.op === "put") {
          options.vault.put({ domain: message.domain, updatedAt: message.updatedAt, expiresAt: message.expiresAt, lastValidatedAt: message.lastValidatedAt, blob: Buffer.from(message.blob) });
          options.onEvent?.(`Saved a sealed ${message.domain} sign-in`);
        } else if (message.op === "drop") {
          options.vault.drop(message.domain, message.at);
          options.onEvent?.(`Dropped the ${message.domain} sign-in`);
        }
        return;
      }
      case RelayKind.opened:
      case RelayKind.fail:
        return;
      default: {
        const neverKind: never = frame.kind;
        return neverKind;
      }
    }
  });
  const closed = new Promise<void>((resolve) => {
    ws.on("close", () => {
      for (const socket of sockets.values()) socket.destroy();
      sockets.clear();
      resolve();
    });
  });
  return {
    ready,
    closed,
    close: () => {
      ws.close();
      for (const socket of sockets.values()) socket.destroy();
    },
  };
}
