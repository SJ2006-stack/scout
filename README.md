# Scout

Scout is a set of chat agents that find things and act on them for one person. Event Scout is the live one: it searches Luma, District, and BookMyShow, and can drive a real browser to register. Food, Shop, and Appointments run on a simulated commerce hub. Travel and Home are placeholders.

This folder is the server and the web app. The Android companion is in `../scout.apk`. See the workspace `../README.md` for the overview and the changelog.

## Agents

| Agent | Status | What it does |
| --- | --- | --- |
| Main | Router | Points you to the right agent |
| Event | Live | Luma, District, BookMyShow search; browser-assisted registration |
| Travel | Not connected | Talks through a trip. No live fares |
| Food | Simulated | Looks up dishes on a simulated menu and reviews an order |
| Shop | Simulated | Compares Blinkit, Zepto, Instamart, then hands a pay link to the phone |
| Home | Not connected | Plans with you. No service attached |
| Appointments | Simulated | Requests a simulated salon time |

One codebase serves every agent. `SCOUT_AGENT` pins a process to one agent. Each agent has its own Azure host (`src/shared/hosts.ts`), and `GET /api/health` returns `{ ok: true, agent }`.

## How a chat turn works

1. The web app posts to `POST /api/chat` and reads Server-Sent Events.
2. With `ANTHROPIC_API_KEY` set, Claude Haiku 5.5 (`claude-haiku-5-5`) runs a tool loop of at most 4 rounds (`src/server/haikuChat.ts`). Event tools are Luma, District, and BookMyShow. Specialist agents use `compare_shops`, `shop_catalog`, `food_order`, and `salon_request` (`src/server/specialistChat.ts`). With no key, a keyword parser answers instead.
3. The final text streams into the question bubble. The first sentence can start speech before the stream closes.
4. A source that fails leaves the other cards on screen. Failures are never cached.

Event sources:

- **Luma:** the public discovery feed.
- **District:** the public events and movies pages.
- **BookMyShow:** Pomerado's read-only "Search movies and events" tool, when `POMERADO_API_KEY` is set. It is capped by `CONNECTOR_TIMEOUT_MS` (8 s).
- Movie cards appear only when the page carries the movie's own link. Drive time appears only when `GOOGLE_MAPS_API_KEY` is set.
- Successful listings are cached for `LISTING_CACHE_TTL_MS` (10 minutes). Price checks use `CACHE_TTL_MS` (60 s).

Cards open the listing. Scout does not pick seats or pay on Luma, District, or BookMyShow. See `docs/stage2-booking.md` for the booking limits.

## Voice

The mic button records a clip and posts it to `POST /api/voice/stt`, which calls Sarvam (`saaras:v4`) and returns text. `POST /api/voice/tts` speaks a reply with Sarvam (`bulbul:v3`). There is no realtime or WebSocket speech. It was removed on purpose, so `/api/voice/live` does not exist.

- **Browser:** the web `MediaRecorder` posts the clip (`src/web/voice.ts`).
- **Android app:** the web page calls `window.ScoutNative.request({ op: "microphone" })`. The app records with `MediaRecorder` and posts the clip to the same route.
- With `SARVAM_API_KEY` empty, the mic stays quiet.

## Browser worker

A Playwright Chromium worker opens public https pages for registration and RSVP flows. It is off until `BROWSER_WORKER_ENABLED=1`.

- Private, loopback, link-local, and metadata hosts are blocked, including after DNS lookup. `BROWSER_ALLOWED_HOSTS` limits the worker to listed hosts.
- A host check that does not answer in 4 seconds counts as not public and is remembered, so one stalled DNS lookup cannot freeze a navigation.
- One operation is capped by `BROWSER_OP_TIMEOUT_MS`. A timeout closes that session, records it, and logs to `console.error`.
- Sign-in is saved as AES-256-GCM encrypted browser state, bound to the owner. It needs `BROWSER_PROFILE_KEY`.
- A visible window handoff needs `BROWSER_HEADED=1` on a machine with a display. The Azure container stays headless.
- One-time codes are typed into the code field and never written to the task log.

Central browser (staging only, not deployed): `SCOUT_ROLE=browser` runs the one Chromium process. Site apps set `BROWSER_RUNTIME_URL` and `BROWSER_RUNTIME_KEY` and send each request with a short-lived signed ticket. Admission limits (`BROWSER_GLOBAL_LIMIT`, `BROWSER_USER_LIMIT`, `BROWSER_DOMAIN_LIMIT`, `BROWSER_RSS_CEILING_MB`) and `BROWSER_IDLE_MS` bound it. `GET /api/browser/budget` shows the planning estimate for six sites on one P1v3. These figures are estimates, not measurements. Full details are in `docs/browser-worker.md`.

## Accounts and storage

