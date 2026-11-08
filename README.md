# Scout

A voice-first personal assistant for India. Ask in Hindi, English, or Hinglish, by typing, by mic, or on a live voice call, and Scout finds events, compares grocery prices, and drives a real browser to register or reach the pay screen. Payment always happens in your own UPI app.

**Live:** [scout.shrianshjaiswal.me](https://scout.shrianshjaiswal.me)

This repository is the server and the web app. The Android companion app (microphone, phone actions, UPI handoff, push) is the Gradle project in `android/`, with its own README. It is not part of the Docker image.

## What it does

- **Events:** searches Luma, District, and BookMyShow, shows cards with date, price, and drive time, and compares those listings. When the phone can drive an app, it opens the cheaper listing there and stops before payment. Otherwise it registers on Luma, and clicks through to the pay screen on the others.
- **Shopping:** opens Blinkit, Zepto, and Instamart in the browser worker, reads live prices, picks the cheapest, and hands back a UPI link or QR.
- **Voice:** a mic button for single clips, transcribed by Gnani Prisma, and a phone button for a live call through [Bolna](https://www.bolna.ai). The call still uses Sarvam speech, and spoken replies from the mic still use Sarvam. Scout is the call's LLM, so cards appear in the chat while you talk.
- **Phone layout:** below 800px the message field spans the dock and the attach, voice, mic, call, and send controls sit underneath it. Cards use a full-width action, and the menu is a rounded sheet. This is local only and has not been tried on a phone.
- **Memory:** remembers your name, city, diet, budget, and other preferences, and shares them with every agent. Refuses to store OTPs, PINs, passwords, and card numbers.
- **Scout Watch:** recurring event checks that send only new matches to your inbox and phone.
- **Phone actions:** alarms, timers, reminders, flashlight, volume, maps, sharing, and opening apps, carried out by the Android app.
- **Scout Drop (on Azure since Nov 8, 2026):** share text, a link, or up to 4 images from any Android app to Scout. Once the signed-in chat is showing, a "Shared to Scout" card sits above the message field (`src/web/ScoutDropCard.tsx`, `src/web/scoutDrop.ts`, checks in `src/shared/scoutDrop.ts`). The text can be edited, links are shown but not opened, and images can be removed. Send reads each image through the existing `/api/ocr` (`readAttachment`), adds that text after the note, and sends it as a normal chat message. Discard deletes it. Nothing is uploaded before Send, and the share is held in memory only, never in local storage. The Android side is described in `android/README.md`.
- **Screen Intelligence (local only, not on Azure):** in the Android app, Understand my screen asks Android for MediaProjection, holds one share session under a stoppable notice, and captures a single JPEG when the person taps Capture. A preview sits above the message field. Send for analysis posts to `POST /api/screen/understand` (separate from `/api/ocr`) and then the chat with that structured reading as context, not as a tool to run. Discard deletes the frame. Details are in `android/README.md`.

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
2. Sarvam `sarvam-105b` runs a tool loop of at most 4 rounds with low reasoning (`src/server/sarvamChat.ts`, `src/server/eventChat.ts`, `src/server/specialistChat.ts`). It keeps the earlier messages in the chat. A greeting is answered, not searched. Without `SARVAM_API_KEY`, a keyword parser answers instead and still says what it found. Attached images are still read by Claude Haiku (`claude-haiku-5-5` in `src/server/ocr.ts`) with `ANTHROPIC_API_KEY`.
3. The reply streams into the chat. Speech can start on the first sentence.
4. A source that fails leaves the other cards on screen. Failures are never cached.

Event sources:

- **Luma:** the public discovery feed.
- **District:** the public events and movies pages.
- **BookMyShow:** the browser worker reads `in.bookmyshow.com/explore/movies-<city>` and `/explore/events-<city>` and parses the JSON-LD lists in them (10 movies and 10 events per page). BookMyShow blocks datacenter addresses and the stripped headless shell, so these reads use full Chromium and go through the user's phone relay when it is connected. Without the browser worker there is no BookMyShow source.
- **District:** if the plain request gets a 403, the same browser-worker read is used.
- Movies have no showtime in either source, so they count as now showing on any day, including single-day searches like "tomorrow".
- Listings are cached for 10 minutes (`LISTING_CACHE_TTL_MS`). Drive time needs `GOOGLE_MAPS_API_KEY`.

### Booking and payment

Book opens the listing in the browser worker, fills Luma registration forms from your profile, clicks through to the pay screen, and returns a UPI deeplink, a QR code, or the pay page. The Android app opens your UPI app with it. If a site asks you to sign in first, Scout currently falls back to opening the page. Details and limits are in [`docs/booking.md`](docs/booking.md).

### Quick commerce (Shop)

- **Compare:** `compare_shops` opens Blinkit, Zepto, and Instamart at the same time in new-headless Chromium with an Indian desktop profile (en-IN, Asia/Kolkata). Only products whose names contain every query word count, and the summary gives the cheapest match per store. Measured locally on Oct 31, 2026: 6 to 8 s for all three. One comparison runs per chat message; extra calls share its result.
- **Estimated totals (local, not deployed):** after the compare, `quoteOffers` in `src/shared/cartQuote.ts` takes each store's cheapest offer and adds that store's handling, delivery (zero at or above its free-delivery level), and other fees, then ranks the stores by total. The fees start from bills read on the test phone (`STARTING_FEES`) and are replaced by medians of the user's own bills once there are any. The phone time per store is the median of the last five runs, else `STARTING_PHONE_MS` (Blinkit 17 s, Zepto 12 s, Instamart 17 s, cold runs measured Nov 6). The tool result gets `estimates` and `best`, the chat gets a status line and an `estimate` event (an "Estimated totals" card), and the model is told to fill only the best store's cart. Every completed `app_cart_add` result posted to `POST /api/actions/result` with items added and a total read is saved by `CartBillStore` (`src/server/cartBills.ts`, table `cart_bills`, last 20 per user and store). The phone card shows the usual time while waiting and, after the run, its time, the estimate against the real bill, and another store that the estimate says is cheaper. That comparison is skipped when the unit count differs from the estimate or when the cart had other items.
- **Question-back (local, not deployed):** every scout's tool list includes `ask_user` (`src/server/questionBack.ts`), and the shared assistant prompt tells the model to use it instead of guessing or asking in prose. It emits a `form` chat event (the same card as Main Scout's errands) and saves the questions in `pendingForms` (per user, at most 4 cards, 30 minutes, each answered once, in process memory). Both chat loops end the turn right after an `ask_user` call (`askedUser` in `src/server/toolLoop.ts`). `picksFromProse` turns a final reply that asks a question with 2 to 6 short choices (bulleted, or inline "A, B, or C") into the same card. `POST /api/chat` with `answers` goes to `resumeForm` in `chatRun.ts`: an errand card fills Main Scout's plan (`runAnsweredErrands`), and an `ask_user` card goes to the scout that asked as one message listing each question and answer (`answersMessage`).
- **Main Scout errands (local, not deployed):** `runMainScout` in `src/server/mainScout.ts` runs first on the Main agent when the message has an errand word (`ERRAND_WORDS`). `planErrands` in `src/server/errands.ts` splits the message into `groceries`, `events`, `whatsapp`, `bus`, and `other` errands with a forced `plan_errands` tool call: Claude Haiku first, then Sarvam with `tool_choice: "required"` and reasoning off (a looser schema, because Sarvam stalls on null unions). `groundPlan` clears a city, time, bus start, or placeholder message the user did not say. `questionsFor` builds the question bank (at most 8), sent as one `form` chat event; the web answers with `answers: {formId, values}` on `POST /api/chat`, and `PendingPlans` keeps the plan per user for 30 minutes. `runErrands` starts every errand together and posts each answer as that errand finishes. A shop compare and a bus check each take a browser slot (`BROWSER_MAX_LANES`, default 3) instead of waiting in one line: groceries through `shopErrand` (one item uses the three-app price check, several items use the basket compare; "buy it" later goes to `orderPendingBasket`). A price question on Blinkit, Zepto, Instamart, or the quick commerce apps stays a grocery even when the planner marks it other (`groceryFromQuestion`). Each shop item also keeps the three search links (`shopSearchPlaces`), and a WhatsApp number keeps `https://wa.me/<number>`, as a `places` chat event so those apps can be opened again. Events go through `listEvents` in `chatRun.ts`, WhatsApp through the `send_whatsapp` phone action (`fitWhatsApp` keeps it under 500 characters at a line break), and buses through `BrowserWorker.compareBuses`. An `other` errand (an alarm, a reminder) runs through Main Scout's own chat loop and phone tools (`runOther`), and each errand posts a "Done N of M" status as it finishes. Agent-checked locally on Nov 6 (plan 2.5 s, four errands together 20 s, no WhatsApp sent). Not tried by the user.
- **Bus compare (local, not deployed):** `src/server/browser/buses.ts` opens `https://www.redbus.in/bus-tickets/{from}-to-{to}?onward=DD-Mon-YYYY` in the worker's stealth launch (plain headless is blocked) and reads each bus from its row `aria-label` (operator, type, times, seats, price, rating). `busesInWindow` keeps the asked time of day and seats left, cheapest first, and the web shows a `buses` card with a "Book on redBus" link. Only the first rows redBus loads are read (about 10, with UPSRTC buses folded). Scout does not book. AbhiBus is not read. On Azure, `redbus.in` must be in `BROWSER_ALLOWED_HOSTS`.
- **Basket (local, not deployed):** `compare_basket` and `order_basket` in `src/server/specialistChat.ts`. `readBasket` in `src/server/basket.ts` reads 2 to 6 items (with counts such as "2 Maggi" or "eggs x 2") from one message, and `readBuy` reads a go-ahead ("buy it", "yes", "order it on Zepto"). The server runs these tools itself when it sees either, and the model only writes the reply; an `order_basket` call in the same turn as a compare is refused. `BrowserWorker.compareBasket` opens one page per store and reads each item in turn, the stores in parallel. `planBasket` picks each store's cheapest offer of the asked size, `quoteBasket` in `src/shared/cartQuote.ts` adds fees once per cart and ranks by missing items, then total, then phone time (first item at the store's usual time, then `EXTRA_ITEM_MS` = 6 s each, unmeasured). `BasketMemory` keeps the last plan per user for 30 minutes and forgets it after an order or a single-item compare, so `order_basket` sends one `app_cart_add` with every item and its product link without the model copying them. Shelf search sends stores the words without the size (`searchTerms`) and filters by size; Instamart offers show no size, so a size never rules them out.
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

