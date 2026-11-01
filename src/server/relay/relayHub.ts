import type { IncomingMessage } from "node:http";
import type { Duplex as NodeDuplex } from "node:stream";
import { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { decodeFrame, decodeVault, encodeFrame, encodeVault, RelayKind, relayTarget, type VaultMessage } from "../../shared/relay.ts";

const OPEN_TIMEOUT_MS = 10_000;
const PING_MS = 20_000;
const MAX_STREAMS = 64;

export type RelayStatus = { connected: boolean; since: number | null; bytes: number; streams: number };

/** Holds each signed-in user's phone tunnel and opens store connections through it. */
export class RelayHub {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 2 << 20 });
  private readonly tunnels = new Map<string, Tunnel>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly capBytes: number;
  private readonly now: () => number;
  private readonly target: (value: string) => unknown;
  private readonly attachListeners = new Set<(userId: string) => void>();
  private readonly vaultListeners = new Set<(userId: string, message: VaultMessage) => void>();

  /** target changes only in tests that relay to a local server. */
  constructor(options: { capBytes: number; now: () => number; target?: (value: string) => unknown }) {
    this.capBytes = options.capBytes;
    this.now = options.now;
    this.target = options.target ?? relayTarget;
  }

  onAttach(listener: (userId: string) => void): void {
    this.attachListeners.add(listener);
  }

  onVault(listener: (userId: string, message: VaultMessage) => void): void {
    this.vaultListeners.add(listener);
  }

  /** Sends a vault message to the user's phone. False when no phone is connected. */
  sendVault(userId: string, message: VaultMessage): boolean {
    const tunnel = this.tunnels.get(userId);
    if (!tunnel?.open) return false;
    tunnel.sendRaw(encodeVault(message));
    return true;
  }

  /** Accepts the upgrade when owner resolves to a signed-in user. */
  handleUpgrade(request: IncomingMessage, socket: NodeDuplex, head: Buffer, owner: string | null): void {
    if (!owner) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    this.server.handleUpgrade(request, socket, head, (ws) => this.attach(owner, ws));
  }

  attach(userId: string, ws: WebSocket): void {
    this.tunnels.get(userId)?.close();
    const tunnel = new Tunnel(
      ws,
      this.capBytes,
      this.now(),
      () => {
        if (this.tunnels.get(userId) === tunnel) this.tunnels.delete(userId);
      },
      (message) => {
        for (const listener of this.vaultListeners) listener(userId, message);
      },
    );
    this.tunnels.set(userId, tunnel);
    for (const wake of this.waiters.get(userId) ?? []) wake();
    this.waiters.delete(userId);
    for (const listener of this.attachListeners) listener(userId);
  }

  has(userId: string): boolean {
    return this.tunnels.get(userId)?.open === true;
  }

  status(userId: string): RelayStatus {
    const tunnel = this.tunnels.get(userId);
    return tunnel?.open ? { connected: true, since: tunnel.since, bytes: tunnel.bytes, streams: tunnel.streamCount } : { connected: false, since: null, bytes: 0, streams: 0 };
  }

  /** Resolves true once the user's phone connects, or false after ms. */
  waitFor(userId: string, ms: number): Promise<boolean> {
    if (this.has(userId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const set = this.waiters.get(userId) ?? new Set<() => void>();
      const wake = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        set.delete(wake);
        resolve(false);
      }, ms);
      set.add(wake);
      this.waiters.set(userId, set);
    });
  }

  open(userId: string, target: string): Promise<Duplex> {
    const tunnel = this.tunnels.get(userId);
    if (!tunnel?.open) return Promise.reject(new Error("No phone is connected."));
    if (!this.target(target)) return Promise.reject(new Error("That host is not relayed."));
    return tunnel.openStream(target);
  }

  close(): void {
    for (const tunnel of this.tunnels.values()) tunnel.close();
    this.tunnels.clear();
    this.server.close();
  }
}

class Tunnel {
  open = true;
  bytes = 0;
  readonly since: number;
  private readonly streams = new Map<number, RelayStream>();
  private readonly pending = new Map<number, { resolve: (stream: RelayStream) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private readonly ws: WebSocket;
  private readonly capBytes: number;
  private readonly ping: NodeJS.Timeout;
  private readonly onVault: (message: VaultMessage) => void;

  constructor(ws: WebSocket, capBytes: number, since: number, onClose: () => void, onVault: (message: VaultMessage) => void) {
    this.ws = ws;
    this.onVault = onVault;
    this.capBytes = capBytes;
    this.since = since;
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    this.ping = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, PING_MS);
    ws.on("message", (data, isBinary) => {
      if (isBinary) this.receive(data);
    });
    ws.on("close", () => {
      this.shutdown();
      onClose();
    });
    ws.on("error", () => ws.terminate());
  }

