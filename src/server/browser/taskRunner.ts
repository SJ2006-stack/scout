import { randomBytes } from "node:crypto";
import type { PayLink } from "../../shared/payLink.ts";
import { isTerminalState, type CartView, type ScoutTaskEvent, type ScoutTaskKind, type ScoutTaskState, type ScoutTaskView } from "../../shared/scoutTask.ts";
import type { CartReview, CheckoutLedger, CheckoutRecord } from "./checkoutLedger.ts";
import type { BrowserDriver, IsolatedPage } from "./driver.ts";
import { ChallengeClosed, type OtpBroker, type SubmitRejection } from "./otpBroker.ts";
import type { Egress } from "../relay/phoneEgress.ts";
import type { SessionVault } from "./sessionVault.ts";
import { payFromPage } from "./shelf.ts";
import type { AccountLogin } from "./signIn.ts";
import { addToCart, checkoutControl, checkStage, confirmationId, ensureLocation, key, openCart, pickProduct, press, readCart, readPage, signInWithSkill, type Step } from "./siteFlows.ts";
import { skillById, type WebsiteSkill } from "./skills.ts";

export type RunnerOptions = {
  /** The proxy for a user's store pages, such as their phone relay. */
  egress?: Egress;
  driver: BrowserDriver;
  vault: SessionVault | null;
  broker: OtpBroker;
  ledger: CheckoutLedger;
  account: (userId: string) => AccountLogin | null;
  devices: (userId: string) => string[];
  allow: (url: string) => boolean;
  checkUrl: (url: string) => { ok: true; url: string } | { ok: false; error: string };
  now: () => number;
  skills?: (id: string) => WebsiteSkill | null;
  notify?: (userId: string, title: string, body: string) => void;
  onPhoneVerified?: (userId: string) => void;
  stepTimeoutMs?: number;
  maxTasks?: number;
  maxTasksPerUser?: number;
};

type Task = {
  id: string;
  userId: string;
  kind: ScoutTaskKind;
  skill: string;
  state: ScoutTaskState;
  events: ScoutTaskEvent[];
  controller: AbortController;
  createdAt: number;
  updatedAt: number;
  done: Promise<void>;
};

type Held = { userId: string; page: IsolatedPage; expiresAt: number };

/** Where a shop task delivers. The area is typed into the store's location box. */
export type DeliveryPoint = { area?: string | null; geolocation?: { latitude: number; longitude: number } };

export type StartResult = { ok: true; task: ScoutTaskView } | { ok: false; status: number; error: string };

const HELD_MS = 10 * 60_000;
const EVENT_LIMIT = 60;
const RESULT_POLLS = 8;
const RESULT_POLL_MS = 800;

/**
 * Runs website skills for one user in an isolated browser context: sign in
 * with an authorised code, reuse the saved session, search, build a cart,
 * wait for approval, start payment, and check the provider's confirmation.
 */
export class TaskRunner {
  private readonly tasks = new Map<string, Task>();
  private readonly held = new Map<string, Held>();
  private readonly options: RunnerOptions;

  constructor(options: RunnerOptions) {
    this.options = options;
  }

  signIn(userId: string, skillId: string): StartResult {
    return this.start(userId, "sign_in", skillId, (task, skill) => this.runSignIn(task, skill));
  }

  shop(userId: string, skillId: string, query: string, quantity: number, where: DeliveryPoint = {}): StartResult {
    const text = query.trim().slice(0, 80);
    if (text.length < 2) return { ok: false, status: 400, error: "Name the item to buy." };
    const count = Math.min(10, Math.max(1, Math.floor(quantity)));
    return this.start(userId, "shop", skillId, (task, skill) => this.runShop(task, skill, text, count, where));
  }