- **Mic button:** records a clip of at most 30 seconds and posts it to `POST /api/voice/stt`, which calls Gnani Prisma `prisma-v3.0` in `codemix` with `language_code=indic-auto`, so English words stay in English letters. A browser recording that is not wav, mp3, mp4, ogg, or flac is turned into wav first, because Prisma does not take webm. `POST /api/voice/tts` still speaks with Sarvam `bulbul:v3`. In the Android app, the page asks `window.ScoutNative` to record natively (AAC, already capped at 30 seconds) and posts to the same route.
- **Live calls:** the phone button starts a Bolna web call (`src/web/voiceCall.ts`). Bolna handles the microphone, Sarvam speech recognition, the `bulbul:v4-flash` voice, and interruptions. Each agent is set up with Hindi and English, and Bolna switches when the caller changes language.
  - `POST /api/voice/bolna/session` mints a single-use call and passes a signed 45-minute ticket in the prompt. The Bolna key never reaches the browser.
  - `POST /api/bolna/v1/chat/completions` is an OpenAI-compatible streaming endpoint that Bolna calls for every turn. It picks the specialist (`src/server/voice/voiceRouter.ts`, sticky for 10 minutes), runs the normal Sarvam turn with a short spoken reply, and streams the words.
  - `GET /api/voice/live` streams that turn's cards and phone actions to the open chat.
  - Measured on a tunnel: first words in about 1 to 2 s. Measured once on Azure: about 2 s for an alarm request.

