// Live check: search, set the delivery area, add one item, open the cart, read the bill. Stops before sign-in.
// node --experimental-strip-types scripts/shopCartProbe.ts blinkit "dairy milk" "Koramangala"   (HEADED=1 shows Chrome)
import { mkdirSync, writeFileSync } from "node:fs";
import { PlaywrightBrowserDriver } from "../src/server/browser/playwrightDriver.ts";
import { ensureLocation, addToCart, checkoutControl, openCart, pickProduct, readCart, readPage } from "../src/server/browser/siteFlows.ts";
import { SKILLS, validateStage } from "../src/server/browser/skills.ts";
const id = (process.argv[2] ?? "blinkit") as keyof typeof SKILLS;
const query = process.argv[3] ?? "dairy milk";
const skill = SKILLS[id];
mkdirSync("/tmp/scoutprobe", { recursive: true });
const driver = new PlaywrightBrowserDriver(30_000);
const page = await driver.openIsolated({ allow: (u) => u.startsWith("https://") || u.startsWith("wss://"), headed: process.env.HEADED === "1", lean: process.env.HEADED !== "1", geolocation: { latitude: 12.9352, longitude: 77.6245 } });
const step = <T>(run: (s: AbortSignal) => Promise<T>) => run(AbortSignal.timeout(25000));
const shot = async (n: string) => writeFileSync(`/tmp/scoutprobe/${id}-${n}.png`, await page.screenshot(AbortSignal.timeout(10000)));
const t = Date.now();
const log = (m: string) => console.log(`[${Date.now() - t}ms] ${m}`);
try {
  await step((s) => page.goto(skill.search.url(query), s));
  let read = await readPage(page, step);
  for (let i = 0; i < 8 && !pickProduct(read.elements, query); i++) { await new Promise((r) => setTimeout(r, 1000)); read = await readPage(page, step); }
  log(`location set ${await ensureLocation(page, skill, step, process.argv[4] ?? "Koramangala")}`);
  await shot("0-located");
  read = await readPage(page, step);
  log(`search stage ${JSON.stringify(validateStage(skill, "search", read))}`);
  const product = pickProduct(read.elements, query);
  log(`picked ${JSON.stringify(product)}`);
  const near = product ? read.elements.slice(product.index, product.index + 6).map((e) => `${e.role}:${e.name.slice(0, 30)}`) : [];
  log(`after product: ${near.join(" | ")}`);
  await shot("1-search");
  if (product) {
    const added = await addToCart(page, skill, product, 1, step);
    log(`added ${added}`);
    await new Promise((r) => setTimeout(r, 1500));
    await shot("2-added");
    const after = await readPage(page, step);
    log(`buttons now: ${after.elements.filter((e) => e.role === "button").slice(0, 15).map((e) => e.name.slice(0, 25)).join(" | ")}`);
    log(`cart-ish: ${JSON.stringify(after.elements.filter((e) => /item|cart/i.test(e.name)).slice(0, 6))}`);
    const cart = await openCart(page, skill, step);
    await new Promise((r) => setTimeout(r, 1500));
    await shot("3-cart");
    log(`cart stage ${JSON.stringify(cart)}`);
    for (let i = 0; i < 2; i++) {
      const e = await page.elements(AbortSignal.timeout(10000));
      if (!e.some((x) => x.name === "Try Again")) break;
      await page.click({ role: "button", name: "Try Again", nth: 0 }, AbortSignal.timeout(10000));
      await new Promise((r) => setTimeout(r, 2500));
      log(`retried cart; still error: ${(await page.elements(AbortSignal.timeout(10000))).some((x) => x.name === "Try Again")}`);
    }
    await shot("4-cart-retry");
    const cr = await readPage(page, step);
    log(`cart review ${JSON.stringify(readCart(skill, cr))}`);
    log(`checkout control ${JSON.stringify(checkoutControl(skill, cr.elements, new Set()))}`);
    log(`cart text: ${cr.text.replace(/\s+/g, " ").slice(0, 400)}`);
  }
} catch (e) { log(`ERR ${(e as Error).message.slice(0, 200)}`); await shot("err"); }
await page.close(); await driver.close();
