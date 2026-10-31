import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BrowserStore } from "../src/server/browser/store.ts";
import { scoutDbPath, UserDirectory } from "../src/server/db/userDirectory.ts";

const USER = "a".repeat(32);
const OTHER = "b".repeat(32);

describe("user directory", () => {
  it("keeps each user and the browser session attached to them", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-users-"));
    try {
      const file = join(dir, "scout.sqlite");
      const directory = new UserDirectory(file);
      directory.touch(USER, 10);
      directory.touch(USER, 5);
      assert.equal(directory.user(USER)?.lastSeenAt, 10);
      directory.touch(USER, 20);
      assert.equal(directory.user(USER)?.createdAt, 10);
      assert.equal(directory.user(USER)?.lastSeenAt, 20);

      const store = new BrowserStore(join(dir, "sessions.json"), directory);
      const session = store.openSession({ ownerId: USER, taskId: null, now: 30, ttlMs: 1_000 });
      store.updateOpen(session.id, { url: "https://example.com/event", title: "Show" }, 40);
      const rows = directory.browsersFor(USER);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.url, "https://example.com/event");
      assert.equal(rows[0]?.title, "Show");
      assert.equal(rows[0]?.status, "open");
      assert.equal(rows[0]?.profileState, "absent");
      directory.setProfile(USER, { state: "saved", expiresAt: 90 }, 50);
      assert.equal(directory.browsersFor(USER)[0]?.profileState, "saved");
      assert.equal(directory.browsersFor(USER)[0]?.profileExpiresAt, 90);
      assert.equal(directory.browsersFor(OTHER).length, 0);
      assert.equal(readFileSync(file).includes("secret-cookie-value"), false);
      assert.equal(scoutDbPath("/app", {}), join("/app", ".data", "scout.sqlite"));
      assert.equal(scoutDbPath("/app", { SCOUT_DB_PATH: "/tmp/scout.sqlite", WEBSITE_SITE_NAME: "sj-scout" }), "/tmp/scout.sqlite");
      assert.equal(scoutDbPath("/app", { WEBSITE_SITE_NAME: "sj-scout" }), "/home/data/scout.sqlite");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
