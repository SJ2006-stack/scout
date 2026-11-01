import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from "node:net";
import { after, before, describe, it } from "node:test";
import { decodeFrame, encodeFrame, RELAY_PATH, RelayKind, relayHost, relayTarget } from "../src/shared/relay.ts";
import { runRelayDevice } from "../src/server/relay/deviceClient.ts";
import { EgressProxy } from "../src/server/relay/egressProxy.ts";
import { phoneEgress } from "../src/server/relay/phoneEgress.ts";
import { RelayHub } from "../src/server/relay/relayHub.ts";

const USER = "a".repeat(32);

describe("relay wire format and allowlist", () => {
  it("round-trips frames", () => {
    const frame = decodeFrame(encodeFrame(RelayKind.data, 70_000, new Uint8Array([1, 2, 3])));
    assert.equal(frame?.kind, RelayKind.data);
    assert.equal(frame?.stream, 70_000);
    assert.deepEqual([...(frame?.payload ?? [])], [1, 2, 3]);
    assert.equal(decodeFrame(new Uint8Array([9, 0, 0, 0, 1])), null);
  });

  it("relays only store hosts on 443", () => {
    assert.equal(relayHost("blinkit.com"), true);
    assert.equal(relayHost("api.zepto.com"), true);
    assert.equal(relayHost("www.swiggy.com"), true);
    assert.equal(relayHost("in.bookmyshow.com"), true);
    assert.equal(relayHost("www.district.in"), true);
    assert.equal(relayHost("notdistrict.in"), false);
    assert.equal(relayHost("blinkit.com.evil.com"), false);
    assert.equal(relayHost("evilblinkit.com"), false);
    assert.deepEqual(relayTarget("blinkit.com:443"), { host: "blinkit.com", port: 443 });
    assert.equal(relayTarget("blinkit.com:80"), null);
    assert.equal(relayTarget("169.254.169.254:443"), null);
    assert.equal(relayTarget("example.com:443"), null);
  });
});

describe("phone relay", () => {
  let echo: TcpServer;
  let echoPort = 0;
  let web: Server;
  let hub: RelayHub;
  let proxy: EgressProxy;
  let origin = "";

  before(async () => {
    echo = createTcpServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", () => resolve()));
    echoPort = (echo.address() as AddressInfo).port;
    const local = (value: string) => (value === `localhost:${echoPort}` ? { host: "127.0.0.1", port: echoPort } : null);
    hub = new RelayHub({ capBytes: 1 << 20, now: Date.now, target: local });
    proxy = new EgressProxy(hub, { publicOnly: false, relayed: (host) => host === "localhost", ports: [echoPort] });
    web = createServer();
    web.on("upgrade", (request, socket, head) => {
      const owner = request.headers["x-scout-session"] === USER ? USER : null;
      hub.handleUpgrade(request, socket, head, owner);
    });
    await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", () => resolve()));
    origin = `ws://127.0.0.1:${(web.address() as AddressInfo).port}${RELAY_PATH}`;
  });

  after(async () => {
    hub.close();
    await proxy.close();
    web.close();
    echo.close();
  });

  it("carries a CONNECT tunnel through the phone and back", async () => {
    const device = runRelayDevice({
      url: origin,
      headers: { "x-scout-session": USER },
      accept: (value) => (value === `localhost:${echoPort}` ? { host: "127.0.0.1", port: echoPort } : null),
    });
    await device.ready;
    assert.equal(hub.status(USER).connected, true);
    const settings = await proxy.settingsFor(USER);
    const reply = await throughProxy(settings, `localhost:${echoPort}`, "ping through the phone");
    assert.match(reply, /^HTTP\/1\.1 200/);
    assert.match(reply, /ping through the phone$/);
    assert.ok(hub.status(USER).bytes >= "ping through the phone".length * 2);
    device.close();
    await device.closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(hub.status(USER).connected, false);
  });

  it("refuses wrong proxy credentials and hosts the phone does not allow", async () => {
    const device = runRelayDevice({ url: origin, headers: { "x-scout-session": USER }, accept: () => null });
    await device.ready;
    const settings = await proxy.settingsFor(USER);
    const wrong = await throughProxy({ ...settings, username: "nobody" }, `localhost:${echoPort}`, "x");
    assert.match(wrong, /^HTTP\/1\.1 407/);
    const refused = await throughProxy(settings, `localhost:${echoPort}`, "x");
    assert.match(refused, /^HTTP\/1\.1 502/);
    const port = await throughProxy(settings, "localhost:22", "x");
    assert.match(port, /^HTTP\/1\.1 403/);
    device.close();
    await device.closed;
  });

  it("rejects a phone that is not signed in", async () => {
    const device = runRelayDevice({ url: origin, headers: {} });
    await assert.rejects(device.ready, /401/);
  });

  it("gives a page read the phone only when it is already connected", async () => {
    const egress = phoneEgress(hub, proxy, { waitMs: 2_000 });
    const started = Date.now();
    assert.equal(await egress(USER, { wait: false }), undefined);
    assert.ok(Date.now() - started < 200);
    const device = runRelayDevice({ url: origin, headers: { "x-scout-session": USER } });
    await device.ready;
    assert.ok((await egress(USER, { wait: false }))?.server.startsWith("http://127.0.0.1:"));
    device.close();
    await device.closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("wakes a waiting task when the phone connects", async () => {
    const waiting = hub.waitFor(USER, 2_000);
    const device = runRelayDevice({ url: origin, headers: { "x-scout-session": USER } });
    assert.equal(await waiting, true);
    assert.equal(await hub.waitFor("b".repeat(32), 20), false);
    device.close();
    await device.closed;
  });
});

async function throughProxy(settings: { server: string; username: string; password: string }, target: string, text: string): Promise<string> {
  const { port } = new URL(settings.server);
  const socket = connect({ host: "127.0.0.1", port: Number(port) });
  const auth = Buffer.from(`${settings.username}:${settings.password}`).toString("base64");
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
  let received = "";
  let sent = false;
  return await new Promise((resolve) => {
    const finish = (): void => {
      socket.destroy();
      resolve(received);
    };
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (!sent && /^HTTP\/1\.1 200/.test(received) && received.includes("\r\n\r\n")) {
        sent = true;
        socket.write(text);
      }
      if (sent && received.endsWith(text)) finish();
    });
    socket.on("close", () => resolve(received));
    setTimeout(finish, 2_000);
  });
}
