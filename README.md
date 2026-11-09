# Scout

A personal assistant for India. Ask in Hindi, English, or Hinglish, by typing or by mic, and Scout finds events, compares grocery prices, and drives a real browser to register or reach the pay screen. Payment always happens in your own UPI app.

**Live:** [scout.shrianshjaiswal.me](https://scout.shrianshjaiswal.me)

**Source:** this tree is on GitHub branch [`feature/screen-intelligence`](https://github.com/SJ2006-stack/scout/tree/feature/screen-intelligence), pushed Nov 9, 2026. It is not merged to `main`. Azure is `form1-20261109`. The Android app in this commit is 0.9.6.

This repository is the server and the web app. The Android companion app (microphone, phone actions, UPI handoff, push) is the Gradle project in `android/`, with its own README. It is not part of the Docker image.

## What it does

- **Events:** searches Luma, District, and BookMyShow, shows cards with date, price, and drive time, and compares those listings. When the phone can drive an app, it opens the cheaper listing there and stops before payment. Otherwise it registers on Luma, and clicks through to the pay screen on the others.
- **Shopping:** opens Blinkit, Zepto, and Instamart in the browser worker, reads live prices, picks the cheapest, and hands back a UPI link or QR. When the page lists several ghee brands, Scout asks which pack, with the asked brand first and the others after it. A drink ad is left out. One leftover pack is still a yes or no. A size written in brackets, such as Gowardhan Ghee (500 g), is searched without the brackets. On Azure as `form1-20261109`. Not tried from the phone since this update.
- **Buses and flights (local, not on Azure):** a bus trip scrolls redBus, ixigo, Goibibo, and ConfirmTkt until a departure in the asked part of the day is loaded. A flight cites Google Flights, and MakeMyTrip, Goibibo, Cleartrip, ixigo, and EaseMyTrip when both cities have an airport code. Scout does not book or pay.
- **Voice:** a mic button records a clip and Gnani Prisma transcribes it. The composer also has an attachment button and, in the Android app, Understand my screen, shown as a phone icon. There is no live call, and Scout does not read replies aloud.
- **Phone layout:** below 800px the message field spans the dock and the attach, screen, mic, and send controls sit underneath it. Cards use a full-width action, and the menu is a rounded sheet. The progress trace says when a message went to Event Scout and when it is fetching Luma, District, and BookMyShow. Opening that trace on a phone-width screen shows the system prompt and the tools Event Scout has. A direct fetch says the prompt was not sent to the model. On Azure as `novoice-20261109`. Not tried from the phone since that update.
- **Memory:** remembers your name, city, diet, budget, and other preferences, and shares them with every agent. Refuses to store OTPs, PINs, passwords, and card numbers.
- **Scout Watch:** recurring event checks that send only new matches to your inbox and phone.
- **Phone actions:** alarms, timers, reminders, flashlight, volume, maps, sharing, and opening apps, carried out by the Android app.
- **Screen Intelligence:** in the Android app, Understand my screen records a short clip and types into the app you opened. It fills name, email, phone, and details from the command. It taps Submit only if you asked, and it does not tap Pay. Text written on the screen is not a command. `POST /api/screen/understand` and `POST /api/ocr` both ask Sarvam `gemma4` (the same `SARVAM_API_KEY`; `sarvam-105b` is text only and rejects an image). A screenshot comes back as structured facts. An attached photo comes back as the writing on it. Without a prior command, the reading stays context and Scout does not act. This is on Azure as `record1-20261109`. The clip itself needs the Firebase 0.9.5 app. Not tried on the phone since this update.
- **Scout Drop (on Azure since Nov 8, 2026):** share text, a link, or up to 4 images from any Android app to Scout. Once the signed-in chat is showing, a "Shared to Scout" card sits above the message field (`src/web/ScoutDropCard.tsx`, `src/web/scoutDrop.ts`, checks in `src/shared/scoutDrop.ts`). The text can be edited, links are shown but not opened, and images can be removed. Send reads each image through the existing `/api/ocr` (`readAttachment`), adds that text after the note, and sends it as a normal chat message. Discard deletes it. Nothing is uploaded before Send, and the share is held in memory only, never in local storage. The Android side is described in `android/README.md`.

## Agents

One codebase serves every agent. `SCOUT_AGENT` pins a process to one, and each has its own host (`src/shared/hosts.ts`).

| Agent | Status | What it does |
| --- | --- | --- |
| Main | Chief | The phone talks to Scout. Scout assigns Event, Shop, Food, Travel, Home, and Appointments, and their work comes back in the same chat |
| Event | Live | Luma, District, BookMyShow search; Luma registration; Book to the pay screen |
| Shop | Live with the browser worker | Live prices on Blinkit, Zepto, Instamart. Real carts on Blinkit and Zepto up to your approval and the UPI handoff. Without the worker, only the simulated catalogue answers |
| Food | Simulated | Dishes on a simulated menu and an order review |
| Appointments | Simulated | Requests a simulated salon time |
| Travel | Not connected | Talks through a trip. No live fares |
| Home | Not connected | Plans with you. No service attached |

## How it works

### A chat turn

1. The web app posts to `POST /api/chat` and reads Server-Sent Events.
2. Sarvam `sarvam-105b` runs a tool loop of at most 4 rounds with low reasoning (`src/server/sarvamChat.ts`, `src/server/eventChat.ts`, `src/server/specialistChat.ts`). It keeps the earlier messages in the chat. A greeting is answered, not searched. Without `SARVAM_API_KEY`, a keyword parser answers instead and still says what it found. Attached images are read by Sarvam `gemma4` in `src/server/ocr.ts`.
3. The reply streams into the chat. Speech can start on the first sentence.
4. A source that fails leaves the other cards on screen. Failures are never cached.

Event sources:

- **Luma:** the public discovery feed.
- **District:** the public events and movies pages.
- **BookMyShow:** the browser worker reads `in.bookmyshow.com/explore/movies-<city>` and `/explore/events-<city>` and parses the JSON-LD lists in them (10 movies and 10 events per page). BookMyShow blocks datacenter addresses and the stripped headless shell, so these reads use full Chromium and go through the user's phone relay when it is connected. Without the browser worker there is no BookMyShow source.
- **District:** if the plain request gets a 403, the same browser-worker read is used.
- Movies have no showtime in either source, so they count as now showing on any day, including single-day searches like "tomorrow". If that day has no listings at all, the next upcoming ones are shown and named as next up, not as that day. A follow-up that only moves the day, such as "what about the next weekend", searches that window in the city already in the chat. "Aside from comedy" leaves comedy out and does not fill that day with undated movies. On Azure as `novoice-20261109`. Not tried from the phone since that update.
- Listings are cached for 10 minutes (`LISTING_CACHE_TTL_MS`). Drive time needs `GOOGLE_MAPS_API_KEY`.

### Booking and payment

Book opens the listing in the browser worker, fills Luma registration forms from your profile, clicks through to the pay screen, and returns a UPI deeplink, a QR code, or the pay page. The Android app opens your UPI app with it. If a site asks you to sign in first, Scout currently falls back to opening the page. Details and limits are in [`docs/booking.md`](docs/booking.md).

### Quick commerce (Shop)

- **Compare:** `compare_shops` opens Blinkit, Zepto, and Instamart at the same time in new-headless Chromium with an Indian desktop profile (en-IN, Asia/Kolkata). Only products whose names contain every query word count, and the summary gives the cheapest match per store. Measured locally on Oct 31, 2026: 6 to 8 s for all three. One comparison runs per chat message; extra calls share its result.
- **Estimated totals (local, not deployed):** after the compare, `quoteOffers` in `src/shared/cartQuote.ts` takes each store's cheapest offer and adds that store's handling, delivery (zero at or above its free-delivery level), and other fees, then ranks the stores by total. The fees start from bills read on the test phone (`STARTING_FEES`) and are replaced by medians of the user's own bills once there are any. The phone time per store is the median of the last five runs, else `STARTING_PHONE_MS` (Blinkit 17 s, Zepto 12 s, Instamart 17 s, cold runs measured Nov 6). The tool result gets `estimates` and `best`, the chat gets a status line and an `estimate` event (an "Estimated totals" card), and the model is told to fill only the best store's cart. Every completed `app_cart_add` result posted to `POST /api/actions/result` with items added and a total read is saved by `CartBillStore` (`src/server/cartBills.ts`, table `cart_bills`, last 20 per user and store). The phone card shows the usual time while waiting and, after the run, its time, the estimate against the real bill, and another store that the estimate says is cheaper. That comparison is skipped when the unit count differs from the estimate or when the cart had other items.
- **Question-back (local, not deployed):** every scout's tool list includes `ask_user` (`src/server/questionBack.ts`), and the shared assistant prompt tells the model to use it instead of guessing or asking in prose. It emits a `form` chat event (the same card as Main Scout's errands) and saves the questions in `pendingForms` (per user, at most 4 cards, 30 minutes, each answered once, in process memory). Both chat loops end the turn right after an `ask_user` call (`askedUser` in `src/server/toolLoop.ts`). `picksFromProse` turns a final reply that asks a question with 2 to 6 short choices (bulleted, or inline "A, B, or C") into the same card. `POST /api/chat` with `answers` goes to `resumeForm` in `chatRun.ts`: an errand card fills Main Scout's plan (`runAnsweredErrands`), and an `ask_user` card goes to the scout that asked as one message listing each question and answer (`answersMessage`).
- **This chat's history:** each `POST /api/chat` sends `history`, the lines of that chat only (`historyFromTurns` in `src/shared/chatHistory.ts`: what you said, Scout's replies and notes, a form's tasks, a phone-action summary, a listing title). The model and the errand planner use those lines instead of a shared 12-line scratchpad. Deleting the chat removes them, because the next message no longer sends them. A chat longer than 80 lines or 16,000 characters keeps the newest part. On Azure in `novoice-20261109`. Not tried from that update.
- **Main Scout errands (local, not deployed):** `runMainScout` in `src/server/mainScout.ts` runs first on the Main agent when the message has an errand word (`ERRAND_WORDS`). `planErrands` in `src/server/errands.ts` splits the message into `groceries`, `events`, `whatsapp`, `bus`, `flight`, and `other` errands with Sarvam `sarvam-105b` and a forced `plan_errands` tool call (`tool_choice: "required"`, reasoning off, a looser schema because Sarvam stalls on null unions). `groundPlan` clears a city, time, bus start, or placeholder message the user did not say. `questionsFor` builds the question bank (at most 8), sent as one `form` chat event; the web answers with `answers: {formId, values}` on `POST /api/chat`, and `PendingPlans` keeps the plan per user for 30 minutes. `runErrands` starts every errand together and posts each answer as that errand finishes. A shop compare and a bus check each take a browser slot (`BROWSER_MAX_LANES`, default 3) instead of waiting in one line: groceries through `shopErrand` (one item uses the three-app price check, several items use the basket compare; "buy it" later goes to `orderPendingBasket`). A price question on Blinkit, Zepto, Instamart, or the quick commerce apps stays a grocery even when the planner marks it other (`groceryFromQuestion`). A grocery compare does not keep Blinkit, Zepto, or Instamart search links. A WhatsApp number keeps `https://wa.me/<number>` as a `places` chat event so that chat can be opened again. Events go through `listEvents` in `chatRun.ts` (a follow-up that asks for any other, or for more except what was just shown, searches once and leaves those listings out; if nothing new is listed, Scout says so and does not repeat the cards; two copies of the same event search are collapsed; this check is on Azure as `order1-20261109` and has not been tried from that update), WhatsApp through the `send_whatsapp` phone action (`fitWhatsApp` keeps it under 500 characters at a line break), and buses through `BrowserWorker.compareBuses`. An `other` errand (an alarm, a reminder) runs through Main Scout's own chat loop and phone tools (`runOther`), and each errand posts a "Done N of M" status as it finishes. Agent-checked locally on Nov 6 (plan 2.5 s, four errands together 20 s, no WhatsApp sent). Not tried by the user.
- **Bus compare (local, not on Azure):** `src/server/browser/buses.ts` opens the same day's search on redBus, ixigo, Goibibo, and ConfirmTkt. redBus is `https://www.redbus.in/bus-tickets/{from}-to-{to}?onward=DD-Mon-YYYY` and is read from each row `aria-label`. The other three are read from a departure time and a rupee fare written near each other. The worker scrolls each page until a departure in the asked window is loaded, or the list stops moving, so an evening trip is not judged from the first morning rows. `busesInWindow` keeps that window and seats left, cheapest first. The card links each site. Scout does not book. AbhiBus is not read; its search needs the site's own route id. On Azure, `redbus.in`, `ixigo.com`, `goibibo.com`, and `confirmtkt.com` must be in `BROWSER_ALLOWED_HOSTS`.
- **Flights (local, not on Azure):** a flight errand opens Google Flights from the city names, and MakeMyTrip, Goibibo, Cleartrip, ixigo, and EaseMyTrip when both cities have an airport code in `src/server/browser/flights.ts`. The card cites every search. A fare is shown only when the page text has a price next to a departure in the asked window. Scout does not book or pay. On Azure, `google.com`, `makemytrip.com`, `goibibo.com`, `cleartrip.com`, `ixigo.com`, and `easemytrip.com` must be in `BROWSER_ALLOWED_HOSTS`.
- **Basket (local, not deployed):** `compare_basket` and `order_basket` in `src/server/specialistChat.ts`. `readBasket` in `src/server/basket.ts` reads 2 to 6 items (with counts such as "2 Maggi" or "eggs x 2") from one message, and `readBuy` reads a go-ahead ("buy it", "yes", "order it on Zepto"). The server runs these tools itself when it sees either, and the model only writes the reply; an `order_basket` call in the same turn as a compare is refused. "Order from Zepto then" is an order of the last comparison, not a new search: the phone opens that store and fills the cart, then stops before payment. A one-item compare is kept for that order too. This order check is on Azure in `novoice-20261109` and has not been tried from that update. `BrowserWorker.compareBasket` opens one page per store and reads each item in turn, the stores in parallel. `planBasket` picks each store's cheapest offer of the asked size, `quoteBasket` in `src/shared/cartQuote.ts` adds fees once per cart and ranks by missing items, then total, then phone time (first item at the store's usual time, then `EXTRA_ITEM_MS` = 6 s each, unmeasured). `BasketMemory` keeps the last plan per user for 30 minutes and forgets it after an order or a single-item compare, so `order_basket` sends one `app_cart_add` with every item and its product link without the model copying them. Shelf search sends stores the words without the size (`searchTerms`) and filters by size; Instamart offers show no size, so a size never rules them out. A grocery compare does not put Blinkit, Zepto, or Instamart search links in the chat. Bare tea, bread, butter, salt, jam, milk, chips, or juice asks which kind first, then the browser worker searches that answer.
- **Product reference:** every Blinkit, Zepto, and Instamart offer stores a ProductRef (store, name, size, price, and the product link and id when the page shows them). Blinkit links keep `https://blinkit.com/prn/<slug>/prid/<id>`. `www.blinkit.com` is rewritten, because www opens Chrome, and the placeholder slug `x` is not stored as a link. Zepto links use `https://www.zepto.com/pn/<slug>/pvid/<uuid>`. An Instamart link is saved only when the page HTML contains `/instamart/item/<id>` or `instamart.in/item/<id>`. The live Instamart search HTML does not include that id, so those refs leave the link and product id empty. Sizes are normalised (g, gm, grams, kg, ml, l, pcs).
- **Buy:** `buy_from_shop` (Blinkit, Zepto, or Instamart) starts a task: sign in with your phone and an SMS code if the store asks, open the search, type your pincode into the store's location box (or use the device location), add the item, open the cart, and read the bill. A card in the chat shows each step, a code box, the cart with fees and total, and Approve. Scout presses the store's pay control only after you approve that exact cart, then the UPI link goes to your phone. "I have paid" checks the store's orders page.
- **Instamart** carts are enabled but untested past sign-in. Instamart shows search results only to a signed-in Swiggy account, so the task signs in first (the account button, then "Log in with phone number"). Earlier its product grid exposed no add button by name; that may still stop the add step.
- **Blinkit sign-in:** Blinkit's "Login" is plain text and its login dialog marks the page body `aria-hidden`. The page reader keeps short "Login"/"Sign in" labels as `text` controls and removes `aria-hidden` from the body before each read. Shop tasks set the delivery location before signing in.
- **Sign-in waits:** stores draw their login controls after the page loads, later still through the relay, so sign-in waits up to 8 s for a control it recognises before giving up.
- **Connectors:** Settings lists the sites each Scout signs in to (Shop: Blinkit, Zepto, Instamart. Event: BookMyShow, District, Luma) from `GET /api/browser/scout/sessions`. Connect starts `POST /api/browser/scout/tasks` with `action: "sign_in"`, using the account's phone number or Gmail. The task card shows the code box; the Android app fills it from the SMS notification. Disconnect calls `POST /api/browser/scout/sessions/revoke`.
- **Guest carts:** Blinkit shows the full bill to a guest; Zepto shows only the item total until you sign in. Scout never asks you to approve a total the store has not shown.
- **Ready to pay:** after a cart or booking result is in the chat, one ready-to-pay row is pinned per store or event app. Pay calls the Android `open_checkout` bridge, which brings that app forward or opens its cart link with the package set. The user taps Place Order. Scout never taps Pay or Place Order. Instamart has no app-claimed cart link, so Pay only brings Swiggy forward. Blinkit uses `https://blinkit.com/cart`; a cold start launches the app because that link drops. Opened and paid marks stay in local storage under `scout-pay-ready-v1`. Bookings show a 10-minute hold because the phone result has no timer. This build has not been installed on the phone.
- Live probes: `scripts/shopCompareProbe.ts` and `scripts/shopCartProbe.ts` (`HEADED=1` shows Chrome). The cart probe stops before sign-in.

