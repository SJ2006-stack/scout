import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, isIP, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { relayHost } from "../../shared/relay.ts";
import { browserHostIsPublic } from "../browser/policy.ts";
import type { RelayHub } from "./relayHub.ts";

export type ProxySettings = { server: string; username: string; password: string };

/**
 * A loopback HTTPS proxy for Chromium contexts. Store hosts go out through the
 * owner's phone; other public hosts connect directly from the server.
 */
export class EgressProxy {
  private readonly hub: RelayHub;
  private readonly publicOnly: boolean;
  private readonly relayed: (host: string) => boolean;
  private readonly ports: ReadonlySet<number>;
  private readonly owners = new Map<string, string>();
  private readonly tokens = new Map<string, string>();
  private server: Server | null = null;
  private port: Promise<number> | null = null;

  /** publicOnly, relayed, and ports change only in tests against local servers. */
  constructor(hub: RelayHub, options: { publicOnly?: boolean; relayed?: (host: string) => boolean; ports?: readonly number[] } = {}) {
    this.hub = hub;
    this.publicOnly = options.publicOnly !== false;
    this.relayed = options.relayed ?? relayHost;
    this.ports = new Set(options.ports ?? [443]);
  }

  /** Proxy settings that route this user's store traffic through their phone. */
  async settingsFor(userId: string): Promise<ProxySettings> {
    let token = this.tokens.get(userId);
    if (!token) {
      token = randomBytes(18).toString("hex");
      this.tokens.set(userId, token);
      this.owners.set(token, userId);
    }
    const port = await this.listen();
    return { server: `http://127.0.0.1:${port}`, username: token, password: "relay" };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private listen(): Promise<number> {
    if (this.port) return this.port;
    const server = createServer((_request, response) => {
      response.writeHead(405, { connection: "close" }).end();
    });
    server.on("connect", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.tunnel(request, socket as Socket, head);
    });
    this.server = server;
    this.port = new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
    return this.port;
  }

  private async tunnel(request: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    client.on("error", () => client.destroy());
    const owner = this.owners.get(proxyUser(request.headers["proxy-authorization"]) ?? "");
    const target = /^([a-z0-9.-]{1,253}):(\d{1,5})$/i.exec(request.url ?? "");
    const host = target?.[1]?.toLowerCase() ?? "";
    const port = Number(target?.[2] ?? 0);
    if (!owner) return refuse(client, "407 Proxy Authentication Required");
    if (!host || !this.ports.has(port)) return refuse(client, "403 Forbidden");
    try {
      const upstream = this.relayed(host) ? await this.hub.open(owner, `${host}:${port}`) : await this.direct(host, port);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.on("error", () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    } catch {
      refuse(client, "502 Bad Gateway");
    }
  }

  private async direct(host: string, port: number): Promise<Duplex> {
    const address = isIP(host) !== 0 ? host : (await lookup(host)).address;
    if (this.publicOnly && !(await browserHostIsPublic(address))) throw new Error("That host is not public.");
    return await new Promise((resolve, reject) => {
      const socket = connect({ host: address, port });
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
  }
}

function proxyUser(header: string | undefined): string | null {
  const match = /^Basic\s+(.+)$/i.exec(header ?? "");
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon > 0 ? decoded.slice(0, colon) : null;
}

function refuse(client: Socket, status: string): void {
  client.end(`HTTP/1.1 ${status}\r\nProxy-Authenticate: Basic realm="scout"\r\nConnection: close\r\n\r\n`);
}
