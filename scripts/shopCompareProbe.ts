// Live check: compares one item on Blinkit, Zepto, and Instamart with the production code path.
// node --experimental-strip-types scripts/shopCompareProbe.ts "dairy milk"
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaywrightBrowserDriver } from "../src/server/browser/playwrightDriver.ts";
import { BrowserStore } from "../src/server/browser/store.ts";
import { BrowserWorker } from "../src/server/browser/worker.ts";
const dir = mkdtempSync(join(tmpdir(), "cmp-"));
const worker = new BrowserWorker({ driver: new PlaywrightBrowserDriver(30_000), store: new BrowserStore(join(dir, "s.json")), vault: null, canShowWindow: false, operationTimeoutMs: 30_000, sessionTtlMs: 60_000, maxSessions: 4, allowedHosts: null, now: Date.now });
for (const q of [process.argv[2] ?? "chocolate"]) {
  const t = Date.now();
  const shop = await worker.compareShop(q, undefined, undefined, (m) => console.log(`  [${Date.now() - t}ms] ${m}`));
  console.log(q, Date.now() - t, "ms", shop.summary);
  for (const m of ["Blinkit", "Zepto", "Instamart"]) console.log(" ", m, shop.offers.filter((o) => o.merchant === m).slice(0, 3).map((o) => `${o.title} ₹${o.rupees}`));
}
await worker.stop();