### Voice

- **Mic button:** records a clip of at most 30 seconds and posts it to `POST /api/voice/stt`, which calls Gnani Prisma `prisma-v3.0` in `codemix` with `language_code=indic-auto`, so English words stay in English letters. A browser recording that is not wav, mp3, mp4, ogg, or flac is turned into wav first, because Prisma does not take webm. In the Android app, the page asks `window.ScoutNative` to record natively (AAC, already capped at 30 seconds) and posts to the same route. Scout does not read replies aloud, and there is no live call.

### Phone actions

Any agent can call `phone_action`. The server validates it (`src/shared/deviceActions.ts`), emits a `device` event, the page hands it to the Android app, and the result comes back on `/api/actions/result`. Opening apps, sharing, a WhatsApp message (`send_whatsapp`: a number opens that chat by link, a name searches for one exact chat, and the phone taps Send when accessibility is on), and muting ask for Allow on the phone first. In a normal browser, Scout says the phone app is needed.

`app_cart_add` and `app_event_book` accept only https links on each app's own host, and they always ask for Allow. The chat card updates from the phone's report after money, counts, and text are clamped. `buy_from_shop` remains when the phone does not report automation on. The phone app now has this Accessibility service in a local debug build. That build can add Blinkit, Zepto, and Instamart items. Shop Scout compares those three, then `app_cart_add` uses the cheapest offer, including an Instamart offer whose link is missing. Event Scout compares Luma, District, and BookMyShow listings, then `app_event_book` opens the cheaper one and stops before checkout, pay, register, or Book tickets. It does not pick seats. That phone build is 0.9.2, sent to the Firebase tester on Nov 5, 2026, and not yet tried from that update. The compare-then-phone chat is on Azure as of `phone1-20261105`. Instamart stops when the cart says "Add address to proceed".

