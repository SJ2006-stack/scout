import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { dropDraft, dropMessage, linkLabel, readDrop } from "../src/shared/scoutDrop.ts";
import { finishSharedDrop, sharedImageFile, takeSharedDrop } from "../src/web/scoutDrop.ts";

const ID = "0123456789abcdef01234567";
const IMAGE = "abcdefabcdefabcdefabcdef";

describe("Scout Drop payload", () => {
  it("accepts a share from the app and keeps only safe fields", () => {
    const drop = readDrop({
      id: ID,
      text: "Try this place https://maps.example/p",
      subject: " Dinner ",
      urls: ["https://maps.example/p", "javascript:alert(1)", "file:///sdcard/a", "https://u:p@evil.example/"],
      notes: ["Only the first 4 images were kept."],
      images: [
        { id: IMAGE, mime: "image/png", bytes: 1200 },
        { id: "../../etc/passwd", mime: "image/png", bytes: 10 },
        { id: IMAGE, mime: "image/svg+xml", bytes: 10 },
        { id: IMAGE, mime: "image/jpeg", bytes: 9_000_000 },
      ],
      path: "/data/user/0/app.scout/cache",
    });
    assert.deepEqual(drop, {
      id: ID,
      text: "Try this place https://maps.example/p",
      subject: "Dinner",
      urls: ["https://maps.example/p"],
      notes: ["Only the first 4 images were kept."],
      images: [{ id: IMAGE, mime: "image/png", bytes: 1200 }],
    });
  });

  it("treats empty or malformed replies as no share", () => {
    assert.equal(readDrop(null), null);
    assert.equal(readDrop("drop"), null);
    assert.equal(readDrop({ id: "nope", text: "hi" }), null);
    assert.equal(readDrop({ id: ID, text: "   ", images: [] }), null);
  });

  it("caps text and image count again on the page", () => {
    const images = Array.from({ length: 7 }, () => ({ id: IMAGE, mime: "image/webp", bytes: 10 }));
    const drop = readDrop({ id: ID, text: "x".repeat(25_000), images });
    assert.equal(drop?.text.length, 20_000);
    assert.equal(drop?.images.length, 4);
  });

  it("starts the draft with the title unless the text already has it", () => {
    const base = { id: ID, urls: [], notes: [], images: [] };
    assert.equal(dropDraft({ ...base, text: "https://a.example/x", subject: "A title" }), "A title\nhttps://a.example/x");
    assert.equal(dropDraft({ ...base, text: "A title is here", subject: "A title" }), "A title is here");
    assert.equal(dropDraft({ ...base, text: "", subject: "Only a title" }), "Only a title");
  });

  it("adds the text read from each kept image after the edited note", () => {
    assert.equal(dropMessage("  Compare these  ", ["Amul Taaza ₹54", "", "Mother Dairy ₹52"]), "Compare these\nAmul Taaza ₹54\nMother Dairy ₹52");
    assert.equal(dropMessage("", ["Menu: Thali ₹220"]), "Menu: Thali ₹220");
    assert.equal(dropMessage("   ", []), "");
  });

  it("labels links without opening them", () => {
    assert.equal(linkLabel("https://www.example.com/"), "example.com");
    assert.equal(linkLabel("https://example.com/a/b?q=1"), "example.com/a/b");
    assert.ok(linkLabel(`https://example.com/${"x".repeat(100)}`).endsWith("…"));
  });
});

describe("Scout Drop bridge", () => {
  const scope = globalThis as unknown as { window?: unknown };
  afterEach(() => {
    delete scope.window;
  });

  function fakeApp(reply: (body: Record<string, unknown>) => unknown): Record<string, unknown>[] {
    const calls: Record<string, unknown>[] = [];
    scope.window = {
      ScoutNative: {
        request: (json: string) => {
          const body = JSON.parse(json) as Record<string, unknown>;
          calls.push(body);
          return JSON.stringify(reply(body));
        },
      },
    };
    return calls;
  }

  it("does nothing outside the Android app", () => {
    scope.window = {};
    assert.equal(takeSharedDrop(), null);
  });

  it("takes a share, reads one image as a File, and finishes it", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const calls = fakeApp((body) => {
      if (body.op === "drop_take") return { accepted: true, drop: { id: ID, text: "hi", images: [{ id: IMAGE, mime: "image/png", bytes: png.length }] } };
      if (body.op === "drop_file") return { accepted: true, mime: "image/png", data: Buffer.from(png).toString("base64") };
      return { accepted: true };
    });
    const drop = takeSharedDrop();
    assert.ok(drop);
    const file = sharedImageFile(drop, drop.images[0]!);
    assert.ok(file);
    assert.equal(file.type, "image/png");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), png);
    finishSharedDrop(drop);
    assert.deepEqual(calls, [
      { op: "drop_take" },
      { op: "drop_file", id: ID, image: IMAGE },
      { op: "drop_done", id: ID },
    ]);
  });

  it("ignores refusals, a missing share, and a mismatched image type", () => {
    fakeApp((body) => (body.op === "drop_take" ? { accepted: true, drop: null } : { accepted: false }));
    assert.equal(takeSharedDrop(), null);
    const drop = { id: ID, text: "", subject: null, urls: [], notes: [], images: [{ id: IMAGE, mime: "image/png", bytes: 3 }] };
    assert.equal(sharedImageFile(drop, drop.images[0]!), null);
    fakeApp(() => ({ accepted: true, mime: "image/jpeg", data: "AAAA" }));
    assert.equal(sharedImageFile(drop, drop.images[0]!), null);
    scope.window = { ScoutNative: { request: () => "not json" } };
    assert.equal(takeSharedDrop(), null);
  });
});
