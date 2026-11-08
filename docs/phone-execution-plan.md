# Plan: discover on Azure, act on the phone

Status: plan only. Nothing here is built yet. Written Nov 4, 2026.

This covers Shop Scout (quick commerce) and Event Scout (events and movies).

## The rule

1. **Azure discovers and compares.** It reads listings, prices, stock, and showtimes from the websites and returns a ranked choice. It never changes anything on a store or event site.
2. **The phone acts.** Adding to a cart, picking seats, registering, and booking all happen in the real Android app on the user's phone, driven by Scout's Accessibility Service.
3. **The user pays.** Scout stops on the cart or the pay screen. It never taps Pay, Place order, or anything that moves money, and never reads or types a PIN, card number, or CVV.
4. **The phone checks again before acting.** A comparison is a plan, not a promise. The phone re-reads the price, size, and stock in the app and stops if they break the user's limits.
5. **The server holds no store sign-ins.** The user is already signed in to their own apps. The one open question is Instamart (see "Decisions").

Anything that does not fit these rules is either a read-only listing on Azure or a hand-off link that the user taps.

## How a request flows

```text
User: "add 2 Amul butter 500g, max ₹290 each"
  │
  ▼
Azure (Shop agent)
  compare on Blinkit, Zepto, Instamart, ... through the phone relay
  → ranked offers, each with a product reference (id, link, name, size, price, seen at)
  → card in chat: cheapest per store, "Add to <store> cart"
  │  user taps
  ▼
Azure sends phone action `app_cart_add` (or `app_event_book`) with an execution plan
  │
  ▼
Phone (Accessibility Service)
  open the app → open the product (deep link, else search) → check again
  → set quantity → open the cart → read the total → stop
  │
  ▼
Phone reports back: what it added, the price it saw, the cart total, or where it stopped
  │
  ▼
Chat card: "Added 2 × Amul Butter 500 g at ₹285. Cart ₹580. Pay in Blinkit."
```

## Shared contract

### Execution plan (Azure to phone)

A new family of phone actions in `src/shared/deviceActions.ts`, checked the same way as the current ones.

```ts
type ProductRef = {
  store: ShopApp;              // "blinkit" | "zepto" | "instamart" | ...
  productId: string | null;    // the store's id, when the website shows it
  link: string | null;         // product page URL, tried as an app deep link first
  name: string;
  size: string | null;         // normalised, e.g. "500 g"
  price: number;               // rupees seen on Azure
  seenAt: number;
};

type AppCartAdd = {
  name: "app_cart_add";
  args: {
    items: Array<{ ref: ProductRef; quantity: number; maxPrice: number }>;
    allowSimilar: boolean;     // false: exact name and size only
  };
};

type EventRef = {
  app: EventApp;               // "bookmyshow" | "district" | "luma" | ...
  eventId: string | null;
  link: string;
  title: string;
  venue: string | null;
  startsAt: number | null;
  price: number | null;
};

type AppEventBook = {
  name: "app_event_book";
  args: {
    ref: EventRef;
    tickets: number;
    maxPricePerTicket: number | null;
    seat: "best_available" | "user_picks";   // movies and seated events
    showtime: number | null;                   // movies
  };
};
```

Both need `confirm: true`: the user taps Allow on the phone before Scout takes over the screen.

### Result (phone to Azure)

The current `DeviceResult` with a typed `data`:

- `completed`: the items or tickets that were added, with the price seen in the app, plus the cart or order-summary total.
- `needs_approval`: the price went up, the size differs, or it's out of stock. Includes what the app shows, so Scout can ask "₹289 instead of ₹285, add anyway?".
- `failed`: the step it stopped at and why (`no_match`, `not_signed_in`, `app_missing`, `screen_changed`, `timeout`, `captcha`).
- `handoff_started`: the user chose to finish by hand, or the step needs them (seat map, sign-in).

## Android side (built once, used by every app)

