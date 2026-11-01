# Scout

A voice-first personal assistant for India. Ask in Hindi, English, or Hinglish, by typing, by mic, or on a live voice call, and Scout finds events, compares grocery prices, and drives a real browser to register or reach the pay screen. Payment always happens in your own UPI app.

**Live:** [scout.shrianshjaiswal.me](https://scout.shrianshjaiswal.me)

This repository is the server and the web app. The Android companion app (microphone, phone actions, UPI handoff, push) lives in a separate project, `scout.apk`.

## What it does

- **Events:** searches Luma, District, and BookMyShow, shows cards with date, price, and drive time, registers on Luma, and clicks through to the pay screen on the others.
- **Shopping:** opens Blinkit, Zepto, and Instamart in the browser worker, reads live prices, picks the cheapest, and hands back a UPI link or QR.
- **Voice:** a mic button for single clips and a phone button for a live call through [Bolna](https://www.bolna.ai), with Sarvam speech. Scout is the call's LLM, so cards appear in the chat while you talk.
- **Memory:** remembers your name, city, diet, budget, and other preferences, and shares them with every agent. Refuses to store OTPs, PINs, passwords, and card numbers.
- **Scout Watch:** recurring event checks that send only new matches to your inbox and phone.
- **Phone actions:** alarms, timers, reminders, flashlight, volume, maps, sharing, and opening apps, carried out by the Android app.

## Agents

One codebase serves every agent. `SCOUT_AGENT` pins a process to one, and each has its own host (`src/shared/hosts.ts`).

| Agent | Status | What it does |
| --- | --- | --- |
| Main | Router | Points you to the right agent |
| Event | Live | Luma, District, BookMyShow search; Luma registration; Book to the pay screen |
| Shop | Live with the browser worker | Live prices on Blinkit, Zepto, Instamart. Real carts on Blinkit and Zepto up to your approval and the UPI handoff. Without the worker, only the simulated catalogue answers |
| Food | Simulated | Dishes on a simulated menu and an order review |
| Appointments | Simulated | Requests a simulated salon time |
| Travel | Not connected | Talks through a trip. No live fares |
| Home | Not connected | Plans with you. No service attached |

## How it works

### A chat turn

1. The web app posts to `POST /api/chat` and reads Server-Sent Events.
2. Claude Haiku 5.5 (`claude-haiku-5-5`) runs a tool loop of at most 4 rounds (`src/server/haikuChat.ts`, `src/server/specialistChat.ts`). Without `ANTHROPIC_API_KEY`, a keyword parser answers instead.
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
- **Buy:** `buy_from_shop` (Blinkit, Zepto, or Instamart) starts a task: sign in with your phone and an SMS code if the store asks, open the search, type your pincode into the store's location box (or use the device location), add the item, open the cart, and read the bill. A card in the chat shows each step, a code box, the cart with fees and total, and Approve. Scout presses the store's pay control only after you approve that exact cart, then the UPI link goes to your phone. "I have paid" checks the store's orders page.
- **Instamart** carts are enabled but untested past sign-in. Instamart shows search results only to a signed-in Swiggy account, so the task signs in first (the account button, then "Log in with phone number"). Earlier its product grid exposed no add button by name; that may still stop the add step.
- **Blinkit sign-in:** Blinkit's "Login" is plain text and its login dialog marks the page body `aria-hidden`. The page reader keeps short "Login"/"Sign in" labels as `text` controls and removes `aria-hidden` from the body before each read. Shop tasks set the delivery location before signing in.
- **Sign-in waits:** stores draw their login controls after the page loads, later still through the relay, so sign-in waits up to 8 s for a control it recognises before giving up.
- **Connectors:** Settings lists the sites each Scout signs in to (Shop: Blinkit, Zepto, Instamart. Event: BookMyShow, District, Luma) from `GET /api/browser/scout/sessions`. Connect starts `POST /api/browser/scout/tasks` with `action: "sign_in"`, using the account's phone number or Gmail. The task card shows the code box; the Android app fills it from the SMS notification. Disconnect calls `POST /api/browser/scout/sessions/revoke`.
- **Guest carts:** Blinkit shows the full bill to a guest; Zepto shows only the item total until you sign in. Scout never asks you to approve a total the store has not shown.
- Live probes: `scripts/shopCompareProbe.ts` and `scripts/shopCartProbe.ts` (`HEADED=1` shows Chrome). The cart probe stops before sign-in.

### Voice

- **Mic button:** records a clip and posts it to `POST /api/voice/stt`, which calls Sarvam `saaras:v4` in `codemix` mode, so English words stay in English letters. `POST /api/voice/tts` speaks with Sarvam `bulbul:v3`. In the Android app, the page asks `window.ScoutNative` to record natively and posts to the same route.
- **Live calls:** the phone button starts a Bolna web call (`src/web/voiceCall.ts`). Bolna handles the microphone, Sarvam speech recognition, the `bulbul:v4-flash` voice, and interruptions. Each agent is set up with Hindi and English, and Bolna switches when the caller changes language.
  - `POST /api/voice/bolna/session` mints a single-use call and passes a signed 45-minute ticket in the prompt. The Bolna key never reaches the browser.
  - `POST /api/bolna/v1/chat/completions` is an OpenAI-compatible streaming endpoint that Bolna calls for every turn. It picks the specialist (`src/server/voice/voiceRouter.ts`, sticky for 10 minutes), runs the normal Haiku turn with a short spoken reply, and streams the words.
  - `GET /api/voice/live` streams that turn's cards and phone actions to the open chat.
  - Measured on a tunnel: first words in about 1 to 2 s. Measured once on Azure: about 2 s for an alarm request.

### Phone actions

Any agent can call `phone_action`. The server validates it (`src/shared/deviceActions.ts`), emits a `device` event, the page hands it to the Android app, and the result comes back on `/api/actions/result`. Opening apps, sharing, and muting ask for Allow on the phone first. In a normal browser, Scout says the phone app is needed.

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

- Sign-in is by email code from an AgentMail inbox.
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
| `ANTHROPIC_API_KEY` | Haiku chat. Empty uses the keyword parser |
| `SARVAM_API_KEY` | Speech in and out |
| `BOLNA_API_KEY`, `BOLNA_LLM_KEY`, `BOLNA_AGENT_ID` | Live voice calls. All three are needed |
| `GOOGLE_MAPS_API_KEY` | Drive time and addresses |
| `SCOUT_AGENT` | Pins the process to one agent |
| `SCOUT_ROLE` | `browser` runs the Chromium-only process |
| `BROWSER_WORKER_ENABLED` | `1` starts the browser worker |
| `BROWSER_PROFILE_KEY` | 64 hex characters for encrypted sign-in |
| `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID` | Email sign-in codes |
| `FIREBASE_DISTRIBUTION_*` | Android install invite from the landing page |
| `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` | Push for Scout Watch |
| `RELAY_CAP_MB` | Bytes one phone relay connection may carry. Default 300 |
| `SCOUT_DEVICE_VAULT` | `scripts/relayDevice.ts` only: folder for sealed sign-in copies |

Never commit `.env`, keys, or publish profiles.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Liveness and the pinned agent |
| `POST /api/chat` | Chat turn over SSE |
| `POST /api/demo` | Replay the prepared sample |
| `POST /api/search` | Grocery price search |
| `POST /api/commerce`, `POST /api/pay` | Food, shop, appointments, and the payment gate |
| `POST /api/voice/stt`, `POST /api/voice/tts` | Sarvam speech in and out |
| `POST /api/voice/bolna/session`, `GET /api/voice/live` | Start a Bolna call and stream its cards to the chat |
| `POST /api/bolna/v1/chat/completions`, `GET /api/bolna/v1/models` | Scout as Bolna's LLM (bearer `BOLNA_LLM_KEY`) |
| `/api/profile`, `/api/watches`, `/api/inbox`, `/api/devices`, `/api/actions/result` | Memory, Scout Watch, notifications, push devices, phone action results |
| `POST /api/ocr` | Read text from an attached image |
| `/api/auth/*`, `/api/onboarding/*` | Email code sign-in, name and phone |
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
- The apps are pinned to a tag, not `latest`, so a restart alone keeps the old build. Now all six run `vault1-20261101`.
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
    tools/         Tools Haiku can call (Luma, District, BookMyShow)
    voice/         Sarvam speech, Bolna session and LLM endpoint, voice router
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
- On Azure, store pages only load while your relay is connected. The Android app does not run the relay yet, so today a Mac running `scripts/relayDevice.ts` has to stay on.
- Store pages change. A changed button label stops the task with a message instead of guessing.
- Food and Appointments are simulated. Travel and Home are not connected.
- State kept in memory is lost on restart, so the server cannot run as more than one instance.
- Browser operations run one at a time per process.
- The central browser layout is a design with estimates, not deployed or measured.