  get streamCount(): number {
    return this.streams.size;
  }

  openStream(target: string): Promise<RelayStream> {
    if (this.streams.size + this.pending.size >= MAX_STREAMS) return Promise.reject(new Error("Too many relayed connections."));
    const id = this.nextId;
    this.nextId = this.nextId >= 0x7fffffff ? 1 : this.nextId + 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.send(RelayKind.close, id);
        reject(new Error("The phone did not open the connection in time."));
      }, OPEN_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send(RelayKind.open, id, new TextEncoder().encode(target));
    });
  }

  send(kind: (typeof RelayKind)[keyof typeof RelayKind], stream: number, payload?: Uint8Array): void {
    if (!this.open || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(encodeFrame(kind, stream, payload));
  }

  sendRaw(frame: Uint8Array): void {
    if (this.open && this.ws.readyState === this.ws.OPEN) this.ws.send(frame);
  }

  count(length: number): boolean {
    this.bytes += length;
    if (this.bytes <= this.capBytes) return true;
    this.close();
    return false;
  }

  drop(id: number): void {
    this.streams.delete(id);
  }

  close(): void {
    if (!this.open) return;
    this.ws.close(1000, "closed");
    this.shutdown();
  }

  private receive(raw: RawData): void {
    const bytes = raw instanceof Buffer ? raw : Buffer.concat(Array.isArray(raw) ? raw : [Buffer.from(raw as ArrayBuffer)]);
    const frame = decodeFrame(bytes);
    if (!frame) return;
    switch (frame.kind) {
      case RelayKind.opened: {
        const waiting = this.pending.get(frame.stream);
        if (!waiting) return;
        clearTimeout(waiting.timer);
        this.pending.delete(frame.stream);
        const stream = new RelayStream(this, frame.stream);
        this.streams.set(frame.stream, stream);
        waiting.resolve(stream);
        return;
      }
      case RelayKind.fail: {
        const waiting = this.pending.get(frame.stream);
        if (waiting) {
          clearTimeout(waiting.timer);
          this.pending.delete(frame.stream);
          waiting.reject(new Error("The phone could not reach that host."));
        }
        this.streams.get(frame.stream)?.destroy();
        return;
      }
      case RelayKind.data: {
        if (!this.count(frame.payload.length)) return;
        this.streams.get(frame.stream)?.push(Buffer.from(frame.payload));
        return;
      }
      case RelayKind.close:
        this.streams.get(frame.stream)?.remoteEnd();
        return;
      case RelayKind.vault: {
        const message = decodeVault(frame.payload);
        if (message?.op === "offer") this.onVault(message);
        return;
      }
      case RelayKind.open:
        return;
      default: {
        const neverKind: never = frame.kind;
        return neverKind;
      }
    }
  }

  private shutdown(): void {
    if (!this.open) return;
    this.open = false;
    clearInterval(this.ping);
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error("The phone disconnected."));
    }
    this.pending.clear();
    for (const stream of this.streams.values()) stream.destroy();
    this.streams.clear();
  }
}

class RelayStream extends Duplex {
  private readonly tunnel: Tunnel;
  private readonly id: number;
  private ended = false;

  constructor(tunnel: Tunnel, id: number) {
    super();
    this.tunnel = tunnel;
    this.id = id;
  }

  remoteEnd(): void {
    this.ended = true;
    this.push(null);
  }

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    if (!this.tunnel.open) {
      done(new Error("The phone disconnected."));
      return;
    }
    if (!this.tunnel.count(chunk.length)) {
      done(new Error("The relay data cap was reached."));
      return;
    }
    this.tunnel.send(RelayKind.data, this.id, chunk);
    done();
  }

  override _final(done: (error?: Error | null) => void): void {
    this.tunnel.send(RelayKind.close, this.id);
    done();
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    if (!this.ended) this.tunnel.send(RelayKind.close, this.id);
    this.tunnel.drop(this.id);
    done(error);
  }
}
