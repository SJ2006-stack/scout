# Browser worker

The Tasks screen can start one isolated Chromium session and show its status. Event chat, search, and commerce routes are unchanged. The worker does not forward one-time codes, run a payment, or store passwords.

## Local development

Requires Node 22.6 or newer, the same as the rest of Scout.

```bash
cd scout
npm install
npx playwright-core install chromium
```

`playwright-core` does not download a browser during `npm install`. The command above installs Chromium for this machine. On Linux servers that lack the system libraries Chromium needs, install those packages before launching the worker.

Copy the browser settings from `.env.example` into `.env` and set:

```bash
BROWSER_WORKER_ENABLED=1
BROWSER_HEADED=1
BROWSER_PROFILE_KEY=<64 hex characters>
```

`BROWSER_HEADED=1` lets a handoff open a real Chromium window on this machine. Leave it `0` on a server with no display. `BROWSER_PROFILE_KEY` encrypts the saved sign-in. Without it, each session starts signed out.

On this machine, any public https site can be opened. `http`, `file`, and `javascript` URLs stay closed, and a URL that includes a username or password is rejected. Loopback, private, link-local, and metadata hosts stay closed, including `169.254.169.254`. A name that resolves to one of those addresses is closed too. The same rule applies to images and other page requests, not only the document. `BROWSER_ALLOWED_HOSTS` limits the worker to those hosts and their subdomains. Leave it empty on this machine. The dedicated Chromium process requires it.

Then:

```bash
npm run dev
```

Open http://127.0.0.1:8787, choose Tasks, enter an `https` URL, and choose **Start browser session**. **View browser status** reads the stored session. The page and the API must share an origin so the browser sends the `scout_session` cookie. The worker ignores `x-scout-session` and any owner or session id in the JSON body.

Leave `BROWSER_WORKER_ENABLED` unset or `0` when you only need Event Scout. The API then returns “Browser worker is not enabled on this server.” and does not launch Chromium.

## What a session can do

- Create an isolated browser context bound to the caller’s cookie and a server-created task.
- Open a public `https` URL, and close the session if the page ends somewhere the policy rejects. With `BROWSER_ALLOWED_HOSTS` set, the host must be on that list.
- Read a snapshot of accessible controls, click one of those controls, or fill a text field.
- Report status, pause, resume, and close.
- Open the same browser context in a visible window, then pause, so you can sign in or finish a check. Resume reads the page again.
- Save that browser state encrypted for the signed-in owner, reload it on a later session, and drop it on expiry or revoke.
- Accept one numeric code for a paused task. The code is typed into the only code field and is not written to the task log.
- Expire the session after `BROWSER_SESSION_TTL_MS` (default 15 minutes) and sweep closed browsers every 30 seconds.
- Keep at most `BROWSER_MAX_SESSIONS` open sessions on the process (default 4).
- Stop one operation after `BROWSER_OP_TIMEOUT_MS` (default 15 seconds). A timed-out operation closes that session and records the timeout.

Each action is also stored and replayed on `GET /api/browser/tasks/:taskId/events` as `text/event-stream`, the same `event` / `data` frames used by chat. The event text matches the outcome. A refused URL, a pause, a timeout, or a closed session is not reported as a successful open.

## What is stored

Session and task status are written to `sessions.json` under `BROWSER_STATE_DIR`, or `scout/.data/browser` when that variable is empty. The same sessions are also recorded in `scout.sqlite` (`SCOUT_DB_PATH`, or `/home/data/scout.sqlite` on Azure App Service) next to the user they belong to. That file holds the user id, the session id, status, page URL, title, and whether a saved sign-in is present. It does not hold cookies or `storageState`. `.data/` is gitignored. `sessions.json` holds owner ids, task status, the current page URL and title, and the activity events. It does not hold cookies, `storageState`, typed field values, or authorization headers.

Cookies and login state for a live session stay in that Chromium context. Closing, expiry, timeout, and process restart discard the live context. A new process marks previously open sessions expired.

When `BROWSER_PROFILE_KEY` is set, the worker also writes an encrypted copy under `profiles/` inside the state directory. The file is AES-256-GCM and is bound to that owner. The index next to it stores only the owner id and the expiry time. `BROWSER_PROFILE_TTL_MS` defaults to 7 days. `POST /api/browser/profile/revoke` deletes the ciphertext and closes that owner's live sessions. A session expiring does not delete the saved sign-in. The saved sign-in expiring, or a revoke, does.

Do not point `BROWSER_STATE_DIR` at a directory you commit. Do not log the JSON body of a fill request.

## Visible handoff

`POST /api/browser/sessions/:id/handoff` pauses the session and, when `BROWSER_HEADED=1`, opens the current page in a visible Chromium window. You use that window for a login or another check. The saved profile is the encrypted browser state for that owner, so a later task starts from the same sign-in. `POST .../resume` reads the page and continues. On a host with `BROWSER_HEADED=0`, the handoff reports that the host cannot open a window and leaves the session open. The container stays headless. Sign-in in a visible window stays on a machine with a display.

## Phone