Local only, not deployed (Nov 6, 2026): the Book button on an event card sends `app_event_book` to the phone when that event app is installed (`appInstalled`), even if the accessibility service is off. The phone opens the listing. It falls back to `/api/pay` only when the app is not installed. Shop Scout gives the model only the 3 cheapest offers per store (`modelOffers`), because Sarvam returned an empty reply when it got 40 or more. If the model still returns nothing after `compare_shops`, the chat says the compare summary instead of "I checked." The cart reason `location_off` means the store needs phone Location turned on.

Also local only (Nov 6, 2026): Event Scout sends listings past the first three as a `more` chat event, which the page shows behind a "Show N more listings" button, at most 21. The model's search result lists up to 8 of them as `more` (title and price) with `moreCount`, and the chat memory keeps their titles. Sarvam replies get 2048 tokens, and a reply that stops on the limit is cut back to its last whole sentence (`wholeSentences`). For a BookMyShow or District movie, `app_event_book` with `ref.venue` (the cinema) and `showtime` goes to the seat map on the phone; without a showtime the phone stops on the showtimes (`reason: "showtimes"`) and lists them in its message. For a District event it picks the day and slot from `showtime` and the cheapest ticket type within `maxPricePerTicket`, and reports `checkout_ready` with `total`; without a showtime it reports `dates`. A District event card's Book button sends the listing's start as `showtime` when it is still ahead (`listingBook.ts`). Luma reports `form` with the registration screen open. The phone card reads "Ready to pay" for `checkout_ready` and "Ready to register" for `form`.

