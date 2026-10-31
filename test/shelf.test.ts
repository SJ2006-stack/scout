import assert from "node:assert/strict";
import { describe, it } from "node:test";
import QRCode from "qrcode";
import { parseAriaSnapshot } from "../src/server/browser/aria.ts";
import { decodeQrPng } from "../src/server/browser/qrPng.ts";
import { asksForLocation, attendListing, cheapestOffer, matching, nextCheckoutClick, pricedText, pricedTitles, searchUrl, shelfSummary } from "../src/server/browser/shelf.ts";
import { readCart } from "../src/server/browser/siteFlows.ts";
import { SKILLS } from "../src/server/browser/skills.ts";
import { listingsFromHtml } from "../src/server/events/htmlListings.ts";
import { paymentTarget, paymentUrlInText } from "../src/shared/payLink.ts";
import type { ElementTarget, IsolatedPage, PageElement } from "../src/server/browser/driver.ts";

describe("shop shelf", () => {
  it("reads every product in one Instamart grid text and keeps only query matches", () => {
    const elements = [{ role: "text", name: "Filters MaxxSaver Sort By Quick filters Customer Ratings Cadbury Dairy Milk Milkinis Duo Pack Chocolate Bar ₹ 36 Amul Dark Chocolate ₹ 180 Kinder Joy icon.png ₹ 45 Cadbury Dairy Milk Silk 20% OFF ₹ 60" }];
    const priced = pricedTitles(elements);
    assert.deepEqual(priced.map((item) => [item.title, item.rupees]), [
      ["Cadbury Dairy Milk Milkinis Duo Pack Chocolate Bar", 36],
      ["Amul Dark Chocolate", 180],
      ["Kinder Joy", 45],
      ["Cadbury Dairy Milk Silk", 60],
    ]);
    const offers = priced.map((item) => ({ merchant: "Instamart" as const, title: item.title, rupees: item.rupees, pageUrl: "https://www.swiggy.com/instamart/" }));
    assert.deepEqual(matching(offers, "dairy milk").map((offer) => offer.rupees), [36, 60]);
    assert.equal(matching(offers, "chocolates").length, 2);
  });

  it("summarises one cheapest match per store and names stores with none", () => {
    const summary = shelfSummary([
      { merchant: "Blinkit", title: "Dairy Milk 25 g", rupees: 25, pageUrl: "https://blinkit.com/" },
      { merchant: "Blinkit", title: "Dairy Milk Silk", rupees: 100, pageUrl: "https://blinkit.com/" },
      { merchant: "Zepto", title: "Dairy Milk Pack", rupees: 20, pageUrl: "https://www.zepto.com/" },
    ]);
    assert.equal(summary, "Zepto is cheapest: Dairy Milk Pack at ₹20. Blinkit from ₹25 (Dairy Milk 25 g). Instamart showed no match.");
  });

  it("reads the Blinkit cart drawer bill, not the search page behind it", () => {
    const text = "p r 1 item ₹25 Showing results for dairy milk Cadbury Dairy Milk Milkinis 34 g ₹36 ADD Cadbury Dairy Milk Chocolate Bar 25 g ₹25 1 My Cart Delivery in 8 minutes Shipment of 1 item Cadbury Dairy Milk Chocolate Bar 25 g ₹25 1 Bill details Items total ₹25 Delivery charge ⓘ ₹25 Handling charge ⓘ ₹2 Grand total ⓘ ₹52 Cancellation Policy";
    const review = readCart(SKILLS.blinkit, { url: "https://blinkit.com/s/?q=dairy%20milk", elements: [], text });
    assert.deepEqual(review?.lines, [{ title: "Cadbury Dairy Milk Chocolate Bar 25 g", quantity: 1, paise: 2500 }]);
    assert.deepEqual(review?.fees, [{ label: "Delivery charge", paise: 2500 }, { label: "Handling charge", paise: 200 }]);
    assert.equal(review?.totalPaise, 5200);
    const guest = "Cart Delivering in minutes 1 item Cadbury Dairy Milk Chocolate Bar Pack ₹20 Bill Summary Item Total ₹20 Log in to see your exact total.";
    assert.equal(readCart(SKILLS.zepto, { url: "https://www.zepto.com/", elements: [], text: guest }), null);
  });

  it("keeps a price line and picks the cheapest title", () => {
    const elements = parseAriaSnapshot([
      "- button \"Search\"",
      "- link \"Amul Taaza ₹80\"",
      "- text: ₹70",
      "  - text \"Milk ₹90\"",
    ].join("\n"));
    assert.equal(elements.some((element) => element.role === "text" && element.name.includes("₹")), true);
    const priced = pricedTitles(elements);
    assert.equal(priced[0]?.title, "Amul Taaza");
    assert.equal(priced[0]?.rupees, 80);
    const cheapest = cheapestOffer([
      { merchant: "Blinkit", title: "Amul Taaza", rupees: 80, pageUrl: "https://blinkit.com/" },
      { merchant: "Zepto", title: "Amul Taaza", rupees: 70, pageUrl: "https://www.zepto.com/" },
    ]);
    assert.equal(cheapest?.merchant, "Zepto");
    assert.match(shelfSummary([cheapest!]), /Zepto is cheapest/);
  });

  it("clicks add, then an offer, then checkout", () => {
    const elements = [
      { role: "link", name: "Amul Taaza ₹70" },
      { role: "button", name: "Add" },
      { role: "button", name: "Apply offer" },
      { role: "button", name: "Checkout" },
    ];
    const seen = new Set<string>();
    const names: string[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const next = nextCheckoutClick(elements, "Amul Taaza", seen);
      if (!next) break;
      seen.add(`${next.role}\0${next.name}`);
      names.push(next.name);
    }
    assert.deepEqual(names, ["Amul Taaza ₹70", "Add", "Apply offer", "Checkout"]);
  });

  it("clicks checkout, then the UPI pay button, on Blinkit, Zepto, and Swiggy", () => {
    for (const _merchant of ["Blinkit", "Zepto", "Instamart"]) {
      const elements = [
        { role: "link", name: "Milk" },
        { role: "button", name: "Add" },
        { role: "button", name: "Checkout" },
        { role: "button", name: "Pay with UPI" },
        { role: "button", name: "PhonePe" },
      ];
      const seen = new Set<string>();
      const names: string[] = [];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const next = nextCheckoutClick(elements, "Milk", seen);
        if (!next) break;
        seen.add(`${next.role}\0${next.name}`);
        names.push(next.name);
      }
      assert.deepEqual(names, ["Milk", "Add", "Checkout", "Pay with UPI", "PhonePe"]);
    }
  });

  it("clicks Book, then Pay, on a District listing", () => {
    const elements = [
      { role: "button", name: "Book" },
      { role: "button", name: "Pay" },
    ];
    const seen = new Set<string>();
    const names: string[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const next = nextCheckoutClick(elements, "Nitro Run", seen);
      if (!next) break;
      seen.add(`${next.role}\0${next.name}`);
      names.push(next.name);
    }
    assert.deepEqual(names, ["Book", "Pay"]);
  });

  it("reads a payment deeplink and a QR", async () => {
    assert.equal(paymentTarget("upi://pay?pa=shop@upi&am=70&cu=INR"), "upi://pay?pa=shop@upi&am=70&cu=INR");
    assert.equal(paymentTarget("https://blinkit.com/"), null);
    assert.equal(paymentUrlInText("open upi://pay?pa=shop@upi&am=10 now"), "upi://pay?pa=shop@upi&am=10");
    const png = await QRCode.toBuffer("upi://pay?pa=shop@upi&am=70&cu=INR", { type: "png", margin: 4, width: 280 });
    assert.equal(decodeQrPng(png), "upi://pay?pa=shop@upi&am=70&cu=INR");
  });

  it("reads a rupee from the page text and opens each shop search", () => {
    const priced = pricedText("<div>Amul Chocolate Ice Cream ₹249</div><p>Delivery fee ₹25</p>");
    assert.equal(priced[0]?.title, "Amul Chocolate Ice Cream");
    assert.equal(priced[0]?.rupees, 249);
    assert.equal(priced.some((item) => /fee/i.test(item.title)), false);
    assert.equal(searchUrl("Blinkit", "ice cream"), "https://blinkit.com/s/?q=ice%20cream");
    assert.equal(searchUrl("Zepto", "ice cream"), "https://www.zepto.com/search?query=ice%20cream");
    assert.equal(searchUrl("Instamart", "ice cream"), "https://www.swiggy.com/instamart/search?query=ice%20cream");
    assert.equal(asksForLocation("Please select your location to see prices"), true);
  });

  it("reads event links from a public page", () => {
    const html = [
      '<a href="https://luma.com/roast-tank">Roast</a>',
      '<a href="https://luma.com/bengaluru">City</a>',
      '<a href="https://in.bookmyshow.com/events/cheap-standup/ET1">Show</a>',
    ].join(" ");
    const luma = listingsFromHtml(html, "Luma", "Bengaluru", "2026-10-31T00:00:00.000Z");
    assert.equal(luma.length, 1);
    assert.equal(luma[0]?.url, "https://luma.com/roast-tank");
    const shows = listingsFromHtml(html, "BookMyShow", "Bengaluru", "2026-10-31T00:00:00.000Z");
    assert.equal(shows[0]?.url, "https://in.bookmyshow.com/events/cheap-standup/ET1");
    assert.equal(shows[0]?.title, "Cheap Standup");
  });
  it("submits the Luma form through the dialog button, not the covered page button", async () => {
    const url = "https://luma.com/io3jgrsl";
    const join: PageElement = { role: "button", name: "Request to Join" };
    let open = false;
    let done = false;
    const clicks: ElementTarget[] = [];
    const page = {
      goto: async () => ({ url, title: "NITRO RUN" }),
      location: async () => ({ url, title: "NITRO RUN" }),
      html: async () => (done ? "<p>You're registered</p>" : "<p>NITRO RUN</p>"),
      elements: async () => (done ? [] : open ? [join, { role: "textbox", name: "Name *" }, { role: "textbox", name: "Email *" }, join] : [join]),
      click: async (target: ElementTarget) => {
        clicks.push(target);
        if (!open) open = true;
        else if (target.nth === 1) done = true;
        else throw new Error("covered by the dialog");
      },
      fill: async () => undefined,
      takePayment: () => null,
      screenshot: async () => new Uint8Array(),
      storageState: async () => ({}),
      close: async () => undefined,
    } as IsolatedPage;
    const step = <T>(run: (signal: AbortSignal) => Promise<T>) => run(new AbortController().signal);
    const result = await attendListing(page, url, "Luma", "NITRO RUN", { email: "a@example.com", phone: null, name: "A" }, step);
    assert.equal(result.message, "Registered for NITRO RUN.");
    assert.deepEqual(clicks.map((click) => click.nth), [0, 1]);
  });
});