The Android app in `scout.apk` opens the same Scout page as this computer. With the phone plugged in, `adb reverse tcp:8787 tcp:8787` makes `http://127.0.0.1:8787` on the phone reach Scout on this Mac. Chats saved in the browser are also stored for that local server, so the phone can show them. If the computer cannot be reached, the app opens `https://sj-scout.azurewebsites.net`.

## Deployment

The GitHub workflow in `.github/workflows/deploy.yml` still runs `npm ci`, `npm test`, and `npm run build`, then publishes a zip to the existing Azure apps. Those apps are the Node 22 stack. That stack has no Chromium binary and no system libraries, so the worker cannot start there.

`deploy/site.Dockerfile` is the full site, including chat, with Chromium installed. It sets `BROWSER_WORKER_ENABLED=1`, `BROWSER_HEADED=0`, and `SCOUT_CONTAINER=1`. Headless Chromium in that container starts with `--no-sandbox` and `--disable-dev-shm-usage`. The window stays hidden because Azure has no display. `SCOUT_AGENT` and `BROWSER_PROFILE_KEY` stay Azure application settings, not layers in the image. Build it from `scout/` after `npm run build`:

```bash
docker build -f deploy/site.Dockerfile -t scout-site .
```

`deploy/browser-worker.Dockerfile` is the Chromium process. `SCOUT_ROLE=browser` serves health and `/api/browser` only. It refuses to start until `BROWSER_PROFILE_KEY` and `BROWSER_ALLOWED_HOSTS` are set, so a cloud session cannot keep a plaintext sign-in or open an arbitrary host. From `scout/`, after `npm run build`:

```bash
docker build -f deploy/browser-worker.Dockerfile -t scout-browser .
docker run --rm -p 8080:8080 \
  -e BROWSER_PROFILE_KEY \
  -e BROWSER_ALLOWED_HOSTS=luma.com,district.in,bookmyshow.com \
  -e BROWSER_HEADED=0 \
  -v scout-browser:/data \
  scout-browser
```

Pass `BROWSER_PROFILE_KEY` from the environment, not from an image layer. The volume holds `sessions.json` and the encrypted profiles. `SIGTERM` closes the server, which closes Chromium. Keep `BROWSER_HEADED=0` in that container. A visible window needs a machine with a display, which Azure App Service and a normal container do not have.

Point the Azure websites at `deploy/site.Dockerfile` when Chromium should run there. The zip deploy cannot start it. The separate browser image remains the Chromium-only process. Do not commit `.env`, publish profiles, or `.data/`.

## One browser on P1v3

Six Linux App Service apps share one P1v3 worker (2 vCPU, 8 GB RAM, Central India, no scale-out): `sj-scout`, `sj-event-scout`, `sj-travel-scout`, `sj-food-scout`, `sj-shop-scout`, and `sj-home-scout`. Appointments has no Azure site. If each site image starts Chromium, that machine runs six browsers. The central layout is one Chromium process and six Node apps.

`GET /api/browser/budget` returns that comparison. The RAM and CPU figures are planning estimates, not a live Azure sample. The same response counts live hosts and owners. It does not include cookies or full URLs.

Set this on a **staging** browser process first. Do not switch production until a regression pass succeeds. This section describes the local and staging settings. It does not mean the change is deployed.

Staging browser process (`SCOUT_ROLE=browser`). This process keeps Chromium. Leave `BROWSER_RUNTIME_URL` unset.

```bash
SCOUT_ROLE=browser
BROWSER_WORKER_ENABLED=1
BROWSER_HEADED=0
BROWSER_PROFILE_KEY=<64 hex characters>
BROWSER_ALLOWED_HOSTS=<public hosts>
BROWSER_RUNTIME_KEY=<at least 32 characters>
BROWSER_GLOBAL_LIMIT=2
BROWSER_USER_LIMIT=1
BROWSER_DOMAIN_LIMIT=1
BROWSER_IDLE_MS=120000
BROWSER_RSS_CEILING_MB=4096
```

Each of the six site apps. These do not launch Chromium. Set `BROWSER_RUNTIME_URL` only here, and leave `BROWSER_WORKER_ENABLED=0`.

```bash
BROWSER_WORKER_ENABLED=0
BROWSER_RUNTIME_URL=https://<staging-browser-host>
BROWSER_RUNTIME_KEY=<same key as the browser process>
```

The site sends the signed-in cookie owner to the browser process with a short-lived ticket. It does not forward the site cookie. A measured RSS of 0 is treated as unknown and is not refused. Open sessions idle for `BROWSER_IDLE_MS` can close. Paused sessions stay until the session TTL.

## Limits in this version

- The phone opens this Scout page. It does not read SMS, and there is no payment call. Typing a task code into the worker stays the code path until a paused sign-in is reliable on a real site.
- Document and subresource requests must stay on public https or wss. Private and metadata destinations are blocked after DNS lookup. An allowlist, when set, is the only set of hosts that can be opened.
- Operations on this process run one at a time.
- A typed value is sent to the page field and then dropped from the log. A driver error is recorded as “The field could not be filled.” The value is not copied into the event.
- The saved sign-in is the browser state, encrypted at rest. It is not a password vault.
