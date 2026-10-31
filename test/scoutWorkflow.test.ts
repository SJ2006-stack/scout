import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright-core";
import { CheckoutLedger, type CartReview } from "../src/server/browser/checkoutLedger.ts";
import { ChallengeClosed, OtpBroker } from "../src/server/browser/otpBroker.ts";
import { PlaywrightBrowserDriver } from "../src/server/browser/playwrightDriver.ts";
import { SessionVault } from "../src/server/browser/sessionVault.ts";
import { checkoutControl, readCart } from "../src/server/browser/siteFlows.ts";
import { SKILLS, validateStage } from "../src/server/browser/skills.ts";
import { TaskRunner } from "../src/server/browser/taskRunner.ts";
import type { ScoutTaskView } from "../src/shared/scoutTask.ts";
import { FixtureMerchant } from "./fixtures/merchant.ts";

const KEY = Buffer.alloc(32, 7);
const ALICE = "a".repeat(32);
const BOB = "b".repeat(32);

function cart(total: number, quantity = 2): CartReview {
  return { skill: "blinkit", merchant: "Blinkit", pageUrl: "https://blinkit.com/cart", lines: [{ title: "Milk", quantity, paise: 3300 * quantity }], fees: [{ label: "Delivery fee", paise: 2500 }], totalPaise: total };
}

describe("otp broker", () => {
  const ref = (userId: string, taskId: string) => ({ userId, sessionId: taskId, taskId, domain: "blinkit.com", channel: "sms" as const });

  it("delivers a code only to the matching task and user", async () => {
    let now = 0;
    const broker = new OtpBroker(() => now);
    const mine = broker.open(ref(ALICE, "1".repeat(32)), ["phone-a"]);
    const other = broker.open(ref(ALICE, "2".repeat(32)), ["phone-a"]);
    const waiting = broker.wait(mine.challengeId);
    assert.deepEqual(broker.submit({ userId: ALICE, deviceId: "phone-a", challengeId: mine.challengeId, token: other.token, code: "123456" }), { ok: false, reason: "token" });
    assert.deepEqual(broker.submit({ userId: BOB, deviceId: "phone-a", challengeId: mine.challengeId, token: mine.token, code: "123456" }), { ok: false, reason: "owner" });
    assert.deepEqual(broker.submit({ userId: ALICE, deviceId: "phone-b", challengeId: mine.challengeId, token: mine.token, code: "123456" }), { ok: false, reason: "device" });
    assert.equal(broker.submit({ userId: ALICE, deviceId: "phone-a", challengeId: mine.challengeId, token: mine.token, code: "123456" }).ok, true);
    assert.equal(await waiting, "123456");
    now += 1;
    assert.equal(broker.get(other.challengeId)?.state, "open");
  });

  it("rejects a duplicate code and an expired one", async () => {
    let now = 0;
    const broker = new OtpBroker(() => now, 1_000);
    const ticket = broker.open(ref(ALICE, "3".repeat(32)));
    const input = { userId: ALICE, deviceId: null, manual: true, challengeId: ticket.challengeId, token: ticket.token, code: "4321" };
    assert.equal(broker.submit(input).ok, true);
    assert.deepEqual(broker.submit(input), { ok: false, reason: "used" });
    const late = broker.open(ref(ALICE, "4".repeat(32)));
    now += 1_001;
    assert.deepEqual(broker.submit({ ...input, challengeId: late.challengeId, token: late.token }), { ok: false, reason: "expired" });
  });

  it("rejects a code after the task is cancelled and fails the waiter", async () => {
    const broker = new OtpBroker(() => 0);
    const ticket = broker.open(ref(ALICE, "5".repeat(32)));
    const waiting = broker.wait(ticket.challengeId);
    broker.cancelTask("5".repeat(32));
    await assert.rejects(waiting, (error: unknown) => error instanceof ChallengeClosed && error.reason === "cancelled");
    assert.deepEqual(broker.submit({ userId: ALICE, deviceId: null, manual: true, challengeId: ticket.challengeId, token: ticket.token, code: "123456" }), { ok: false, reason: "cancelled" });
  });

  it("never keeps the code after it is handed over", () => {
    const broker = new OtpBroker(() => 0);
    const ticket = broker.open(ref(ALICE, "6".repeat(32)));
    broker.submit({ userId: ALICE, deviceId: null, manual: true, challengeId: ticket.challengeId, token: ticket.token, code: "998877" });
    void broker.wait(ticket.challengeId);
    assert.equal(JSON.stringify(broker.get(ticket.challengeId)).includes("998877"), false);
    assert.equal(JSON.stringify(broker.get(ticket.challengeId)).includes(ticket.token), false);
  });
});