1. **`CartAutomation` Accessibility Service** (`companion/automation/`), limited by `packageNames` to the apps listed below. It does nothing unless an approved plan is running.
2. **Step runner:** steps that wait for screen conditions (never fixed delays), each with a timeout and a named failure. Helpers: find a node by id, text, or regex; tap (accessibility click, falling back to a gesture); type; scroll; go back.
3. **Per-app scripts:** one file per app that maps the steps to that app's screens. These are the only app-specific parts.
4. **Hard safety list** in code, checked before every tap: never press anything matching pay, place order, confirm booking, autopay, mandate, subscribe, save card, or UPI PIN. The patterns start from `COMMON_FORBIDDEN` in `skills.ts`.
5. **Taking over the screen:** a "Scout is working, tap to stop" notification. Stop at once if the user touches the screen or leaves the app.
6. **Privacy:** read only the nodes a step needs. Send back product, price, cart, and ticket text only, never full screen dumps.
7. **Deep links first:** open the product or event page by link when the app supports it, and fall back to search only when it doesn't.
8. **Permissions panel:** an Accessibility row with the state and a button to the system setting. `get_capabilities` reports which apps are installed and whether the service is on.
9. **Fixtures:** saved `uiautomator` dumps for every screen of every app, used in unit tests and to see what changed after an app update.

## Server side (built once)

1. Add the new action names and their checks to `deviceActions.ts`, with an exhaustive switch.
2. Each comparison or listing result carries a `ProductRef` or `EventRef`.
3. Agents pick the phone path when `get_capabilities` says the app is installed and the service is on. Otherwise they offer a hand-off link.
4. Result cards for added, needs your OK, stopped at a step, and pay in the app.
5. Log every run (app, app version, step reached, duration, outcome), so breakage after an app update shows up quickly.

## Shop Scout

### Stores

| Store | Website (compare on Azure) | Android app (act on phone) | Phase |
| --- | --- | --- | --- |
| Blinkit | blinkit.com | `com.grofers.customerapp` | 1 |
| Zepto | zepto.com | `com.zeptoconsumerapp` | 1 |
| Swiggy Instamart | swiggy.com/instamart | `in.swiggy.android` | 1 |
| BigBasket BB Now | bigbasket.com | `com.bigbasket.mobileapp` | 2 |
| Flipkart Minutes | flipkart.com | `com.flipkart.android` | 2 |
| Amazon Now / Fresh | amazon.in | `in.amazon.mShop.android.shopping` | 3 |
| JioMart | jiomart.com | `com.jpl.jiomart` | 3 |

Phase 2 and 3 package names, and whether each store's website shows quick-commerce prices for a pincode, still need checking on a real device.

### Azure: compare

- Keep the current parallel compare (`shelf.ts`, three stores in 6 to 8 s through the relay). Add a `ProductRef` (product id and product page link) to each offer.
- Keep size matching (g, gm, kg, ml, l, pcs) shared between the server and a Kotlin copy, tested on the same cases.
- **Baskets:** a list such as "butter, bread, 6 eggs" is compared per item, then split across stores by total cost, including each store's delivery and handling fees and minimum order. Show one plan per store and a "cheapest single store" option.
- Each relay host for a new store goes into `RELAY_SUFFIXES` and the Android allowlist together.

### Phone: act

Each store script has the same steps:

1. Open the app. If it shows no delivery address or the wrong pincode, stop with `needs_approval`. Don't change addresses on our own.
2. Open the product by deep link, or else search for the name and size.
3. Pick the product card that matches the name, size, and `maxPrice` and is in stock. If more than one matches, take the cheapest. If none match, stop and report what was there.
4. Set the quantity with + and −, then read back the quantity the app shows.
5. Open the cart. Read each line and the bill: item total, delivery, handling, total.
6. Stop and report.

### Retire on the server (after the phone path works for a store)

- `buy_from_shop`'s server cart, sign-in, and pay steps in the browser worker for that store.
- The store's saved sign-in in `sessionVault` / `profileVault` and its phone copy, if the Instamart decision allows.
- Checkout parts of `checkoutLedger.ts` that only served server carts.

Keep the code behind a flag until each store's phone path has run on a real phone, then delete it.

## Event Scout

### Sources

