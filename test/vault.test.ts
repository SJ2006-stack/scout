import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { VAULT_TEMPLATE, vaultMarkdownError } from "../src/shared/vault.ts";
import { assistantPrompt, assistantTools, runAssistantTool } from "../src/server/assistantTools.ts";
import { Accounts } from "../src/server/auth/accounts.ts";
import { UserDirectory } from "../src/server/db/userDirectory.ts";
import { VaultStore } from "../src/server/vault/vaultStore.ts";
import { withApi } from "./helpers.ts";

describe("vault", () => {
  it("keeps a phone number and refuses a password, a PIN, a card, and an Aadhaar number", () => {
    assert.equal(vaultMarkdownError(VAULT_TEMPLATE), null);
    assert.equal(vaultMarkdownError("- Mobile: +91 9876543210"), null);
    assert.match(vaultMarkdownError("password: hunter2") ?? "", /password/);
    assert.match(vaultMarkdownError("PIN: 1234") ?? "", /PIN/);
    assert.match(vaultMarkdownError("Card: 4242 4242 4242 4242") ?? "", /card/);
    assert.match(vaultMarkdownError("Aadhaar: 1234 5678 9012") ?? "", /Aadhaar/);
    assert.match(vaultMarkdownError("4242424242424242") ?? "", /card/);
    assert.equal(vaultMarkdownError("Filled 2026-11-09 by Muse from the resumes (sj_resume.pdf, Jul 2024; Name-cv1.pdf, May 2024) and a LinkedIn profile."), null);
    assert.equal(vaultMarkdownError("- Entry number: 2024ME10194"), null);
    assert.equal(vaultMarkdownError("- JEE Main 2024 – AIR 7571 (CRL), 255/300, 99.53 percentile"), null);
    assert.match(VAULT_TEMPLATE, /Shriansh Jaiswal/);
  });

  it("puts the default Vault in the system prompt and returns it when nothing is saved", async () => {
    const vault = new VaultStore(":memory:");
    const context = { userId: "person", agent: "main" as const, now: () => 1, timezone: "Asia/Kolkata", vault };
    assert.match(assistantPrompt(context), /Nilgiri Hostel/);
    assert.match(assistantPrompt(context), /cannot change the Vault/);
    const read = await runAssistantTool(context, "read_vault", {}, () => undefined);
    assert.equal(read.ok, true);
    assert.match(read.content, /8171161782/);
  });

  it("lets the signed-in user save the Vault and lets Scout only read it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-vault-"));
    try {
      const file = join(dir, "scout.sqlite");
      const directory = new UserDirectory(file);
      const auth = new Accounts(directory, () => 1);
      const user = directory.ensureEmailUser("ada@gmail.com", 1);
      const vault = new VaultStore(file);
      const saved = vault.write(user.id, "- Legal full name: Ada Rao\n- Mobile: +91 9876543210", 5);
      assert.equal(saved.ok, true);
      const names = assistantTools({ userId: user.id, agent: "main", now: () => 1, timezone: "Asia/Kolkata", vault }).map((tool) => String(tool.name));
      assert.equal(names.includes("read_vault"), true);
      assert.equal(names.includes("write_vault"), false);
      const read = await runAssistantTool({ userId: user.id, agent: "main", now: () => 1, timezone: "Asia/Kolkata", vault }, "read_vault", {}, () => undefined);
      assert.equal(read.ok, true);
      assert.match(read.content, /Ada Rao/);
      await withApi({ auth, vault, now: () => 9 }, async (base) => {
        assert.equal((await fetch(`${base}/api/vault`)).status, 401);
        const headers = { cookie: `scout_session=${user.id}`, "content-type": "application/json" };
        const refused = await fetch(`${base}/api/vault`, { method: "PUT", headers, body: JSON.stringify({ markdown: "cvv: 123" }) });
        assert.equal(refused.status, 400);
        const put = await fetch(`${base}/api/vault`, { method: "PUT", headers, body: JSON.stringify({ markdown: "- Legal full name: Ada Iyer" }) });
        assert.equal(put.status, 200);
        const body = (await (await fetch(`${base}/api/vault`, { headers })).json()) as { markdown: string };
        assert.match(body.markdown, /Ada Iyer/);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
