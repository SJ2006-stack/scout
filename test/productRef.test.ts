import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectShelfOffers, parseShopLink, productCardsFromHtml, shopCompareView } from "../src/server/browser/shelf.ts";
import { normalisedSize } from "../src/shared/quantity.ts";

const SEEN_AT = 1_700_000_000_000;

describe("shop product links", () => {
  it("keeps Blinkit's real slug and id, and drops the placeholder slug", () => {
    assert.deepEqual(parseShopLink("Blinkit", "https://blinkit.com/prn/amul-gold-milk/prid/14639"), {
      link: "https://blinkit.com/prn/amul-gold-milk/prid/14639",
      productId: "14639",
    });
    assert.deepEqual(parseShopLink("Blinkit", "https://www.blinkit.com/prn/amul-gold-milk/prid/14639"), {
      link: "https://blinkit.com/prn/amul-gold-milk/prid/14639",
      productId: "14639",
    });
    assert.deepEqual(parseShopLink("Blinkit", "/prn/country-delight-salted-butter-cow-milk/prid/1391202"), {
      link: "https://blinkit.com/prn/country-delight-salted-butter-cow-milk/prid/1391202",
      productId: "1391202",
    });
    assert.deepEqual(parseShopLink("Blinkit", "https://blinkit.com/prn/x/prid/1391202"), {
      link: null,
      productId: "1391202",
    });
    assert.equal(parseShopLink("Blinkit", "https://blinkit.com/s/?q=amul%20butter"), null);
  });

  it("builds the Blinkit link from the card id and name the way the site does", () => {
    const html = [
      '<div id="1391202" role="button">',
      "<div>8 mins</div>",
      "<div>Country Delight Salted Butter (Cow Milk)</div>",
      "<div>80 g</div>",
      "<div>₹75</div>",
      "<button>ADD</button>",
      "</div>",
    ].join("");
    const cards = productCardsFromHtml("Blinkit", html);
    assert.equal(cards.length, 1);
    assert.equal(cards[0]?.productId, "1391202");
    assert.equal(cards[0]?.link, "https://blinkit.com/prn/country-delight-salted-butter-cow-milk/prid/1391202");
    assert.equal(cards[0]?.rupees, 75);
    assert.equal(cards[0]?.size, "80 g");
  });

  it("reads a Zepto card href and forces www.zepto.com", () => {
    const href = "/pn/amul-salted-butter/pvid/fc2ffbca-a36b-4728-b6be-3168475f3b75";
    assert.deepEqual(parseShopLink("Zepto", href), {
      link: "https://www.zepto.com/pn/amul-salted-butter/pvid/fc2ffbca-a36b-4728-b6be-3168475f3b75",
      productId: "fc2ffbca-a36b-4728-b6be-3168475f3b75",
    });
    assert.equal(
      parseShopLink("Zepto", "https://zepto.com/pn/gowardhan-paneer-pouch/pvid/1aeea0a9-50d3-4fc1-b29a-e4472cf66067")?.link,
      "https://www.zepto.com/pn/gowardhan-paneer-pouch/pvid/1aeea0a9-50d3-4fc1-b29a-e4472cf66067",
    );
    assert.equal(parseShopLink("Zepto", "https://www.zepto.com/search?query=milk"), null);
    const html = `<a data-testid="product-card" href="${href}">ADD ₹325 Amul Salted Butter 1 pack (500 g)</a>`;
    const cards = productCardsFromHtml("Zepto", html);
    assert.equal(cards[0]?.link, "https://www.zepto.com/pn/amul-salted-butter/pvid/fc2ffbca-a36b-4728-b6be-3168475f3b75");
    assert.equal(cards[0]?.productId, "fc2ffbca-a36b-4728-b6be-3168475f3b75");
    assert.equal(cards[0]?.rupees, 325);
    assert.equal(cards[0]?.size, "500 g");
  });

  it("reads an Instamart item href and ignores search urls and sku ids", () => {
    assert.deepEqual(parseShopLink("Instamart", "https://www.swiggy.com/instamart/item/TN0BERMP8A"), {
      link: "https://www.swiggy.com/instamart/item/TN0BERMP8A",
      productId: "TN0BERMP8A",
    });
    assert.deepEqual(parseShopLink("Instamart", "https://instamart.in/item/CCX1XWR7GN"), {
      link: "https://instamart.in/item/CCX1XWR7GN",
      productId: "CCX1XWR7GN",
    });
    assert.equal(parseShopLink("Instamart", "https://www.swiggy.com/instamart/search?query=milk"), null);
    assert.equal(parseShopLink("Instamart", "https://instamart.in/search?query=milk"), null);
    const bare = '<div data-testid="item-collection-card-full" data-sku="9FDPAD7ST3" data-spin="O4WS9UOMQ4">Amul Pasteurised Butter 100 g ₹66</div>';
    assert.equal(productCardsFromHtml("Instamart", bare).length, 0);
    const linked = '<a href="https://www.swiggy.com/instamart/item/TN0BERMP8A">Amul Pasteurised Butter 100 g ₹66</a>';
    const cards = productCardsFromHtml("Instamart", linked);
    assert.equal(cards[0]?.productId, "TN0BERMP8A");
    assert.equal(cards[0]?.link, "https://www.swiggy.com/instamart/item/TN0BERMP8A");
  });
});