### Browser worker

A Playwright Chromium worker, off until `BROWSER_WORKER_ENABLED=1`.

- Only public https hosts. Private, loopback, link-local, and metadata addresses are blocked, including after DNS lookup. A host check that takes longer than 4 s counts as not public. `BROWSER_ALLOWED_HOSTS` narrows the list further.
- A click or fill stops after 10 s, a registration step after 30 s, and one operation after `BROWSER_OP_TIMEOUT_MS`. A second request for the same event joins the running one.
- Saved sign-ins are AES-256-GCM encrypted browser state per user and per site (`BROWSER_PROFILE_KEY`), stored under `sites/`. A site's cookies are kept only after the page shows a signed-in state.
- One-time codes go through an in-memory broker: each challenge has a single-use token bound to the user, task, site, and their Android devices, expires in 5 minutes, and is never written to disk or logs.
- Checkouts are recorded with a fingerprint of the cart (`checkouts.json`). Pay is pressed only for the approved fingerprint, once per idempotency key, and never if the total changed. Autopay, mandate, and PIN controls are never pressed.
- Headless runs use full Chromium's new headless mode (`channel: "chromium"`). Zepto renders a blank page and Swiggy a block page for the old headless shell. If full Chromium is missing, it falls back to the shell.
- Pages nobody watches skip images, fonts, and media.

