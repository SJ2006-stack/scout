import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PhoneRun } from "../src/shared/phoneRun.ts";
import {
  CHECKOUT_CHOICES,
  SEAT_HOLD_MS,
  browserCartUrl,
  groupPayReady,
  nativeCheckoutMove,
  nextPayStatus,
  phoneRunsFromTurns,
  readPayMarks,
  syncPayMarks,
  visiblePayRows,
} from "../src/shared/payReady.ts";

const NOW = 1_700_000_000_000;
const BLINKIT_A = "a".repeat(24);
const BLINKIT_B = "b".repeat(24);
const ZEPTO = "c".repeat(24);
const SHOW = "d".repeat(24);

describe("pay ready tray", () => {
  it("groups several finished adds in one store onto one cart", () => {
    const rows = groupPayReady([
      cart(BLINKIT_A, "blinkit", "Butter", 1, 80),
      cart(ZEPTO, "zepto", "Milk", 2, 70),
      cart(BLINKIT_B, "blinkit", "Bread", 1, 165),
      cart("e".repeat(24), "blinkit", "Eggs", 1, 40, "sent"),
    ], NOW);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.app, "blinkit");
    assert.deepEqual(rows[0]?.lines, ["1 × Butter", "1 × Bread"]);
    assert.equal(rows[0]?.total, 165);
    assert.equal(rows[0]?.taskId, BLINKIT_B);
    assert.equal(rows[0]?.kind, "cart");
    assert.equal(rows[0]?.holdExpiresAt, null);
    assert.equal(rows[0]?.status, "ready");
    assert.equal(rows[1]?.app, "zepto");
    assert.equal(rows[1]?.summary, "2 × Milk");
  });

  it("starts a seat-hold countdown for a booking and expires it", () => {
    const [row] = groupPayReady([booking(SHOW)], NOW);
    assert.ok(row);
    assert.equal(row.kind, "booking");
    assert.deepEqual(row.lines, ["2 tickets", "A1, A2"]);
    assert.equal(row.holdExpiresAt, NOW + SEAT_HOLD_MS);
    assert.equal(row.status, "ready");
    const opened = { ...row, status: nextPayStatus(row.status, "open", row.holdExpiresAt, NOW) };
    assert.equal(opened.status, "opened");
    const later = groupPayReady([booking(SHOW)], NOW + SEAT_HOLD_MS, [{ taskId: SHOW, readyAt: NOW, status: "opened" }]);
    assert.equal(later[0]?.status, "expired");
    assert.equal(later[0]?.readyAt, NOW);
    const paid = nextPayStatus("paid", "tick", row.holdExpiresAt, NOW + SEAT_HOLD_MS);
    assert.equal(paid, "paid");
    assert.equal(nextPayStatus("failed", "paid", null, NOW), "failed");
    assert.equal(nextPayStatus("opened", "paid", null, NOW), "paid");
    assert.equal(visiblePayRows([{ ...row, status: "paid" }]).length, 0);
  });

  it("keeps a paid mark when the chat reloads", () => {
    const runs = [cart(BLINKIT_A, "blinkit", "Butter", 1, 80)];
    const marks = syncPayMarks(runs, NOW, [{ taskId: BLINKIT_A, readyAt: NOW, status: "paid" }]);
    assert.equal(marks[0]?.status, "paid");
    assert.equal(visiblePayRows(groupPayReady(runs, NOW + 5_000, marks)).length, 0);
    assert.equal(readPayMarks("not json").length, 0);
    assert.equal(readPayMarks(JSON.stringify([{ taskId: BLINKIT_A, readyAt: NOW, status: "opened" }]))[0]?.status, "opened");
  });

  it("reads phone runs out of chat turns", () => {
    const run = cart(BLINKIT_A, "blinkit", "Butter", 1, 80);
    const found = phoneRunsFromTurns([{ kind: "note" }, { kind: "phone", run }, { kind: "phone", run: { id: "nope" } }]);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.id, BLINKIT_A);
  });

  it("picks a confirmed cart link per app", () => {
    assert.equal(browserCartUrl("blinkit"), "https://blinkit.com/cart");
    assert.equal(browserCartUrl("blinkit")?.includes("www.blinkit.com"), false);
    assert.equal(nativeCheckoutMove("blinkit", true, false), "launch");
    assert.equal(nativeCheckoutMove("blinkit", true, true), "resume");
    assert.equal(browserCartUrl("zepto"), "https://www.zepto.com/cart");
    assert.equal(nativeCheckoutMove("zepto", true, false), "cart");
    assert.equal(browserCartUrl("instamart"), "https://www.swiggy.com/instamart/cart");
    assert.equal(nativeCheckoutMove("instamart", true, false), "launch");
    assert.equal(nativeCheckoutMove("instamart", true, true), "resume");
    assert.equal(CHECKOUT_CHOICES.find((choice) => choice.app === "instamart")?.nativeCartUrl, null);
    assert.equal(browserCartUrl("flipkart"), "https://www.flipkart.com/viewcart");
    assert.equal(nativeCheckoutMove("flipkart", true, false), "cart");
    assert.equal(browserCartUrl("amazon"), "https://www.amazon.in/gp/cart/view.html");
    assert.equal(nativeCheckoutMove("amazon", false, false), "app_missing");
    assert.equal(nativeCheckoutMove("bookmyshow", true, true), "resume");
    assert.equal(nativeCheckoutMove("district", true, false), "launch");
    assert.equal(nativeCheckoutMove("luma", true, false), "launch");
    assert.equal(browserCartUrl("bookmyshow", "https://in.bookmyshow.com/movies/x"), "https://in.bookmyshow.com/movies/x");
    assert.equal(nativeCheckoutMove("chrome", true, true), "unknown");
    assert.equal(CHECKOUT_CHOICES.find((choice) => choice.app === "blinkit")?.hostClaimed, true);
    assert.equal(CHECKOUT_CHOICES.find((choice) => choice.app === "zepto")?.hostClaimed, true);
    assert.equal(CHECKOUT_CHOICES.find((choice) => choice.app === "instamart")?.hostClaimed, false);
  });
});

function cart(id: string, app: "blinkit" | "zepto" | "instamart", name: string, quantity: number, grand: number | null, status: PhoneRun["status"] = "completed"): PhoneRun {
  const link = app === "blinkit" ? "https://blinkit.com/prn/x/prid/1" : app === "zepto" ? "https://www.zepto.com/pn/x" : "https://www.swiggy.com/instamart/p/x";
  return {
    id,
    action: "app_cart_add",
    app,
    summary: name,
    link,
    status,
    message: "",
    cart: {
      store: app,
      added: [{ name, size: null, quantity, unitPrice: null, lineTotal: grand }],
      cart: { itemsTotal: grand, handling: null, delivery: null, otherFees: null, grandTotal: grand },
      elapsedMs: null,
      stoppedAt: null,
      reason: null,
      seen: null,
    },
    event: null,
  };
}

function booking(id: string): PhoneRun {
  return {
    id,
    action: "app_event_book",
    app: "bookmyshow",
    summary: "Two seats",
    link: "https://in.bookmyshow.com/movies/x",
    status: "completed",
    message: "",
    cart: null,
    event: { app: "bookmyshow", tickets: 2, showtime: NOW, seats: ["A1", "A2"], total: 500, stoppedAt: null, reason: null },
  };
}