  approve(userId: string, checkoutId: string, fingerprint: string, idempotencyKey: string): StartResult {
    const existing = this.options.ledger.get(userId, checkoutId);
    if (existing && existing.fingerprint === fingerprint && (existing.state === "initiating" || existing.state === "handoff" || existing.state === "confirmed")) {
      return this.start(userId, "checkout", existing.review.skill, async (task) => this.replay(task, existing));
    }
    const approved = this.options.ledger.approve(userId, checkoutId, fingerprint);
    if (!approved.ok) {
      const errors = { missing: "That checkout was not found.", owner: "That checkout was not found.", expired: "The approval window closed. Prepare the cart again.", mismatch: "The cart you approved is not the one Scout prepared.", closed: "That checkout is already finished." } as const;
      return { ok: false, status: approved.reason === "missing" || approved.reason === "owner" ? 404 : 409, error: errors[approved.reason] };
    }
    return this.start(userId, "checkout", approved.record.review.skill, (task, skill) => this.runCheckout(task, skill, approved.record, idempotencyKey));
  }

  confirm(userId: string, checkoutId: string): StartResult {
    const record = this.options.ledger.get(userId, checkoutId);
    if (!record) return { ok: false, status: 404, error: "That checkout was not found." };
    return this.start(userId, "confirm", record.review.skill, (task, skill) => this.runConfirm(task, skill, record));
  }