### Phone actions

Any agent can call `phone_action`. The server validates it (`src/shared/deviceActions.ts`), emits a `device` event, the page hands it to the Android app, and the result comes back on `/api/actions/result`. Opening apps, sharing, a WhatsApp message (`send_whatsapp`: a number opens that chat by link, a name searches for one exact chat, and the phone taps Send when accessibility is on), and muting ask for Allow on the phone first. In a normal browser, Scout says the phone app is needed.

`app_cart_add` and `app_event_book` accept only https links on each app's own host, and they always ask for Allow. The chat card updates from the phone's report after money, counts, and text are clamped. `buy_from_shop` remains when the phone does not report automation on. The phone app now has this Accessibility service in a local debug build. That build can add Blinkit, Zepto, and Instamart items. Shop Scout compares those three, then `app_cart_add` uses the cheapest offer, including an Instamart offer whose link is missing. Event Scout compares Luma, District, and BookMyShow listings, then `app_event_book` opens the cheaper one and stops before checkout, pay, register, or Book tickets. It does not pick seats. That phone build is 0.9.2, sent to the Firebase tester on Nov 5, 2026, and not yet tried from that update. The compare-then-phone chat is on Azure as of `phone1-20261105`. Instamart stops when the cart says "Add address to proceed".

Local only, not deployed (Nov 6, 2026): the Book button on an event card sends `app_event_book` to the phone when the phone reports it can drive that app (`src/shared/listingBook.ts`), and falls back to `/api/pay` otherwise. Shop Scout gives the model only the 3 cheapest offers per store (`modelOffers`), because Sarvam returned an empty reply when it got 40 or more. If the model still returns nothing after `compare_shops`, the chat says the compare summary instead of "I checked." The cart reason `location_off` means the store needs phone Location turned on.

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