- Sign-in is by email code, sent from an AgentMail inbox (`AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID`).
- Users and their browser sessions live in SQLite (`SCOUT_DB_PATH`, default `.data/scout.sqlite`, `/home/data/scout.sqlite` on Azure).
- Browser session status is also kept in `sessions.json` under `BROWSER_STATE_DIR`.
- These are in memory and reset on restart: chat memory, saved addresses, rate limits, the commerce hub, payment approvals, and pair tickets.
- Payments run through a gate with approvals, idempotency keys, and quote expiry, backed by a sandbox adapter. No real money moves.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Liveness and the pinned agent |
| `POST /api/chat` | Chat turn over SSE |
| `POST /api/demo` | Replay the prepared sample |
| `POST /api/search` | Grocery price search |
| `POST /api/commerce`, `POST /api/pay` | Simulated food, shop, appointments, and payment |
| `POST /api/voice/stt`, `POST /api/voice/tts` | Sarvam speech in and out |
| `POST /api/ocr` | Read text from an attached image |
| `/api/auth/*` | Email code sign-in and session |
| `/api/onboarding/*` | Name and phone |
| `/api/addresses`, `/api/location/reverse-geocode` | Saved addresses and address lookup |
| `/api/browser/*` | Browser sessions, handoff, code, profile, budget |
| `/api/desk`, `/api/pair` | Phone companion desk and pairing |
| `/api/invite` | Sends the Android install invite through Firebase App Distribution |

## Run it

Requires Node 22.6 or newer.

```bash
cd scout
npm install
cp .env.example .env   # fill in the keys you want
npm run dev            # http://127.0.0.1:8787
npm test               # node's test runner over test/*.test.ts
npm run build          # Vite build into dist/
npm start              # production server (src/server/prod.ts)
```

For the browser worker, also run `npx playwright-core install chromium`.

Settings are listed with comments in `.env.example`. The main ones:

| Variable | Meaning |
| --- | --- |
| `ANTHROPIC_API_KEY` | Haiku chat. Empty uses the keyword parser |
| `SARVAM_API_KEY` | Speech in and out |
| `POMERADO_API_KEY` | BookMyShow listings |
| `GOOGLE_MAPS_API_KEY` | Drive time and formatted addresses |
| `SCOUT_AGENT` | Pins the process to one agent |
| `SCOUT_ROLE` | `browser` runs the Chromium-only process |
| `BROWSER_WORKER_ENABLED` | `1` starts the browser worker |
| `BROWSER_PROFILE_KEY` | 64 hex characters for encrypted sign-in |
| `AGENTMAIL_*` | Email sign-in codes |
| `FIREBASE_DISTRIBUTION_*` | Android invite from the landing page |

Never commit `.env`, keys, or publish profiles.

## Deploy

- Azure runs the `scout-site` container image from `sjscoutacr.azurecr.io`, which includes Chromium (`deploy/site.Dockerfile`). Six App Service apps share one P1v3: `sj-scout`, `sj-event-scout`, `sj-travel-scout`, `sj-food-scout`, `sj-shop-scout`, `sj-home-scout`. Appointments has a host name in code but no Azure site.
- A zip deploy switches the apps back to the Node stack, which has no Chromium, so the browser worker cannot start. Do not zip deploy.
- `.github/workflows/deploy.yml` only installs, tests, and builds. Pushing the container image is manual.
- `deploy/browser-worker.Dockerfile` is the Chromium-only process. It refuses to start without `BROWSER_PROFILE_KEY` and `BROWSER_ALLOWED_HOSTS`.
- The apps are pinned to a tag (now `ui-20261031`), not `latest`. After `az acr build`, import the image under a new tag, then `az webapp config container set -g ledger-rg -n <app> --container-image-name sjscoutacr.azurecr.io/scout-site:<tag>` on all six.
- Always On and the `/api/health` check are set on the six apps.
- Public page: `https://scout.shrianshjaiswal.me`.

## Layout

```
src/server/        API, chat loops, tools, browser worker, commerce, payments, auth, voice
src/server/browser/  Playwright driver, policy, worker, store, budget, runtime tickets
src/shared/        Types and rules used by server and web
src/web/           React 19 app: App.tsx (state and chat), Sidebar, Welcome, Composer, EventCard, CommerceCard, SettingsPanel, PairPanel, BrowserTasks, SignIn, app.css
test/              Node test files
deploy/            Site and browser-worker Dockerfiles
docs/              Browser worker and booking notes
scout-landing/     Public landing page
```

## Known limits

- Travel and Home are not connected. Food, Shop, and Appointments are simulated.
- Scout does not book or pay on Luma, District, or BookMyShow.
- State listed under "Accounts and storage" as in memory is lost on restart, and the server cannot run as more than one instance.
- Browser operations run one at a time per process.
- The central browser layout is a design with planning estimates. It is not deployed or measured.
- Shop price data is simulated. The only live grocery candidate (QuickCompare) returned HTTP 401 and was not retried. The record is in `src/shared/liveCheck.ts`.
