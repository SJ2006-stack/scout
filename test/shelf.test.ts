import assert from "node:assert/strict";
import { describe, it } from "node:test";
import QRCode from "qrcode";
import { parseAriaSnapshot } from "../src/server/browser/aria.ts";
import { decodeQrPng } from "../src/server/browser/qrPng.ts";
import { asksForLocation, cheapestOffer, nextCheckoutClick, pricedText, pricedTitles, searchUrl, shelfSummary } from "../src/server/browser/shelf.ts";
import { listingsFromHtml } from "../src/server/events/htmlListings.ts";
import { paymentTarget, paymentUrlInText } from "../src/shared/payLink.ts";

describe("shop shelf", () => {
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
      { merchant: "Zepto", title: "Amul Taaza", rupees: 70, pageUrl: "https://www.zeptonow.com/" },
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
    assert.equal(searchUrl("Zepto", "ice cream"), "https://www.zeptonow.com/search?query=ice%20cream");
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
});