| Source | Discovery on Azure | Android app (act on phone) | What the phone does | Phase |
| --- | --- | --- | --- | --- |
| BookMyShow | yes (listing pages, already live) | `com.bt.bms` | movies: showtime, seat count, best seats, stop at pay. events: tickets, stop at pay | 1 |
| District (Zomato) | yes (already live) | package to verify | movies and events, same as above | 1 |
| Luma | yes (already live) | app to verify; Chrome on the phone if there's none | register with the profile, or stop at pay for paid events | 1 |
| Eventbrite | add (public API) | `com.eventbrite.attendee` (verify) | register or tickets, stop at pay | 2 |
| Meetup | add | `com.meetup` | RSVP | 2 |
| AllEvents | add (listings only) | none; hand-off link to the organiser's page | hand-off | 3 |
| Townscript, Skillboxes, HighApe, SortMyScene | add if their listings can be read | check | hand-off at first | 3 |

Paytm Insider is now part of District, so it isn't a separate source.

### Azure: discover

- Keep the current Luma, District, and BookMyShow readers. Add an `EventRef` (event id and link) to each card.
- **Movies:** add showtimes per cinema for a chosen date, so the user can pick a show in chat, for example "8:30 pm at PVR Select City". The phone then only runs that show.
- Rank events by date fit, distance (drive time already exists), price, and the user's memory (city, interests, budget).
- Scout Watch stays on Azure: new matches go to the inbox and phone push.

### Phone: act

- **Movies (BookMyShow, District):** open the movie, choose the date and cinema, tap the showtime, set the seat count, then pick seats:
  - `best_available`: take the app's suggested or best block if it offers one. Otherwise pick seats next to each other near the centre, but only if the seat map can be read through the accessibility tree.
  - Seat maps are often drawn as one canvas the accessibility tree can't see. In that case, stop with `handoff_started` on the seat map and let the user pick seats.
  - Then go to the order summary, read the total, and stop before Pay.
- **Events with tickets:** choose the ticket type and count within `maxPricePerTicket`, open the summary, read the total, and stop before Pay.
- **Free registration (Luma, Meetup):** fill only fields the app has not filled from the user's own account. Submit a free registration or RSVP only after the Allow on the phone. A paid ticket stops before Pay.

### Retire on the server

- The book and checkout click-through in the browser worker (`siteFlows.ts`) for each app once its phone path works.
- Server-side Luma registration. Keep it as the fallback for web users without the app until the phone path is proven.

## Fallbacks

| Situation | What Scout does |
| --- | --- |
| No Scout Android app (web user) | Compare and discover as now, then a link that opens the store or event page |
| App installed, Accessibility off | A card asking to turn it on, plus the hand-off link |
| Store app not installed | Hand-off link to the website or Play Store |
| Phone relay offline | Compare on stores that block Azure fails; say so instead of showing empty results |
| Screen changed after an app update | `failed` with the step; the user finishes by hand; the run log flags the app version |

## Phases

**Phase 0: feasibility check (gate, about 2 to 3 days).** On a real phone over adb, for Blinkit, Zepto, Swiggy, BookMyShow, District, and Luma:
- Dump every screen in the flow. Can the product cards, prices, + and − buttons, cart lines, showtimes, and seat map be read through the accessibility tree?
- Do the website's product and event links open in the app as deep links?
- Does the website show a product id that the app accepts?

Write the result per app. An app that fails this check stays on hand-off links.

### Phase 0 results