describe("session vault", () => {
  it("keeps sites and users apart, loads only verified sessions, and survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-vault-"));
    try {
      let now = 1_000;
      const vault = new SessionVault(dir, KEY, 60_000, () => now);
      const state = {
        cookies: [{ name: "sid", value: "alice-blinkit", domain: ".blinkit.com" }, { name: "sid", value: "alice-zepto", domain: "www.zeptonow.com" }],
        origins: [{ origin: "https://blinkit.com", localStorage: [] }],
      };
      vault.save(ALICE, "blinkit.com", state, false);
      assert.equal(vault.load(ALICE, "blinkit.com"), null);
      vault.markValidated(ALICE, "www.blinkit.com");
      const loaded = vault.load(ALICE, "blinkit.com");
      assert.deepEqual(loaded?.cookies.map((cookie) => cookie.value), ["alice-blinkit"]);
      assert.equal(vault.load(BOB, "blinkit.com"), null);
      assert.equal(vault.load(ALICE, "zeptonow.com"), null);
      const files = readdirSync(dir).filter((name) => name.endsWith(".bin"));
      assert.equal(files.length, 1);
      assert.equal(readFileSync(join(dir, files[0] ?? "")).includes(Buffer.from("alice-blinkit")), false);
      const restarted = new SessionVault(dir, KEY, 60_000, () => now);
      assert.deepEqual(restarted.load(ALICE, "blinkit.com")?.cookies.map((cookie) => cookie.value), ["alice-blinkit"]);
      assert.equal(new SessionVault(dir, Buffer.alloc(32, 9), 60_000, () => now).load(ALICE, "blinkit.com"), null);
      now += 60_001;
      assert.equal(restarted.load(ALICE, "blinkit.com"), null);
      assert.equal(restarted.list(ALICE)[0]?.state, "expired");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("revokes one site and stops loading it", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-vault-"));
    try {
      const vault = new SessionVault(dir, KEY, 60_000, () => 1);
      vault.save(ALICE, "blinkit.com", { cookies: [{ name: "a", value: "1", domain: "blinkit.com" }], origins: [] }, true);
      vault.save(ALICE, "luma.com", { cookies: [{ name: "b", value: "2", domain: "luma.com" }], origins: [] }, true);
      vault.revoke(ALICE, "blinkit.com");
      assert.equal(vault.load(ALICE, "blinkit.com"), null);
      assert.notEqual(vault.load(ALICE, "luma.com"), null);
      assert.equal(vault.status(ALICE).state, "saved");
      vault.revoke(ALICE);
      assert.equal(vault.status(ALICE).state, "revoked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkout ledger", () => {
  it("presses pay once, replays a duplicate, and blocks a changed amount", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-ledger-"));
    try {
      let now = 0;
      const ledger = new CheckoutLedger(join(dir, "checkout.json"), () => now);
      const record = ledger.propose(ALICE, cart(9100));
      assert.deepEqual(ledger.beginInitiation(ALICE, record.id, "key-0000001", cart(9100)).action, "reject");
      assert.equal(ledger.approve(BOB, record.id, record.fingerprint).ok, false);
      assert.deepEqual(ledger.approve(ALICE, record.id, "0".repeat(32)), { ok: false, reason: "mismatch" });
      assert.equal(ledger.approve(ALICE, record.id, record.fingerprint).ok, true);
      assert.equal(ledger.beginInitiation(ALICE, record.id, "key-0000001", cart(9100)).action, "click");
      assert.equal(ledger.beginInitiation(ALICE, record.id, "key-0000002", cart(9100)).action, "replay");
      const restarted = new CheckoutLedger(join(dir, "checkout.json"), () => now);
      assert.equal(restarted.beginInitiation(ALICE, record.id, "key-0000001", cart(9100)).action, "replay");

      const second = ledger.propose(ALICE, cart(12400, 3));
      ledger.approve(ALICE, second.id, second.fingerprint);
      const changed = ledger.beginInitiation(ALICE, second.id, "key-0000003", cart(13000, 3));
      assert.equal(changed.action, "reject");
      assert.equal(changed.action === "reject" && changed.reason, "changed");
      assert.equal(ledger.get(ALICE, second.id)?.state, "changed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("times out a payment with no provider confirmation", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-ledger-"));
    try {
      let now = 0;
      const ledger = new CheckoutLedger(join(dir, "checkout.json"), () => now);
      const record = ledger.propose(ALICE, cart(9100));
      ledger.approve(ALICE, record.id, record.fingerprint);
      ledger.beginInitiation(ALICE, record.id, "key-0000004", cart(9100));
      ledger.recordHandoff(record.id, null);
      now += 15 * 60_000;
      assert.equal(ledger.get(ALICE, record.id)?.state, "timed_out");
      assert.equal(ledger.confirm(record.id, "X1")?.state, "timed_out");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("website skills", () => {
  it("covers the six sites and refuses a CAPTCHA, an off-site page, and an autopay button", () => {
    assert.deepEqual(Object.keys(SKILLS).sort(), ["blinkit", "bookmyshow", "district", "instamart", "luma", "zepto"]);
    const blinkit = SKILLS.blinkit;
    assert.equal(validateStage(blinkit, "home", { url: "https://evil.example/", elements: [], text: "" }).ok, false);
    const captcha = validateStage(blinkit, "home", { url: "https://blinkit.com/", elements: [], text: "Verify you are human" });
    assert.equal(!captcha.ok && captcha.reason, "captcha");
    const control = checkoutControl(blinkit, [{ role: "button", name: "Enable Autopay" }, { role: "button", name: "Pay now" }], new Set());
    assert.equal(control?.element.name, "Pay now");
    assert.equal(checkoutControl(blinkit, [{ role: "button", name: "Set up UPI autopay mandate" }], new Set()), null);
    const review = readCart(blinkit, { url: "https://blinkit.com/cart", elements: [], text: "Amul Milk × 2 ₹66\nItem total ₹66\nDelivery fee ₹25\nHandling charge ₹4\nGrand total ₹95" });
    assert.deepEqual(review?.lines, [{ title: "Amul Milk", quantity: 2, paise: 6600 }]);
    assert.equal(review?.totalPaise, 9500);
    assert.equal(review?.fees.length, 2);
  });
});

function chromiumInstalled(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

describe("scout workflow on a real browser", { skip: !chromiumInstalled() }, () => {
  const merchant = new FixtureMerchant();
  let dir = "";

  before(async () => {
    await merchant.start();
    dir = mkdtempSync(join(tmpdir(), "scout-flow-"));
  });

  after(async () => {
    await merchant.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function runner(driver: PlaywrightBrowserDriver, accounts: Record<string, string>): { runner: TaskRunner; vault: SessionVault; broker: OtpBroker; ledger: CheckoutLedger; verified: string[] } {
    const vault = new SessionVault(join(dir, "vault"), KEY, 24 * 60 * 60_000, Date.now);
    const broker = new OtpBroker(Date.now);
    const ledger = new CheckoutLedger(join(dir, "checkout.json"), Date.now);
    const verified: string[] = [];
    const skill = merchant.skill();
    return {
      vault,
      broker,
      ledger,
      verified,
      runner: new TaskRunner({
        driver,
        vault,
        broker,
        ledger,
        account: (userId) => (accounts[userId] ? { email: `${userId.slice(0, 4)}@example.com`, phone: accounts[userId] ?? null } : null),
        devices: () => ["pixel-8"],
        allow: (url) => url.startsWith(merchant.base),
        checkUrl: (url) => (url.startsWith(merchant.base) ? { ok: true, url } : { ok: false, error: "off fixture" }),
        now: Date.now,
        skills: (id) => (id === "blinkit" ? skill : null),
        onPhoneVerified: (userId) => verified.push(userId),
        stepTimeoutMs: 15_000,
      }),
    };
  }

  async function phoneApproves(run: TaskRunner, userId: string, taskId: string, phone: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const view = run.view(userId, taskId);
      const challenge = view?.events.findLast((event) => event.challenge)?.challenge;
      const sms = merchant.sms.findLast((item) => item.phone === phone);
      if (challenge && sms) {
        const sent = run.submitCode({ userId, deviceId: "pixel-8", manual: false, challengeId: challenge.challengeId, token: challenge.token, code: sms.code });
        assert.equal(sent.ok, true);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail("no verification challenge appeared");
  }

  function states(view: ScoutTaskView | null): string[] {
    return view?.events.map((event) => event.state) ?? [];
  }

  it("signs in with a relayed code, reuses the session after a restart, prepares a cart, waits for approval, hands off payment, and confirms", async () => {
    const driver = new PlaywrightBrowserDriver(15_000, { publicOnly: false });
    try {
      const first = runner(driver, { [ALICE]: "+919876543210" });
      const signIn = first.runner.signIn(ALICE, "blinkit");
      assert.equal(signIn.ok, true);
      if (!signIn.ok) return;
      await phoneApproves(first.runner, ALICE, signIn.task.id, "9876543210");
      const signedIn = await first.runner.settled(ALICE, signIn.task.id);
      assert.equal(signedIn?.state, "authenticated", JSON.stringify(signedIn?.events));
      assert.deepEqual(states(signedIn).filter((state) => state === "waiting_verification").length, 1);
      assert.equal(signedIn?.events.some((event) => event.challenge), false);
      assert.deepEqual(first.verified, [ALICE]);
      assert.equal(first.vault.list(ALICE)[0]?.state, "verified");
      assert.equal(first.runner.view(BOB, signIn.task.id), null);

      const second = runner(driver, { [ALICE]: "+919876543210" });
      const shop = second.runner.shop(ALICE, "blinkit", "amul taaza milk", 2);
      assert.equal(shop.ok, true);
      if (!shop.ok) return;
      const prepared = await second.runner.settled(ALICE, shop.task.id);
      assert.equal(prepared?.state, "approval_required", JSON.stringify(prepared?.events));
      assert.equal(states(prepared).includes("waiting_verification"), false);
      assert.match(prepared?.events.find((event) => event.state === "authenticated")?.message ?? "", /Reused/);
      const approval = prepared?.events.find((event) => event.approval)?.approval;
      assert.ok(approval);
      assert.deepEqual(approval.cart.lines, [{ title: "Amul Taaza Milk 500 ml", quantity: 2, rupees: 66 }]);
      assert.equal(approval.cart.totalRupees, 91);
      assert.equal(merchant.orderCount(), 0);

      assert.equal(second.runner.approve(BOB, approval.checkoutId, approval.fingerprint, "idem-bob-0001").ok, false);
      const checkout = second.runner.approve(ALICE, approval.checkoutId, approval.fingerprint, "idem-alice-0001");
      assert.equal(checkout.ok, true);
      if (!checkout.ok) return;
      const handed = await second.runner.settled(ALICE, checkout.task.id);
      assert.equal(handed?.state, "payment_handoff", JSON.stringify(handed?.events));
      const pay = handed?.events.find((event) => event.pay)?.pay;
      assert.match(pay?.url ?? "", /^upi:\/\/pay\?pa=fixture@upi/);
      assert.equal(merchant.autopayPressed, false);
      assert.equal(merchant.payClicks.length, 1);

      const again = second.runner.approve(ALICE, approval.checkoutId, approval.fingerprint, "idem-alice-0002");
      assert.equal(again.ok, true);
      if (again.ok) {
        const replay = await second.runner.settled(ALICE, again.task.id);
        assert.match(replay?.events.at(-1)?.message ?? "", /did not press pay again/);
      }
      assert.equal(merchant.payClicks.length, 1);

      const early = second.runner.confirm(ALICE, approval.checkoutId);
      assert.equal(early.ok, true);
      if (early.ok) assert.equal((await second.runner.settled(ALICE, early.task.id))?.state, "payment_handoff");

      merchant.markAllPaid();
      const confirm = second.runner.confirm(ALICE, approval.checkoutId);
      assert.equal(confirm.ok, true);
      if (!confirm.ok) return;
      const confirmed = await second.runner.settled(ALICE, confirm.task.id);
      assert.equal(confirmed?.state, "provider_confirmed", JSON.stringify(confirmed?.events));
      assert.match(confirmed?.events.at(-1)?.orderId ?? "", /^FX\d{6}$/);
    } finally {
      await driver.close();
    }
  });

  it("stops before paying when the price changes after approval", async () => {
    const driver = new PlaywrightBrowserDriver(15_000, { publicOnly: false });
    try {
      const run = runner(driver, { [ALICE]: "+919876543210" });
      const shop = run.runner.shop(ALICE, "blinkit", "harvest gold bread", 1);
      assert.equal(shop.ok, true);
      if (!shop.ok) return;
      const prepared = await run.runner.settled(ALICE, shop.task.id);
      const approval = prepared?.events.find((event) => event.approval)?.approval;
      assert.ok(approval, JSON.stringify(prepared?.events));
      merchant.setPrice("bread", 4500);
      const clicks = merchant.payClicks.length;
      const checkout = run.runner.approve(ALICE, approval.checkoutId, approval.fingerprint, "idem-alice-0003");
      assert.equal(checkout.ok, true);
      if (!checkout.ok) return;
      const stopped = await run.runner.settled(ALICE, checkout.task.id);
      assert.equal(stopped?.state, "failed");
      assert.match(stopped?.events.at(-1)?.message ?? "", /changed/);
      assert.equal(merchant.payClicks.length, clicks);
    } finally {
      merchant.setPrice("bread", 4000);
      await driver.close();
    }
  });

  it("runs two users at once with separate sessions, and asks again when the provider expired the session", async () => {
    const driver = new PlaywrightBrowserDriver(15_000, { publicOnly: false });
    try {
      const run = runner(driver, { [ALICE]: "+919876543210", [BOB]: "+919000000001" });
      merchant.expireSessions();
      const alice = run.runner.signIn(ALICE, "blinkit");
      const bob = run.runner.signIn(BOB, "blinkit");
      assert.equal(alice.ok && bob.ok, true);
      if (!alice.ok || !bob.ok) return;
      await Promise.all([
        phoneApproves(run.runner, ALICE, alice.task.id, "9876543210"),
        phoneApproves(run.runner, BOB, bob.task.id, "9000000001"),
      ]);
      const [aliceView, bobView] = await Promise.all([run.runner.settled(ALICE, alice.task.id), run.runner.settled(BOB, bob.task.id)]);
      assert.equal(aliceView?.state, "authenticated", JSON.stringify(aliceView?.events));
      assert.equal(bobView?.state, "authenticated", JSON.stringify(bobView?.events));
      assert.equal(states(aliceView).includes("waiting_verification"), true);
      const aliceSid = run.vault.load(ALICE, "127.0.0.1")?.cookies.find((cookie) => cookie.name === "sid")?.value;
      const bobSid = run.vault.load(BOB, "127.0.0.1")?.cookies.find((cookie) => cookie.name === "sid")?.value;
      assert.ok(aliceSid && bobSid);
      assert.notEqual(aliceSid, bobSid);
    } finally {
      await driver.close();
    }
  });

  it("drops a code sent after the task was cancelled", async () => {
    const driver = new PlaywrightBrowserDriver(15_000, { publicOnly: false });
    try {
      const run = runner(driver, { [ALICE]: "+919876543210" });
      merchant.expireSessions();
      const signIn = run.runner.signIn(ALICE, "blinkit");
      assert.equal(signIn.ok, true);
      if (!signIn.ok) return;
      let challenge: { challengeId: string; token: string } | undefined;
      for (let attempt = 0; attempt < 100 && !challenge; attempt += 1) {
        challenge = run.runner.view(ALICE, signIn.task.id)?.events.findLast((event) => event.challenge)?.challenge;
        if (!challenge) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(challenge);
      assert.equal(run.runner.cancel(ALICE, signIn.task.id), true);
      const code = merchant.sms.at(-1)?.code ?? "";
      assert.deepEqual(run.runner.submitCode({ userId: ALICE, deviceId: "pixel-8", manual: false, challengeId: challenge.challengeId, token: challenge.token, code }), { ok: false, reason: "cancelled" });
      const view = await run.runner.settled(ALICE, signIn.task.id);
      assert.equal(view?.state, "cancelled");
      assert.equal(view?.events.some((event) => event.challenge), false);
    } finally {
      await driver.close();
    }
  });
});
