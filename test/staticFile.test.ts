import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parseRange, sendFile } from "../src/server/staticFile.ts";

describe("parseRange", () => {
  it("reads open, closed and suffix ranges", () => {
    assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
    assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange("bytes=50-500", 100), { start: 50, end: 99 });
  });

  it("ignores a missing or multi-part header and rejects one that cannot be met", () => {
    assert.equal(parseRange(undefined, 100), null);
    assert.equal(parseRange("bytes=0-1,5-6", 100), null);
    assert.equal(parseRange("bytes=100-", 100), "bad");
    assert.equal(parseRange("bytes=9-3", 100), "bad");
    assert.equal(parseRange("bytes=-", 100), "bad");
  });
});

describe("sendFile", () => {
  let dir = "";
  let server: Server;
  let base = "";
  const body = Buffer.from("0123456789".repeat(10));

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "scout-static-"));
    writeFileSync(join(dir, "clip.mp4"), body);
    writeFileSync(join(dir, "page.html"), "<p>hi</p>");
    server = createServer((request, response) => sendFile(request, response, join(dir, new URL(request.url ?? "/", "http://x").pathname.slice(1))));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves video with its type and advertises ranges", async () => {
    const response = await fetch(`${base}/clip.mp4`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "video/mp4");
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(Buffer.from(await response.arrayBuffer()).equals(body), true);
  });

  it("answers a range with 206 and only those bytes", async () => {
    const response = await fetch(`${base}/clip.mp4`, { headers: { range: "bytes=10-19" } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 10-19/100");
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "0123456789");
  });

  it("refuses a range past the end with 416", async () => {
    const response = await fetch(`${base}/clip.mp4`, { headers: { range: "bytes=500-" } });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), "bytes */100");
  });

  it("keeps html uncached and answers HEAD without a body", async () => {
    const page = await fetch(`${base}/page.html`);
    assert.equal(page.headers.get("cache-control"), "no-cache");
    const head = await fetch(`${base}/clip.mp4`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "100");
  });
});