Device: Xiaomi 25057RN09I (HyperOS, Android 16), checked Nov 4, 2026. Screen dumps and screenshots are in `prototype/scratch/phase0/` (not in git: they show the user's address and cart).

Installed on this phone: Blinkit, Zepto (`com.zeptoconsumerapp`), Swiggy (`in.swiggy.android`), Flipkart, Amazon, District (`com.application.zomato.district`), Luma (`com.luma.mobile`), BookMyShow (`com.bt.bms`), Scout 0.9.1. BigBasket, JioMart, Meetup, and Eventbrite are not installed.

**Blinkit 18.41.0: passes.**

- Every screen in the flow can be read through the accessibility tree, with stable Blinkit resource IDs:
  - Search results: one card per product with `tv_name`, `tv_uom_title` (size), `price`, `mrp`, `inventory_info` ("2 left"), an `Ad` label on sponsored cards, and the whole card summarised in its content description ("… is available for ₹66, 100 g").
  - Stepper: `stepper` shows `ADD`. After a tap it becomes `icon_decrement` ("Decrease quantity"), `tv_title` ("quantity 2"), and `icon_increment` ("Increase quantity"). Tapping them worked, and the quantity read back correctly.
  - A floating `view_cart` bar with `tv_quantity` ("2 items").
  - Cart (titled "Checkout"): each line has `tv_name`, `tv_variant`, a stepper, `total_mrp_price`, and `total_item_price`. Out-of-stock lines appear separately ("1 item is not in stock"). There's a delivery address row, then Bill details with item rows "Items total", "Handling charge", "Delivery charge", and "Grand total" (each `item_container` has the label and amount in its description).
  - **Danger button:** `cv_checkout_container` with `tv_action_text` "Place Order", next to `cl_cart_payment` "PAY USING Google Pay UPI". Tapping it would order straight away with the saved UPI app, so it goes on the block list by ID and by text.
- Search results are not in the order you'd want: "amul butter 500g" showed Nutralite and Milky Mist first, including sponsored cards. Matching on name and size is required.
- The user's cart can already contain other items, so the phone has to read the whole cart and report only on its own lines.
- **Deep links:** Android verifies Blinkit as the owner of `blinkit.com`, with paths `/s/` (search), `/prn/` (product), and `/cart`.
  - Search `https://blinkit.com/s/?q=<query>` opens the results screen.
  - Product `https://blinkit.com/prn/<slug>/prid/<id>` opens the product page **only with the real slug** (`/prn/x/prid/…` opens home), and **only when Blinkit is already running**. From a cold start, both open the home screen. So the runner must launch Blinkit, wait for the home screen, then send the link.
  - The app's Share text gives the link with the ID (`https://blinkit.com/prn/x/prid/1391202`). Azure's compare needs to save the slug and ID from the website's product links. It doesn't save them today.
- `uiautomator dump` fails with "could not get idle state" on product pages, because a product video autoplays. That only affects this debugging tool. An Accessibility Service reads the tree without waiting for idle.
- Test left the cart as it was: added Nutralite butter 100 g, raised it to 2, read the bill (₹124 + ₹6 + ₹35 = ₹165), then removed it. No order was placed.

**Zepto 26.10.4: passes.**

- Search, the product page, the stepper, the cart, and the bill can all be read. Ids are a stable prefix plus the product UUID: `product-card-container<uuid>`, `product-card-add-button<uuid>`.
- A search card's content description has the name, pack size, and price, and the name, selling price, MRP, and "₹N OFF" are also separate text nodes. The button description is "Add to Cart", with a child text "ADD". A sponsored row has the text "Sponsored by Orika". The small "Ad" chip on a product photo is not a text node. In-stock cards have no "N left" count. An out-of-stock block says "Few items are out of stock".
- After add, that button id grows `-minus` ("decrease quantity") and `-plus` ("increase quantity"). The count is the description "1 item" or "2 items". Digit TextViews 1 through 11 overlap for the rolling animation, so the digit text is not safe to read. Plus moved the count from 1 to 2.
- The cart tab is `floating-cart-button` ("Cart"). Each line has `product-name-of-cart-item` and `order-detail-product-sku-quantity` ("1 pack (1 kg)"). The line's own description says "Quantity is : 1 pack (1 kg)", which is the pack, not the count. The count is the section header ("2 items", then "1 item") and the stepper, whose descriptions are "Remove" and "Add" on an id that is the product UUID. A pre-existing out-of-stock Snickers line reads "1 item is out of stock".
- Bill rows, each with its own amount: Item Total ₹64 struck to ₹58, Delivery Fee ₹30 ("Free above ₹149"), Handling Fee ₹10, To Pay ₹104 struck to ₹88. The address row's description names the saved place. It was not changed.
- **Danger button:** `cart-pay-button`, text and description "Pay ₹88", beside "PAYING VIA" / "GPay UPI". The same id reads "Clear cart" when nothing orderable is in the cart, so block it by the Pay text, not by the id alone.
- Sponsored cards are sorted first. Matching on name and size is required. The cart can already hold other lines.
- **Deep links:** Share text is `https://www.zepto.com/pn/tata-salt-free-flowing-and-iodized-namak-vacuum-evaporated-salt-in-fresh/pvid/208bdb3c-da54-493a-9cb1-5b6c159ae9e1?marketplaceType=SUPER_SAVER`. The pvid is the card's UUID.
  - `https://www.zepto.com/search?query=amul+butter` opens the results, warm and cold.
  - `/pn/<slug>/pvid/<uuid>` opens that product, warm and cold. A fake slug (`/pn/x/pvid/…`) still opens the product. A cold start does not bounce to home.
- The test left the cart as it was. `10-minus1` still had Tata Salt at 1 (Pay ₹59, down from ₹88 at 2). `11-removed` cleared Tata Salt: the button went back to "Clear cart", and the search card showed ADD again. The cart was left on the out-of-stock Snickers line that was already there. No order was placed.

**Swiggy Instamart 4.120.3: passes.**

Checked on 4.120.3. The pass started on 4.112.0. An "Update app now" sheet was tapped by mistake and Play Store updated Swiggy before the Instamart screens below. An OTP screen left by the previous session was not submitted. The account was already signed in.

- Home rails expose `tvItemPrice`, `tvMrp`, and `add_button` ("add button"), and not the product name. Don't pick a product off the home rail.
- Search (`et_search_query_v2`): `item_description` (name), a size text ("1 kg"), `selling_price`, `actual_price`, `ppu`, `first_view_tv` ("9% OFF"), `adIcon` text "Ad", a "BESTSELLER" badge, and `type_classifier_img` ("VEG"). `add_to_cart` is "add button". No "N left" on in-stock cards. A row titled "Few Items are currently sold out" lists names with no add button. Some cards show several sizes ("500 g", "1 kg", "+1").
- Stepper: `decrement_button_touch_target` ("remove one quantity"), `quantity_text_1` or `quantity_text_2` whose text is the count (the id changes with the number), `increment_button_touch_target` ("add one more"). Plus moved 1 to 2.
- Cart bar: `floating_crouton`, `tvCart` "CART", `tvCartItems` "1 ITEM" or "2 ITEMS".
- A cart line is one text node: "Tata Salt, Iodised Namak, Vacuum Evaporated Salt, 1 kg, quantity 2, price 58 rupees". The stepper descriptions are "Remove 1 item from cart" and "Add 1 item to cart".
- The bill is in the tree even when scrolled off: Item Total ₹58.00, Handling Fee ₹3.01, Delivery Partner Fee ₹35.70, To Pay ₹97. The tip row says "Add a tip".
- **Danger button:** the footer description is "Add address to proceed", not Pay. The place saved on the home screen is not complete enough for Instamart (the form asks for building and floor). That footer opens the address editor. No Place Order button was on this cart. A Swiggy One sheet offered "Add to Cart" for a ₹1 membership and was skipped. Block "Add address to proceed", Checkout, and Pay.
- The address editor opened once because a scroll hit that footer. Back left it without saving. The address was not changed.
- **Deep links:** Share text is `https://instamart.in/item/5DMEFBCGC6?share=true`.
  - `https://instamart.in/search?query=` opens search, warm and cold.
  - `https://instamart.in/item/<id>` opens the product, warm and cold. A bad id stays in the app on "Something went wrong".
  - `https://www.swiggy.com/instamart/item/<id>` opens the product.
  - `https://www.swiggy.com/instamart/search?query=` opens Chrome, not the app.
- The cart was restored: salt was raised to 2, the bill was read, then both units were removed and the card showed ADD again. No order was placed.

**District 2.79.0: passes.**

- The home tiles (Dining, Movies, Events, and the rest) are clickable frames. The images have no text and no content description, so "Movies" is not in the tree. On this phone the first row was Dining, Movies, Events.
- Movie cards: `main_title`, genre tags, `top_right_tag` ("Bookings open"), and a button "Book tickets". The header subtitle is the location.
- Movie page: title, "U | Hindi +5 more | 3h 15m", the synopsis, and "Book tickets". The language sheet's `primary_button` "Proceed" only chooses the language. Hindi was already selected, and the "preferred language" switch was not touched.
- Showtimes: date chips ("Tomorrow", "Thu, 5 Nov"), the cinema name, distance, rating, "₹700 onwards", and a time "07:20 AM" with subtitle "IMAX".
- The seat map is a WebView, not one canvas. After "seat layout page loaded", each free seat is a button `available-seat` described as "available seat, class CLASSIC, row B, column 26, price 700". This screen exposed 17 free seats. The occupied X marks are not nodes. A dump taken while the WebView is still spinning has no text. No seat was selected. There is no ticket-count stepper. The count is the number of selected seats. The legend text is Available, Occupied, Selected.
- Event cards: the venue is text, and the title and "Sat, 14 Nov, 6:00 PM" are content descriptions. The price is not on the card.
- Event page: title, venue, "Starts at 8:30 PM", and `dt_button` "Book tickets" next to "₹100". Slots read "Wed, 04 Nov" / "8:30 pm onwards".
- The ticket page is a WebView: "Entry Ticket", "₹100", "Entry for one (non redeemable)", button "Add". After Add, the text "1" sits between two images with no description (minus and plus). The footer reads "1 ticket" and "₹100". Plus made it "2 tickets" and "₹200". Minus twice brought back "Add".
- **Danger button:** "Checkout" on the ticket page. It was not tapped. A movie reaches pay only after seats are selected, and that bar was never opened.
- **Deep links:** `/movies/war-2-movie-tickets-in-gurgaon-MV161358` opens that movie, warm and cold. The trailer makes `uiautomator dump` return an empty tree. The screenshot is the movie page. An event URL opened Amoeba in Goa from a cold start, with "From ₹324" and "Book tickets". `https://www.district.in/search?q=` opens the app and lands on home, not search, warm and cold.
- A profile sheet was dismissed with "I'll do it later". A date picker opened and was cancelled with nothing selected. No booking was confirmed.
- **4 Nov 2026, live again.** The location chip was already "Ber Sarai / New Delhi". It was not changed. The dining aerobar (Flat ₹175 OFF) was closed with its icon; the offer itself was not opened. Hero "Notify Me", an EMI strip, a movie-voucher "Know more", and Feeding India amounts are not part of the booking and were not tapped. Login and the profile sheet did not appear.
- Karaoke Night at Gonzo, ₹100. The slot sheet is part of the booking. Its close icon only dismisses it. A tap in the middle of a date box can land on the next box; the left edge of "Wed, 04 Nov" selected Wed 4 Nov, 8:30 PM. Add then shows "1" and a footer "1 ticket / ₹100" with Checkout. Checkout was not tapped. That is the stop.
- If the next screen is "Review your booking" with Pay Now and a countdown, the ticket is already held. Remove it and confirm. Do not tap Pay Now. That happened for 14 Nov and 7 Nov before the date was corrected, and both lines were removed. The invoice block was already filled, including city Delhi. Nothing was typed over it.

**Luma 2.3.3: partly.**

Scored from the dumps in `scratch/phase0/taught/luma/`. The registration sheet was opened from the event page, and Back returned to the event. The sheet's Register was not tapped. Nothing was submitted. Numbered steps are in `scratch/phase0/taught/FLOW.md`.

- Home is signed in. The "luma" wordmark is a picture. Date headings and the tab labels are text. A card is one content description, for example "Prompt to Prototype, 16:00, Delhi Technological University, Near Capacity, By OpenAI Student Collective at DTU". "Invited" and "Pending" are their own text. Calendar tiles are names as content descriptions; the artwork is a picture. The only resource id is `com.luma.mobile:id/action_bar_root`.
- Event page: title, host, "Today, 16:00 - 18:00 GMT+05:30", "1 Spot Left", venue "Delhi Technological University", and a street line. The cover's description is "Event cover image"; the words printed on the poster are not in the tree. Share is a described button. Register, Contact, and More are child texts on clickable views whose own descriptions are empty. The button icons are pictures.
- Scrolled, the tree also has the room line "AB3 - 318, DTU", host names as text, two Instagram buttons, "129 Going", and the guest names as one line. Host photos are pictures. The map control is described "Map"; the pin and the names drawn on the map are a picture. Weather is the description "Clear" plus the text "28°C". About Event is a WebView, and that copy is real text.
- The registration sheet is titled "Registration" and shows the event name, "Today, 16:00", and "Register". The poster on the sheet has no text and no content description. Five labeled nodes: no name field, no email field, no ticket stepper, and no price. The sheet's Register was not tapped.
- Share preview text is `https://luma.com/h5ap73nr`.
- **Deep links,** from dumps already taken: cold `https://lu.ma/discover` opens Discover in New Delhi. Popular-event cards are one content description each (title, time, host); the photos are pictures; category labels are text. A warm Discover dump is that same tab, on categories, city cards, and featured calendars whose names and blurbs are text. Cold `https://lu.ma/h5ap73nr` and cold `https://luma.com/h5ap73nr` open Prompt to Prototype (Today 16:00-18:00, 1 Spot Left, Register, Contact, More, Delhi Technological University). A warm event link opens the same page. Register was not tapped on those.
- **Stop:** before Register on the Registration sheet. RSVP, Pay, and Confirm were not opened.

**BookMyShow 18.3.0: not captured.**

- No screenshot or accessibility dump in `scratch/phase0/taught/bookmyshow/`. Home, a movie page, a showtime, a seat map, tickets, Pay, and Confirm were not captured.

Still to check: submitting Luma registration (the sheet's Register was not tapped, and that sheet had no form fields). BookMyShow (`com.bt.bms` 18.3.0) was not captured. Whether HyperOS's battery and autostart settings stop Scout's Accessibility Service in the background.

**Phase 1: foundation plus Blinkit.** The Accessibility Service, step runner, safety list, Permissions entry, the `app_cart_add` contract, result cards, and `ProductRef` on compare. Blinkit end to end on a real phone.

**Phase 2: Zepto and Instamart.** Same steps. Then baskets split across the three stores.

**Phase 3: events.** `app_event_book`, `EventRef`, and BookMyShow movies with showtime picking in chat, then District, then Luma registration on the phone.

**Phase 4: retire server execution.** Remove server carts, server store sign-ins, and server booking click-through for every app that passed phase 1 to 3 on a phone.

**Phase 5: more sources.** BB Now and Flipkart Minutes for Shop. Eventbrite and Meetup for Events. Then the phase 3 rows in both tables.

**Ongoing:** fixtures refreshed per app update, run logs, the relay as a foreground service so it survives backgrounding, and FCM token registration.

## Decisions to make

1. **Instamart compare needs a signed-in Swiggy account on the website.** Choose one:
   - keep one read-only Swiggy sign-in on the server for compare only (an exception to rule 5),
   - read Instamart prices on the phone (slow, and takes over the screen),
   - leave Instamart out of compare and offer it only as "check in app".
2. **Play Store:** accessibility automation is fine for Firebase testers, but Google Play review will question it. Decide whether Scout stays on Firebase App Distribution, or gets a separate build for the Play Store without the service.
3. **Free registrations:** should Luma and Meetup RSVPs need Allow every time, or can the user turn on "register free events without asking"?

## Risks

- **App updates break scripts.** Mitigation: named step failures, fixtures, run logs with app version, and a quick fix-and-ship path through Firebase.
- **Screens the tree can't see** (canvas seat maps, some Compose or Flutter screens). Mitigation: the phase 0 gate, and hand-off at that step.
- **Price drift between the website and the app.** Mitigation: rule 4 (check again, `maxPrice`, `needs_approval`).
- **The user's phone is busy** for 10 to 30 s per run. Mitigation: clear notification, tap to stop, one run at a time.
