import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoreBill } from "../shared/cartQuote.ts";
import { isShopApp } from "../shared/deviceActions.ts";

const KEEP_PER_STORE = 20;

/** Bills the phone read in Blinkit, Zepto, and Instamart carts, per user, for the fee estimates. */
export class CartBillStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 3000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cart_bills (
      user_id TEXT NOT NULL,
      store TEXT NOT NULL,
      items_total REAL,
      handling REAL,
      delivery REAL,
      other_fees REAL,
      grand_total REAL,
      elapsed_ms INTEGER,
      at INTEGER NOT NULL
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS cart_bills_user ON cart_bills (user_id, store, at)");
    const columns = this.db.prepare("PRAGMA table_info(cart_bills)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "lines")) this.db.exec("ALTER TABLE cart_bills ADD COLUMN lines INTEGER");
  }

  add(userId: string, bill: StoreBill): void {
    this.db.prepare(
      "INSERT INTO cart_bills (user_id, store, items_total, handling, delivery, other_fees, grand_total, elapsed_ms, lines, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(userId, bill.store, bill.itemsTotal, bill.handling, bill.delivery, bill.otherFees, bill.grandTotal, bill.elapsedMs, bill.lines, bill.at);
    this.db.prepare(
      "DELETE FROM cart_bills WHERE user_id = ? AND store = ? AND at NOT IN (SELECT at FROM cart_bills WHERE user_id = ? AND store = ? ORDER BY at DESC LIMIT ?)",
    ).run(userId, bill.store, userId, bill.store, KEEP_PER_STORE);
  }

  /** Oldest first, so the latest runs come last. */
  recent(userId: string): StoreBill[] {
    const rows = this.db.prepare(
      "SELECT store, items_total, handling, delivery, other_fees, grand_total, elapsed_ms, lines, at FROM cart_bills WHERE user_id = ? ORDER BY at ASC",
    ).all(userId) as { store: string; items_total: number | null; handling: number | null; delivery: number | null; other_fees: number | null; grand_total: number | null; elapsed_ms: number | null; lines: number | null; at: number }[];
    const bills: StoreBill[] = [];
    for (const row of rows) {
      if (!isShopApp(row.store)) continue;
      bills.push({
        store: row.store,
        itemsTotal: row.items_total,
        handling: row.handling,
        delivery: row.delivery,
        otherFees: row.other_fees,
        grandTotal: row.grand_total,
        elapsedMs: row.elapsed_ms,
        lines: row.lines,
        at: row.at,
      });
    }
    return bills;
  }
}