  cancel(userId: string, taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.userId !== userId) return false;
    this.options.broker.cancelTask(taskId);
    task.controller.abort();
    if (!isTerminalState(task.state) || task.state === "approval_required") this.emit(task, "cancelled", "Task cancelled.");
    return true;
  }

  view(userId: string, taskId: string): ScoutTaskView | null {
    const task = this.tasks.get(taskId);
    if (!task || task.userId !== userId) return null;
    return this.toView(task);
  }

  submitCode(input: { userId: string; deviceId: string | null; manual: boolean; challengeId: string; token: string; code: string }): { ok: true } | { ok: false; reason: SubmitRejection } {
    const result = this.options.broker.submit(input);
    return result.ok ? { ok: true } : result;
  }

  hasChallenge(challengeId: string): boolean {
    return this.options.broker.get(challengeId) != null;
  }

  /** The user's single open challenge, for a code that reached the web app without its ticket. */
  openChallenge(userId: string): string | null {
    return this.options.broker.openFor(userId)?.challengeId ?? null;
  }

  /** A code the signed-in user approved in their own Scout session, bound to their open challenge. */
  submitOwnCode(userId: string, challengeId: string, code: string): { ok: true } | { ok: false; reason: SubmitRejection } {
    const task = [...this.tasks.values()].find((item) => item.userId === userId && item.events.some((event) => event.challenge?.challengeId === challengeId));
    const token = task?.events.findLast((event) => event.challenge?.challengeId === challengeId)?.challenge?.token;
    if (!token) return { ok: false, reason: "unknown" };
    return this.submitCode({ userId, deviceId: null, manual: true, challengeId, token, code });
  }

  /** Waits for the task to reach a state that needs nothing more from the runner. */
  async settled(userId: string, taskId: string): Promise<ScoutTaskView | null> {
    const task = this.tasks.get(taskId);
    if (!task || task.userId !== userId) return null;
    await task.done;
    return this.toView(task);
  }

  async close(): Promise<void> {
    for (const task of this.tasks.values()) task.controller.abort();
    for (const held of this.held.values()) await held.page.close();
    this.held.clear();
  }

  private start(userId: string, kind: ScoutTaskKind, skillId: string, run: (task: Task, skill: WebsiteSkill) => Promise<void>): StartResult {
    this.sweep();
    const skill = (this.options.skills ?? skillById)(skillId);
    if (!skill) return { ok: false, status: 400, error: "Scout has no skill for that site." };
    const active = [...this.tasks.values()].filter((task) => !isTerminalState(task.state));
    if (active.length >= (this.options.maxTasks ?? 3)) return { ok: false, status: 429, error: "Scout is busy with other tasks. Try again in a minute." };
    if (active.filter((task) => task.userId === userId).length >= (this.options.maxTasksPerUser ?? 2)) {
      return { ok: false, status: 429, error: "Finish or cancel your running task first." };
    }
    const now = this.options.now();
    const task: Task = { id: randomBytes(16).toString("hex"), userId, kind, skill: skill.id, state: "connecting", events: [], controller: new AbortController(), createdAt: now, updatedAt: now, done: Promise.resolve() };
    this.tasks.set(task.id, task);
    this.emit(task, "connecting", `Connecting to ${skill.name}.`);
    task.done = run(task, skill).catch((error: unknown) => {
      if (task.controller.signal.aborted) {
        if (task.state !== "cancelled") this.emit(task, "cancelled", "Task cancelled.");
        return;
      }
      this.emit(task, "failed", failureText(error, skill));
    }).finally(() => this.options.broker.cancelTask(task.id));
    return { ok: true, task: this.toView(task) };
  }

  private async runSignIn(task: Task, skill: WebsiteSkill): Promise<void> {
    const page = await this.openPage(task, skill);
    try {
      await this.authenticate(task, skill, page);
    } finally {
      await page.close();
    }
  }

  private async runShop(task: Task, skill: WebsiteSkill, query: string, quantity: number, where: DeliveryPoint): Promise<void> {
    if (skill.kind !== "shop") throw new Failure(`${skill.name} is not a shop.`);
    const page = await this.openPage(task, skill, where.geolocation);
    let keep = false;
    try {
      if (!(await this.authenticate(task, skill, page, where.area ?? null))) return;
      const step = this.stepper(task);
      this.emit(task, "searching", `Searching ${skill.name} for ${query}.`);
      await step((signal) => page.goto(this.checked(skill.search.url(query)), signal));
      let read = await readPage(page, step);
      for (let attempt = 0; attempt < RESULT_POLLS && !pickProduct(read.elements, query); attempt += 1) {
        await pause(RESULT_POLL_MS, task.controller.signal);
        read = await readPage(page, step);
      }
      if (!(await ensureLocation(page, skill, step, where.area ?? null))) {
        this.emit(task, "needs_user", `${skill.name} needs a delivery area. Tell Scout your area or pincode and try again.`);
        return;
      }
      const searched = await checkStage(page, skill, "search", step);
      if (!searched.check.ok) return this.stopFor(task, searched.check);
      this.emit(task, "comparing", "Comparing the results.");
      const product = pickProduct(searched.read.elements, query);
      if (!product) throw new Failure(`${skill.name} showed no priced match for ${query}.`);
      if (!(await addToCart(page, skill, product, quantity, step))) throw new Failure(`${skill.name} would not add ${product.title} to the cart.`);
      const cart = await openCart(page, skill, step);
      if (!cart.ok) return this.stopFor(task, cart);
      let review = readCart(skill, await readPage(page, step));
      for (let attempt = 0; attempt < RESULT_POLLS && !review; attempt += 1) {
        await pause(RESULT_POLL_MS, task.controller.signal);
        review = readCart(skill, await readPage(page, step));
      }
      if (!review) throw new Failure(`${skill.name} did not show a payable total. It may need you signed in first.`);
      this.emit(task, "cart_prepared", `Cart prepared on ${skill.name}.`);
      const record = this.options.ledger.propose(task.userId, review);
      this.held.set(record.id, { userId: task.userId, page, expiresAt: this.options.now() + HELD_MS });
      keep = true;
      this.emit(task, "approval_required", `Check the cart and approve ₹${rupees(review.totalPaise)} to continue.`, {
        approval: { checkoutId: record.id, fingerprint: record.fingerprint, cart: cartView(review), expiresAt: record.expiresAt },
      });
    } finally {
      if (!keep) await page.close();
    }
  }

  private async runCheckout(task: Task, skill: WebsiteSkill, approved: CheckoutRecord, idempotencyKey: string): Promise<void> {
    const ledger = this.options.ledger;
    const earlier = ledger.get(task.userId, approved.id);
    if (earlier && (earlier.state === "initiating" || earlier.state === "handoff" || earlier.state === "confirmed")) {
      this.replay(task, earlier);
      return;
    }
    const held = this.held.get(approved.id);
    this.held.delete(approved.id);
    const page = held && held.userId === task.userId ? held.page : await this.openPage(task, skill);
    try {
      const step = this.stepper(task);
      this.emit(task, "opening", "Checking the cart again before paying.");
      const cart = await openCart(page, skill, step);
      if (!cart.ok) return this.stopFor(task, cart);
      const current = readCart(skill, await readPage(page, step));
      if (!current) throw new Failure(`Scout could not read the ${skill.name} cart total.`);
      const started = ledger.beginInitiation(task.userId, approved.id, idempotencyKey, current);
      if (started.action === "replay") {
        this.replay(task, started.record);
        return;
      }
      if (started.action === "reject") {
        const text = started.reason === "changed" ? started.record?.note ?? "The cart changed after approval." : "That checkout cannot continue. Prepare the cart again.";
        this.emit(task, "failed", text);
        return;
      }
      const pay = await this.pressThrough(task, skill, page, approved, step);
      if (!pay.ok) {
        ledger.fail(approved.id, pay.detail);
        this.emit(task, pay.userTurn ? "needs_user" : "failed", pay.detail);
        return;
      }
      const record = ledger.recordHandoff(approved.id, pay.link);
      this.emit(task, "payment_handoff", pay.link
        ? `${skill.name} is ready for payment. Approve ₹${rupees(approved.review.totalPaise)} in your UPI app.`
        : `${skill.name} opened its payment page. Finish the payment there.`, pay.link ? { pay: pay.link } : {});
      if (record) this.options.notify?.(task.userId, "Payment ready", `Approve ₹${rupees(approved.review.totalPaise)} for ${skill.name} in your UPI app.`);
    } finally {
      await page.close();
    }
  }

  private async runConfirm(task: Task, skill: WebsiteSkill, record: CheckoutRecord): Promise<void> {
    if (record.state === "confirmed") {
      this.emit(task, "provider_confirmed", `${skill.name} confirmed the order.`, { orderId: record.confirmation?.orderId ?? null });
      return;
    }
    if (record.state === "timed_out") throw new Failure(record.note ?? "The payment window closed.");
    if (record.state !== "handoff") throw new Failure("That checkout has not reached payment.");
    const page = await this.openPage(task, skill);
    try {
      const step = this.stepper(task);
      this.emit(task, "opening", `Opening your ${skill.name} orders.`);
      await step((signal) => page.goto(this.checked(skill.success.ordersUrl ?? record.review.pageUrl), signal));
      const shown = await checkStage(page, skill, "confirmed", step);
      if (!shown.check.ok) {
        this.emit(task, "payment_handoff", `${skill.name} has not confirmed the order yet.`);
        return;
      }
      const orderId = confirmationId(skill, shown.read);
      this.options.ledger.confirm(record.id, orderId);
      this.emit(task, "provider_confirmed", orderId ? `${skill.name} confirmed order ${orderId}.` : `${skill.name} confirmed the order.`, { orderId });
    } finally {
      await page.close();
    }
  }

  /** Signs in or reuses a verified saved session. Returns false when the user has to act. */
  private async authenticate(task: Task, skill: WebsiteSkill, page: IsolatedPage, area: string | null = null): Promise<boolean> {
    const step = this.stepper(task);
    this.emit(task, "opening", `Opening ${skill.name}.`);
    await step((signal) => page.goto(this.checked(skill.home), signal));
    const home = await checkStage(page, skill, "signed_in", step);
    const domain = skill.domains[0] ?? "";
    if (home.check.ok) {
      this.options.vault?.markValidated(task.userId, domain);
      this.emit(task, "authenticated", `Reused your saved ${skill.name} sign-in.`);
      return true;
    }
    if (!home.check.ok && (home.check.reason === "captcha" || home.check.reason === "blocked")) {
      this.stopFor(task, home.check);
      return false;
    }
    const account = this.options.account(task.userId);
    if (!account) throw new Failure("Finish Scout sign-in first.");
    if (skill.kind === "shop") await ensureLocation(page, skill, step, area);
    this.emit(task, "signing_in", `Signing in to ${skill.name}.`);
    let usedChannel: "sms" | "email" | null = null;
    const outcome = await signInWithSkill(page, skill, account, step, async (channel) => {
      usedChannel = channel;
      const ticket = this.options.broker.open({ userId: task.userId, sessionId: task.id, taskId: task.id, domain, channel }, this.options.devices(task.userId));
      this.emit(task, "waiting_verification", channel === "sms"
        ? `${skill.name} sent a code to your phone. Approve it in the Scout app, or type it here.`
        : `${skill.name} sent a code to your email. Type it here.`, {
        challenge: { challengeId: ticket.challengeId, token: ticket.token, channel, expiresAt: ticket.expiresAt },
      });
      this.options.notify?.(task.userId, "Verification code", `${skill.name} sent a sign-in code. Open Scout to approve it.`);
      const code = await this.options.broker.wait(ticket.challengeId, task.controller.signal);
      this.emit(task, "signing_in", "Code received. Verifying.");
      return code;
    });
    if (outcome.kind === "needs_user") {
      this.emit(task, "needs_user", outcome.detail);
      return false;
    }
    if (outcome.kind === "failed") throw new Failure(outcome.detail);
    const state = await step((signal) => page.storageState(signal));
    this.options.vault?.save(task.userId, domain, state, true);
    if (usedChannel === "sms") this.options.onPhoneVerified?.(task.userId);
    this.emit(task, "authenticated", `Signed in to ${skill.name}.`);
    return true;
  }

  private async pressThrough(task: Task, skill: WebsiteSkill, page: IsolatedPage, approved: CheckoutRecord, step: Step): Promise<{ ok: true; link: PayLink | null } | { ok: false; detail: string; userTurn: boolean }> {
    const pressed = new Set<string>();
    for (let round = 0; round < 8; round += 1) {
      const read = await readPage(page, step);
      if (skill.failure.captcha.test(read.text)) return { ok: false, detail: `${skill.name} is showing a CAPTCHA. Finish on the site.`, userTurn: true };
      const signIn = read.elements.some((element) => (element.role === "textbox" || element.role === "combobox") && (skill.login.phoneField.test(element.name) || skill.login.codeField.test(element.name)));
      if (signIn && !(await this.authenticateHere(task, skill, page, step))) return { ok: false, detail: `${skill.name} needs you to sign in.`, userTurn: true };
      if (signIn) continue;
      const control = checkoutControl(skill, read.elements, pressed);
      if (!control) {
        const forbidden = read.elements.some((element) => skill.checkout.forbidden.test(element.name));
        return { ok: false, detail: forbidden ? `${skill.name} wants an autopay or saved-card step. Finish that yourself.` : `${skill.name} showed no payment button.`, userTurn: forbidden };
      }
      if (control.pays) {
        const shown = readCart(skill, read);
        if (shown && shown.totalPaise !== approved.review.totalPaise) {
          return { ok: false, detail: `The total changed to ₹${rupees(shown.totalPaise)} after you approved ₹${rupees(approved.review.totalPaise)}. Nothing was paid.`, userTurn: false };
        }
      }
      pressed.add(key(control.element));
      await press(page, read.elements, control.element, step);
      if (!control.pays) continue;
      const amount = `₹${rupees(approved.review.totalPaise)}`;
      const link = await payFromPage(page, skill.name, approved.review.lines.map((line) => line.title).join(", ").slice(0, 120), amount, step);
      return { ok: true, link };
    }
    return { ok: false, detail: `${skill.name} checkout took too many steps.`, userTurn: false };
  }

  private async authenticateHere(task: Task, skill: WebsiteSkill, page: IsolatedPage, step: Step): Promise<boolean> {
    const account = this.options.account(task.userId);
    if (!account) return false;
    const domain = skill.domains[0] ?? "";
    const outcome = await signInWithSkill(page, skill, account, step, async (channel) => {
      const ticket = this.options.broker.open({ userId: task.userId, sessionId: task.id, taskId: task.id, domain, channel }, this.options.devices(task.userId));
      this.emit(task, "waiting_verification", `${skill.name} sent a code. Approve it in the Scout app, or type it here.`, {
        challenge: { challengeId: ticket.challengeId, token: ticket.token, channel, expiresAt: ticket.expiresAt },
      });
      return this.options.broker.wait(ticket.challengeId, task.controller.signal);
    });
    if (outcome.kind !== "signed_in") return false;
    this.options.vault?.save(task.userId, domain, await step((signal) => page.storageState(signal)), true);
    return true;
  }

  private replay(task: Task, record: CheckoutRecord): void {
    const skillName = record.review.merchant;
    if (record.state === "confirmed") {
      this.emit(task, "provider_confirmed", `${skillName} already confirmed this order.`, { orderId: record.confirmation?.orderId ?? null });
      return;
    }
    const pay = record.handoff?.pay ?? null;
    this.emit(task, "payment_handoff", `Payment for this cart was already started. Scout did not press pay again.`, pay ? { pay } : {});
  }

  private async openPage(task: Task, skill: WebsiteSkill, geolocation?: DeliveryPoint["geolocation"]): Promise<IsolatedPage> {
    this.emit(task, "opening", `Opening ${skill.name}.`);
    const saved = this.options.vault?.loadFor(task.userId, skill.domains) ?? null;
    const proxy = await this.options.egress?.(task.userId);
    return this.options.driver.openIsolated({ allow: this.options.allow, headed: false, lean: true, storageState: saved ?? undefined, geolocation, ...(proxy ? { proxy } : {}) });
  }

  private stepper(task: Task): Step {
    const limit = this.options.stepTimeoutMs ?? 30_000;
    return (run) => {
      if (task.controller.signal.aborted) return Promise.reject(new Failure("Task cancelled."));
      const timeout = AbortSignal.timeout(limit);
      const signal = AbortSignal.any([timeout, task.controller.signal]);
      return run(signal);
    };
  }

  private checked(url: string): string {
    const result = this.options.checkUrl(url);
    if (!result.ok) throw new Failure(result.error);
    return result.url;
  }

  private stopFor(task: Task, check: { ok: false; reason: string; detail: string }): void {
    const userTurn = check.reason === "captcha" || check.reason === "location";
    this.emit(task, userTurn ? "needs_user" : "failed", check.detail);
  }

  private emit(task: Task, state: ScoutTaskState, message: string, extra: Partial<ScoutTaskEvent> = {}): void {
    const at = this.options.now();
    task.state = state;
    task.updatedAt = at;
    if (state !== "waiting_verification") for (const event of task.events) delete event.challenge;
    task.events.push({ state, at, message, ...extra });
    if (task.events.length > EVENT_LIMIT) task.events.splice(0, task.events.length - EVENT_LIMIT);
  }

  private toView(task: Task): ScoutTaskView {
    return {
      id: task.id,
      kind: task.kind,
      skill: task.skill,
      state: task.state,
      events: task.events.map((event) => ({ ...event })),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  private sweep(): void {
    const now = this.options.now();
    for (const [id, held] of this.held) {
      if (now < held.expiresAt) continue;
      this.held.delete(id);
      void held.page.close();
    }
    for (const [id, task] of this.tasks) {
      if (isTerminalState(task.state) && now - task.updatedAt > 60 * 60_000) this.tasks.delete(id);
    }
  }
}

class Failure extends Error {}

function failureText(error: unknown, skill: WebsiteSkill): string {
  if (error instanceof ChallengeClosed) return error.message;
  if (error instanceof Failure) return error.message;
  if (error instanceof Error && /timed? ?out|timeout/i.test(error.message)) return `${skill.name} took too long to respond.`;
  return `${skill.name} could not be completed.`;
}

function cartView(review: CartReview): CartView {
  return {
    merchant: review.merchant,
    lines: review.lines.map((line) => ({ title: line.title, quantity: line.quantity, rupees: line.paise / 100 })),
    fees: review.fees.map((fee) => ({ label: fee.label, rupees: fee.paise / 100 })),
    totalRupees: review.totalPaise / 100,
  };
}

function rupees(paise: number): string {
  return (paise / 100).toFixed(paise % 100 === 0 ? 0 : 2);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Failure("Task cancelled."));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Failure("Task cancelled."));
    }, { once: true });
  });
}