describe("product ref on a compare offer", () => {
  it("records a ref on every offer and keeps the fields the chat already reads", () => {
    const html = [
      '<div id="1391202" role="button">Country Delight Salted Butter (Cow Milk) 80 g ₹75 ADD</div>',
    ].join("");
    const offers = collectShelfOffers(
      "Blinkit",
      "https://blinkit.com/s/?q=butter",
      [{ role: "button", name: "Country Delight Salted Butter (Cow Milk) 80 g ₹75 ADD" }],
      html,
      SEEN_AT,
    );
    const offer = offers.find((item) => item.ref?.productId === "1391202");
    assert.ok(offer);
    assert.equal(offer?.merchant, "Blinkit");
    assert.equal(offer?.rupees, 75);
    assert.equal(offer?.pageUrl, "https://blinkit.com/s/?q=butter");
    assert.equal(offer?.ref?.store, "blinkit");
    assert.equal(offer?.ref?.link, "https://blinkit.com/prn/country-delight-salted-butter-cow-milk/prid/1391202");
    assert.equal(offer?.ref?.size, "80 g");
    assert.equal(offer?.ref?.price, 75);
    assert.equal(offer?.ref?.seenAt, SEEN_AT);
    const view = shopCompareView(offer!);
    assert.equal(view.merchant, "Blinkit");
    assert.equal(view.title, offer?.title);
    assert.equal(view.rupees, 75);
    assert.equal(view.ref?.productId, "1391202");
  });

  it("leaves Instamart link and product id null when the search html has neither", () => {
    const html = '<div data-testid="item-collection-card-full">Amul Pasteurised Butter 100 g ₹66</div>';
    const offers = collectShelfOffers(
      "Instamart",
      "https://www.swiggy.com/instamart/search?query=butter",
      [{ role: "text", name: "Amul Pasteurised Butter 100 g ₹66" }],
      html,
      SEEN_AT,
    );
    assert.ok(offers.length >= 1);
    assert.equal(offers.every((offer) => offer.ref?.link == null && offer.ref?.productId == null), true);
    assert.equal(offers[0]?.ref?.store, "instamart");
    assert.equal(offers[0]?.ref?.size, "100 g");
    assert.equal(offers[0]?.merchant, "Instamart");
    assert.equal(offers[0]?.rupees, 66);
  });

  it("normalises g, gm, grams, kg, ml, l, and pcs on the ref", () => {
    assert.equal(normalisedSize("500 g"), "500 g");
    assert.equal(normalisedSize("500 gm"), "500 g");
    assert.equal(normalisedSize("500 grams"), "500 g");
    assert.equal(normalisedSize("1 kg"), "1 kg");
    assert.equal(normalisedSize("1 kilogram"), "1 kg");
    assert.equal(normalisedSize("200 ml"), "200 ml");
    assert.equal(normalisedSize("1 l"), "1 l");
    assert.equal(normalisedSize("1 ltr"), "1 l");
    assert.equal(normalisedSize("1 litre"), "1 l");
    assert.equal(normalisedSize("6 pcs"), "6 pcs");
    assert.equal(normalisedSize("6 pieces"), "6 pcs");
    assert.equal(normalisedSize("1 pack (50 x 20 g)"), "50 x 20 g");
    const cases = [
      ["Amul Butter 500 gm ₹285", "500 g"],
      ["Amul Butter 500 grams ₹285", "500 g"],
      ["Amul Taaza 1 kg ₹70", "1 kg"],
      ["Amul Taaza 1 L ₹70", "1 l"],
      ["Buttermilk 200 ml ₹15", "200 ml"],
      ["Farm Eggs 6 pcs ₹90", "6 pcs"],
      ["Farm Eggs 6 pieces ₹90", "6 pcs"],
    ] as const;
    for (const [name, size] of cases) {
      const offers = collectShelfOffers("Zepto", "https://www.zepto.com/search?query=amul", [{ role: "link", name }], "<html></html>", SEEN_AT);
      assert.equal(offers[0]?.ref?.size, size, name);
      assert.equal(offers[0]?.ref?.link, null);
      assert.equal(offers[0]?.ref?.productId, null);
      assert.equal(offers[0]?.ref?.store, "zepto");
      assert.equal(offers[0]?.title.length > 0, true);
      assert.equal(typeof offers[0]?.rupees, "number");
    }
  });
});
