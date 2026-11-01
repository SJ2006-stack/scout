import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { decodeFrame, decodeVault, encodeVault, RELAY_PATH } from "../src/shared/relay.ts";
import { SessionVault } from "../src/server/browser/sessionVault.ts";
import { runRelayDevice } from "../src/server/relay/deviceClient.ts";
import { fileDeviceVault, memoryDeviceVault } from "../src/server/relay/deviceVault.ts";
import { RelayHub } from "../src/server/relay/relayHub.ts";
import { mirrorVault } from "../src/server/relay/vaultMirror.ts";

const USER = "a".repeat(32);
const OTHER = "b".repeat(32);
const DAY = 86_400_000;
const STATE = {
  cookies: [{ name: "gr_1_accessToken", value: "secret-token", domain: ".blinkit.com", path: "/" }],
  origins: [{ origin: "https://blinkit.com", localStorage: [{ name: "auth", value: "1" }] }],
};

function settle(ms = 80): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("vault wire format", () => {
  it("round-trips put and drop and refuses junk", () => {
    const blob = randomBytes(64);
    const frame = decodeFrame(encodeVault({ op: "put", domain: "blinkit.com", updatedAt: 5, expiresAt: 9, lastValidatedAt: 5, blob }));
    const put = frame ? decodeVault(frame.payload) : null;
    assert.equal(put?.op, "put");
    assert.deepEqual(put?.op === "put" ? Buffer.from(put.blob) : null, blob);
    const drop = decodeFrame(encodeVault({ op: "drop", domain: "zepto.com", at: 7 }));
    assert.deepEqual(drop ? decodeVault(drop.payload) : null, { op: "drop", domain: "zepto.com", at: 7 });
    assert.equal(decodeVault(new Uint8Array([0, 0, 0, 2, 123, 125])), null);
  });
});

describe("session vault restore", () => {
  let dir = "";
  let now = 1_000_000;
  const key = randomBytes(32);
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-restore-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("restores a sealed copy into an empty disk, but only for its own user and key", () => {
    const first = new SessionVault(join(dir, "a"), key, 30 * DAY, () => now);
    first.save(USER, "blinkit.com", STATE, true);
    const sealed = first.sealed(USER, "blinkit.com");
    assert.ok(sealed);
    assert.equal(sealed.blob.includes(Buffer.from("secret-token")), false);

    const wiped = new SessionVault(join(dir, "b"), key, 30 * DAY, () => now);
    assert.equal(wiped.restore(OTHER, sealed), "rejected");
    assert.equal(new SessionVault(join(dir, "c"), randomBytes(32), 30 * DAY, () => now).restore(USER, sealed), "rejected");
    assert.equal(wiped.restore(USER, { ...sealed, domain: "zepto.com" }), "rejected");
    assert.equal(wiped.restore(USER, sealed), "restored");
    assert.equal(wiped.load(USER, "blinkit.com")?.cookies[0]?.value, "secret-token");
    assert.equal(wiped.restore(USER, sealed), "kept");
  });

  it("refuses expired copies and copies older than a revoke", () => {
    const vault = new SessionVault(join(dir, "d"), key, 30 * DAY, () => now);
    vault.save(USER, "zepto.com", { cookies: [{ name: "t", value: "v", domain: ".zepto.com" }], origins: [] }, true);
    const sealed = vault.sealed(USER, "zepto.com");
    assert.ok(sealed);
    now += 1_000;
    vault.revoke(USER, "zepto.com");
    assert.equal(vault.restore(USER, sealed), "revoked");
    assert.equal(vault.load(USER, "zepto.com"), null);
    const fresh = new SessionVault(join(dir, "e"), key, 30 * DAY, () => now);
    assert.equal(fresh.restore(USER, { ...sealed, expiresAt: now - 1 }), "rejected");
  });
});

describe("vault mirror over the relay", () => {
  let web: Server;
  let hub: RelayHub;
  let url = "";
  let dir = "";
  let vault: SessionVault;
  const key = randomBytes(32);

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "vault-mirror-"));
    vault = new SessionVault(join(dir, "server"), key, 30 * DAY, Date.now);
    hub = new RelayHub({ capBytes: 1 << 24, now: Date.now });
    mirrorVault(vault, hub);
    web = createServer();
    web.on("upgrade", (request, socket, head) => {
      const owner = request.headers["x-scout-session"] === USER ? USER : null;
      hub.handleUpgrade(request, socket, head, owner);
    });
    await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", () => resolve()));
    url = `ws://127.0.0.1:${(web.address() as AddressInfo).port}${RELAY_PATH}`;
  });

  after(() => {
    hub.close();
    web.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("copies a new sign-in to the phone, restores it after the server loses its disk, and drops it on revoke", async () => {
    const phone = memoryDeviceVault();
    const device = runRelayDevice({ url, headers: { "x-scout-session": USER }, vault: phone });
    await device.ready;
    vault.save(USER, "blinkit.com", STATE, true);
    await settle();
    assert.equal(phone.copies.get("blinkit.com")?.domain, "blinkit.com");
    device.close();
    await device.closed;

    rmSync(join(dir, "server"), { recursive: true, force: true });
    assert.equal(vault.load(USER, "blinkit.com"), null);

    const again = runRelayDevice({ url, headers: { "x-scout-session": USER }, vault: phone });
    await again.ready;
    await settle();
    assert.equal(vault.load(USER, "blinkit.com")?.cookies[0]?.value, "secret-token");

    vault.revoke(USER, "blinkit.com");
    await settle();
    assert.equal(phone.copies.has("blinkit.com"), false);
    again.close();
    await again.closed;
  });

  it("tells a phone that was offline during a revoke to drop its stale copy", async () => {
    const phone = memoryDeviceVault();
    const device = runRelayDevice({ url, headers: { "x-scout-session": USER }, vault: phone });
    await device.ready;
    vault.save(USER, "zepto.com", { cookies: [{ name: "t", value: "v", domain: ".zepto.com" }], origins: [] }, true);
    await settle();
    device.close();
    await device.closed;
    await settle(5);
    vault.revoke(USER, "zepto.com");

    const again = runRelayDevice({ url, headers: { "x-scout-session": USER }, vault: phone });
    await again.ready;
    await settle();
    assert.equal(phone.copies.has("zepto.com"), false);
    assert.equal(vault.load(USER, "zepto.com"), null);
    again.close();
    await again.closed;
  });

  it("keeps copies on disk between device runs", async () => {
    const folder = join(dir, "phone");
    const device = runRelayDevice({ url, headers: { "x-scout-session": USER }, vault: fileDeviceVault(folder) });
    await device.ready;
    vault.save(USER, "swiggy.com", { cookies: [{ name: "s", value: "w", domain: ".swiggy.com" }], origins: [] }, true);
    await settle();
    device.close();
    await device.closed;
    assert.deepEqual(fileDeviceVault(folder).list().map((copy) => copy.domain), ["swiggy.com"]);
  });
});