A central-browser layout (one Chromium for all six sites, with admission limits and signed tickets) is written but staging only and unmeasured. See [`docs/browser-worker.md`](docs/browser-worker.md).

### Accounts and storage

- Sign-in is Google only; the email-code routes are gone. The page opens a Google popup through the Firebase web app "Scout Web" (`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_APP_ID`). The Android app uses its own Google sign-in, and the page inside the app sends "Continue with Google" and Sign out back to it through the `sign_out` bridge op. Both post the Firebase ID token to `POST /api/auth/google`, which checks it (`FIREBASE_PROJECT_ID`, default `scout-b4da3`) and opens that Gmail's account. Google only lets the popup run on the authorized domains in Firebase Auth. Right now that is `localhost` and the Firebase domains, so use `http://localhost:8787` locally, not `127.0.0.1`.
- Onboarding after Google: `/api/onboarding/phone`, then `/api/onboarding/name`, then `/api/onboarding/about`. The about step takes city, home pincode, food (one or more of veg, eggetarian, non-veg, vegan, Jain), what they go out for (music, comedy, movies, theatre, workshops), and reply language (English, Hinglish, Hindi). The about page scrolls on a phone. Every answer is optional, and an empty body skips. Answers are saved as explicit preferences (`city`, `home_area`, `diet`, `event_kinds`, `language`), which every scout reads in its prompt. Several food choices are stored together, in that order, such as `Vegetarian, Jain`. A pincode with no city fills in the city when it is a known one. When a chat arrives with no location, the saved home pincode is used instead. The session reports `onboarded`, set once the step is saved or skipped. Accounts made before this see the step once. In the Android app, after those steps, the page stays on Turn on Accessibility until Scout's accessibility service is on. There is no skip. The button opens Android's Accessibility settings on a build that has the `accessibility` bridge op, and otherwise opens the in-app permissions list so they can tap Automation. Turning the service off later brings that same screen back. A browser that is not the app skips it.
- Users, chat memory, the profile, Scout Watch, the inbox, push devices, and browser sessions live in SQLite (`SCOUT_DB_PATH`, default `.data/scout.sqlite`).
- Saved addresses, rate limits, the simulated commerce hub, payment approvals, and pair tickets are in memory and reset on restart.