- Sign-in on the web is an email code from an AgentMail inbox. The phone signs in with Google: `POST /api/auth/google` checks the Firebase ID token (`FIREBASE_PROJECT_ID`, default `scout-b4da3`) and opens that Gmail's account. Phone number and preferred name still come from `/api/onboarding/phone` and `/api/onboarding/name`.
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
| `npm run bolna:setup -- <https origin> [--agent <id>] [--save]` | Registers a site as a Bolna custom LLM and creates or updates its voice agent |
| `SCOUT_SESSION=<scout_session> node --experimental-strip-types scripts/relayDevice.ts <origin>` | Stands in for the phone relay: store traffic from that server's Chromium leaves from this machine. Reconnects on drop. Keeps sealed sign-in copies in `SCOUT_DEVICE_VAULT` (default `~/.scout-test/vault`) |

## Configuration

Every setting is listed with comments in [`.env.example`](.env.example). The main ones:

| Variable | Meaning |
| --- | --- |
| `ANTHROPIC_API_KEY` | Reads text from an attached image with Claude Haiku, reads a screenshot into structured facts (`/api/screen/understand`), and is Main Scout's first-choice errand planner. Empty leaves attachments and screenshots unread and plans with Sarvam |
| `GNANI_API_KEY` | Mic transcription with Gnani Prisma `prisma-v3.0`. Empty and the mic stays quiet |
| `SARVAM_API_KEY` | Conversation chat (`sarvam-105b`) and spoken replies (`bulbul:v3`). Empty chat uses the keyword parser and spoken replies stay quiet |
| `BOLNA_API_KEY`, `BOLNA_LLM_KEY`, `BOLNA_AGENT_ID` | Live voice calls. All three are needed |
| `GOOGLE_MAPS_API_KEY` | Drive time and addresses |
| `SCOUT_AGENT` | Pins the process to one agent. Empty means the chief |
| `SCOUT_ROLE` | `browser` runs the Chromium-only process |
| `BROWSER_WORKER_ENABLED` | `1` starts the browser worker |
| `BROWSER_PROFILE_KEY` | 64 hex characters for encrypted sign-in |
| `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID` | Email sign-in codes |
| `FIREBASE_PROJECT_ID` | Firebase project for the phone's Google sign-in. Defaults to `scout-b4da3` |
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
| `POST /api/voice/stt`, `POST /api/voice/tts` | Gnani Prisma speech in, Sarvam Bulbul speech out |
| `POST /api/voice/bolna/session`, `GET /api/voice/live` | Start a Bolna call and stream its cards to the chat |
| `POST /api/bolna/v1/chat/completions`, `GET /api/bolna/v1/models` | Scout as Bolna's LLM (bearer `BOLNA_LLM_KEY`) |
| `/api/profile`, `/api/watches`, `/api/inbox`, `/api/devices`, `/api/actions/result` | Memory, Scout Watch, notifications, push devices, phone action results |
| `POST /api/ocr` | Read text from an attached image with Claude Haiku |
| `POST /api/screen/understand` | Read a screenshot into structured facts (products, menus, events, forms, travel, app screens). Does not change `/api/ocr`. Local only; not on Azure |
| `/api/auth/*`, `/api/onboarding/*` | Email code sign-in, Google sign-in from the phone (`POST /api/auth/google`), name and phone |
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
- The apps are pinned to a tag, not `latest`, so a restart alone keeps the old build. Now all six run `drop1-20261108`, built on Nov 8, 2026 from a clean checkout of `2c650ed` (Scout Drop on top of `607030f`).
- The relay needs WebSockets on: `az webapp config set -g ledger-rg -n <app> --web-sockets-enabled true` (on for all six apps).
- Do not zip deploy. It switches the apps to the Node stack, which has no Chromium.
- `.github/workflows/deploy.yml` only installs, tests, and builds. Pushing the image is manual.
- `deploy/browser-worker.Dockerfile` is the Chromium-only process. It refuses to start without `BROWSER_PROFILE_KEY` and `BROWSER_ALLOWED_HOSTS`.
- After changing the Bolna agent config, run `npm run bolna:setup` for each site with its `--agent` id.

## Project layout

```
src/
  server/          HTTP API, chat loops, prompts, SSE, auth, payments gate, landing page
    browser/       Playwright driver, host policy, worker, shop shelves, sign-in, budget
    events/        Luma, District, and listing page parsers
    tools/         Tools Sarvam can call (Luma, District, BookMyShow)
    voice/         Gnani speech in, Sarvam speech out, Bolna session and LLM endpoint, voice router
    memory/ profile/ watch/ notify/   SQLite memory, shared profile, Scout Watch, inbox and FCM push
    commerce/ appointments/ payments/ Simulated hub, salon requests, payment gate and sandbox
  shared/          Types and rules shared by server and web (events, hosts, device actions)
  web/             React 19 app (chat, cards, composer, settings, voice call)
test/              Node test files (node:test)
scripts/           bolnaSetup.ts, live shop probes
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
- Screen Intelligence is local only. Azure still has no `/api/screen/understand` and no Understand my screen control. The Anthropic account is out of credit, so analysis will 502 until that is topped up. Not tried on the phone.