## Run it locally

Requires Node 22.6 or newer. TypeScript runs directly through Node's `--experimental-strip-types`, with no compile step for the server.

```bash
npm install
cp .env.example .env                  # fill in the keys you want
npx playwright-core install chromium  # only for the browser worker
npm run dev                           # http://127.0.0.1:8787
```

While testing in a desktop browser on this machine, open `http://127.0.0.1:8787/api/dev/session`. That sets a cookie for the shared local account `scout.localtest@gmail.com` and skips the Gmail and phone code screens. The phone does not use that route. Each Google account gets its own user. The route exists only in the dev server (`src/server/index.ts`), which listens on localhost, and it is not in the production server.

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm test` | Node's test runner over `test/*.test.ts` |
| `npm run build` | Vite build of the web app into `dist/` |
| `npm start` | Production server (`src/server/prod.ts`) |
| `SCOUT_SESSION=<scout_session> node --experimental-strip-types scripts/relayDevice.ts <origin>` | Stands in for the phone relay: store traffic from that server's Chromium leaves from this machine. Reconnects on drop. Keeps sealed sign-in copies in `SCOUT_DEVICE_VAULT` (default `~/.scout-test/vault`) |

## Configuration

Every setting is listed with comments in [`.env.example`](.env.example). The main ones:

| Variable | Meaning |
| --- | --- |
| `GNANI_API_KEY` | Mic transcription with Gnani Prisma `prisma-v3.0`. Empty and the mic stays quiet |
| `SARVAM_API_KEY` | Conversation and errand planning (`sarvam-105b`, reasoning off for the planner), and attached photos plus screenshots (`gemma4`, because 105B does not accept images). Empty chat uses the keyword parser, and image reading is off |
| `GOOGLE_MAPS_API_KEY` | Drive time and addresses |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Optional Gmail and Drive connect. Consent asks for Gmail read, send, archive, and trash, and full Drive read and write. Empty leaves Connect off |
| `GOOGLE_OAUTH_REDIRECT_URI` | Exact callback registered on that client, such as `https://scout.shrianshjaiswal.me/api/google/callback`. Empty uses the request host |
| `SCOUT_AGENT` | Pins the process to one agent. Empty means the chief |
| `SCOUT_ROLE` | `browser` runs the Chromium-only process |
| `BROWSER_WORKER_ENABLED` | `1` starts the browser worker |
| `BROWSER_PROFILE_KEY` | 64 hex characters for encrypted sign-in |
| `FIREBASE_PROJECT_ID` | Firebase project whose Google sign-in tokens are accepted. Defaults to `scout-b4da3` |
| `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_APP_ID` | Firebase web app config for the page's Google popup. Read at `npm run build`, so set them before building the image. Public client values, kept out of git |
| `FIREBASE_DISTRIBUTION_*` | Android install invite from the landing page |
| `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` | Push for Scout Watch |
| `RELAY_CAP_MB` | Bytes one phone relay connection may carry. Default 300 |
| `SCOUT_DEVICE_VAULT` | `scripts/relayDevice.ts` only: folder for sealed sign-in copies |

Never commit `.env`, keys, or publish profiles.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Liveness and the pinned agent |
| `POST /api/chat` | Chat turn over SSE. An optional `answers: {formId, values}` answers a question card from any scout |
| `POST /api/demo` | Replay the prepared sample |
| `POST /api/search` | Grocery price search |
| `POST /api/commerce`, `POST /api/pay` | Food, shop, appointments, and the payment gate |
| `POST /api/voice/stt` | Gnani Prisma speech in for the mic button |
| `/api/profile`, `/api/watches`, `/api/inbox`, `/api/devices`, `/api/actions/result` | Memory, Scout Watch, notifications, push devices, phone action results |
| `POST /api/ocr` | Read the writing in an attached image with Sarvam `gemma4` |
| `POST /api/screen/understand` | Read one screenshot into structured facts. Does not change `/api/ocr` |
| `/api/auth/*`, `/api/onboarding/*` | Google sign-in, phone, name, about you, then optional Gmail and Drive (`POST /api/onboarding/accounts` finishes onboarding) |
| `/api/google/connections`, `/api/google/connect`, `/api/google/disconnect`, `/api/google/callback` | Optional Gmail (`gmail.modify`) and Drive (full access) sign-in. The refresh token is encrypted with `BROWSER_PROFILE_KEY` |
| `/api/addresses`, `/api/location/reverse-geocode` | Saved addresses and address lookup |
| `/api/browser/*` | Browser sessions, handoff, codes, profile, budget |
| `/api/browser/scout/*` | Website tasks: `skills`, `sessions` (saved site sign-ins, revoke), `tasks` (`sign_in` or `shop` with `area`, `latitude`, `longitude`), `checkouts/:id/approve` and `/confirm`, `challenges/:id/code` |
| `GET /api/relay` (WebSocket), `GET /api/relay/status` | Your device's relay for store traffic (Blinkit, Zepto, Swiggy hosts, port 443), and whether it is connected. The same socket copies sealed site sign-ins to the device and takes them back after a server wipe (`src/server/relay/vaultMirror.ts`) |
| `GET`, `PUT`, `DELETE /api/account/phone` | Your phone number, masked, with the date a site last verified it; edit or remove it |
| `/api/desk`, `/api/pair` | Phone companion desk and pairing |
| `/api/invite` | Android install invite through Firebase App Distribution |

## Deploy

Azure App Service runs the `scout-site` container from `sjscoutacr.azurecr.io`, which includes Chromium. Six apps share one P1v3 Linux plan: `sj-scout`, `sj-event-scout`, `sj-shop-scout`, `sj-food-scout`, `sj-travel-scout`, `sj-home-scout`.

```bash
npm run build
az acr build -r sjscoutacr -t scout-site:<tag> -f deploy/site.Dockerfile .
az webapp config container set -g ledger-rg -n <app> \
  --container-image-name sjscoutacr.azurecr.io/scout-site:<tag>   # repeat for all six apps
```

- The image copies the prebuilt `dist/`, so run `npm run build` first. Build from a clean checkout so uncommitted work stays out.
- The apps are pinned to a tag, not `latest`, so a restart alone keeps the old build. Now all six run `form1-20261109` (`sjscoutacr.azurecr.io/scout-site:form1-20261109`, digest `sha256:701028f4eb19f9df00026fa6c2587e07e0ff4ec61ba930d051ed36e24bb7c68e`), built on Nov 9, 2026 from the working tree on top of `82baf5d`, not from a clean commit. `linuxFxVersion` on each app is `DOCKER|sjscoutacr.azurecr.io/scout-site:form1-20261109`. The image was pushed at 11:31 UTC. `GET /api/health` returned `{"ok":true,"agent":"main"}`. `https://scout.shrianshjaiswal.me/chat` is serving `assets/index-KAHjifZK.js`. While Understand my screen is recording, the Android app types into the open form. The app that does that is Firebase 0.9.6 (versionCode 20), sent Nov 9, 2026. Not tried on the phone since this update. In the Android app, onboarding stays on Turn on Accessibility until Scout's accessibility service is on. Onboarding asks for optional Gmail and Drive with read and write access. Connect stays off until `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` are set, and `https://scout.shrianshjaiswal.me/api/google/callback` is registered on that client. A size in brackets, such as Gowardhan Ghee (500 g), is searched as Gowardhan Ghee. Govardhan and the other ghee brands on the page are listed, and Scout asks which pack. A drink ad is left out. Book on an event card opens District, BookMyShow, or Luma on the phone when that app is installed. The Bolna call, spoken replies, and the `BOLNA_*` app settings are gone. "Aside from comedy" shows the other dated events and leaves undated movies out of that answer. When a shop search lists products and none match the asked size, Scout asks about a listing that shares the brand. Conversation and errand planning use Sarvam `sarvam-105b`. Attached photos and screenshots use Sarvam `gemma4`. The Claude app setting was removed. Tomorrow in Delhi shows movies that are on now, and "what about the next weekend" searches that weekend. The phone-width progress trace names Event Scout and shows its prompt and tools. The image still has the order-sentence fix, the "any other" event check, and this chat's own history. A grocery compare still shows the prices and does not lead with store search links. Bare tea, bread, butter, salt, jam, milk, chips, or juice still asks which kind first. The image also has the scrolling about page, Google sign-in, Scout Drop, `POST /api/ocr`, and `POST /api/screen/understand`. Android changes are not in it. `scratch/` is left out of the image context.
- The website Google popup still refuses on Azure until `scout.shrianshjaiswal.me` and each `sj-*.azurewebsites.net` host are added to Firebase Auth's authorized domains (Firebase console, Authentication, Settings). The Android app does not use that popup. Build with `VITE_FIREBASE_*` set in `.env`. `AGENTMAIL_*` app settings are no longer read.
- The relay needs WebSockets on: `az webapp config set -g ledger-rg -n <app> --web-sockets-enabled true` (on for all six apps).
- Do not zip deploy. It switches the apps to the Node stack, which has no Chromium.
- `.github/workflows/deploy.yml` only installs, tests, and builds. Pushing the image is manual.
- `deploy/browser-worker.Dockerfile` is the Chromium-only process. It refuses to start without `BROWSER_PROFILE_KEY` and `BROWSER_ALLOWED_HOSTS`.

## Project layout

```
src/
  server/          HTTP API, chat loops, prompts, SSE, auth, payments gate, landing page
    browser/       Playwright driver, host policy, worker, shop shelves, sign-in, budget
    events/        Luma, District, and listing page parsers
    tools/         Tools Sarvam can call (Luma, District, BookMyShow)
    voice/         Gnani speech in for the mic button
    memory/ profile/ watch/ notify/   SQLite memory, shared profile, Scout Watch, inbox and FCM push
    commerce/ appointments/ payments/ Simulated hub, salon requests, payment gate and sandbox
  shared/          Types and rules shared by server and web (events, hosts, device actions)
  web/             React 19 app (chat, cards, composer, settings)
test/              Node test files (node:test)
scripts/           live shop probes
deploy/            Site and browser-worker Dockerfiles
docs/              Booking and browser worker notes
scout-landing/     Public landing page served by the server
```

## Known limits

- Sites that ask you to sign in before booking (BookMyShow, District) stop the Book flow, and Scout opens the page instead.
- The Blinkit and Zepto sign-in, payment, and order-check steps are tested against a local fixture store, not yet against the live sites with a real phone. The live search, location, add-to-cart, and bill steps were checked on Oct 31, 2026.
- Instamart carts are untested past sign-in.
- The phone cart and book contract and the pay tray are untested on a phone. Android 0.9.2, sent to the Firebase tester on Nov 5, 2026, can add Blinkit, Zepto, and Instamart items and open an event without paying. It has not been tried from that update. Instamart stops when the cart says "Add address to proceed". The `open_checkout` path is in that build and has not been tried.
- On Azure, store pages only load while your relay is connected. The Android app runs that relay while it is open. 0.9.2 (build 16) is with the Firebase tester as of Nov 5, 2026, and has not been tried from that update.
- Store pages change. A changed button label stops the task with a message instead of guessing.
- Food and Appointments are simulated. Travel and Home are not connected.
- State kept in memory is lost on restart, so the server cannot run as more than one instance.
- Browser operations run one at a time per process.
- The central browser layout is a design with estimates, not deployed or measured.
