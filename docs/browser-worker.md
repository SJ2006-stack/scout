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
BROWSER_ALLOW_HOSTS=example.com
```

`example.com` also allows subdomains such as `www.example.com`. Entries are hostnames only, with no scheme, path, port, or username. An empty allowlist rejects every navigation.

Then:

```bash
npm run dev
```

Open http://127.0.0.1:8787, choose Tasks, enter an allowlisted `https` URL, and choose **Start browser session**. **View browser status** reads the stored session. The page and the API must share an origin so the browser sends the `scout_session` cookie. The worker ignores `x-scout-session` and any owner or session id in the JSON body.

Leave `BROWSER_WORKER_ENABLED` unset or `0` when you only need Event Scout. The API then returns “Browser worker is not enabled on this server.” and does not launch Chromium.

## What a session can do

- Create an isolated browser context bound to the caller’s cookie and a server-created task.
- Open an allowlisted `https` URL, including a redirect check on the final URL.
- Read a snapshot of accessible controls, click one of those controls, or fill a text field.
- Report status, pause, resume, and close.
- Expire the session after `BROWSER_SESSION_TTL_MS` (default 15 minutes) and sweep closed browsers every 30 seconds.
- Keep at most `BROWSER_MAX_SESSIONS` open sessions on the process (default 4).
- Stop one operation after `BROWSER_OP_TIMEOUT_MS` (default 15 seconds). A timed-out operation closes that session and records the timeout.

Each action is also stored and replayed on `GET /api/browser/tasks/:taskId/events` as `text/event-stream`, the same `event` / `data` frames used by chat. The event text matches the outcome. A refused URL, a pause, a timeout, or a closed session is not reported as a successful open.

## What is stored

Session and task status are written to `sessions.json` under `BROWSER_STATE_DIR`, or `scout/.data/browser` when that variable is empty. `.data/` is gitignored. The file holds owner ids, task status, the current page URL and title, and the activity events. It does not hold cookies, `storageState`, typed field values, or authorization headers.

Cookies and login state live only in the Chromium context for that session. Closing, expiry, timeout, and process restart discard the context. A new process marks previously open sessions expired.

Do not point `BROWSER_STATE_DIR` at a directory you commit. Do not log the JSON body of a fill request.

## Deployment

The GitHub workflow in `.github/workflows/deploy.yml` still runs `npm ci`, `npm test`, and `npm run build`, then publishes the server and the built page to the existing Azure apps. It does not install Chromium. `BROWSER_WORKER_ENABLED` stays off unless an app setting turns it on, so the current Event Scout deploy keeps working without a browser.

Turning the worker on needs a host that can run Chromium:

1. Install dependencies with `npm ci`.
2. Install Chromium with `npx playwright-core install chromium`, plus the operating-system libraries that build requires.
3. Set `BROWSER_WORKER_ENABLED=1`, `BROWSER_ALLOW_HOSTS`, and the timeout, expiry, and session-cap variables.
4. Put `BROWSER_STATE_DIR` on local disk that is not part of the git publish, and exclude it from backups that are not meant to hold session metadata.
5. Keep the web page and the API on one site so the session cookie is sent.

Azure App Service zip deploy does not include a Chromium system install. Use a container or VM when you enable the worker. Do not commit `.env`, publish profiles, or `.data/`.

## Limits in this version

- No one-time-code forwarding, payment automation, or credential vault.
- Document navigations must match the allowlist. Other page resources, such as images on a CDN, are not blocked.
- Operations on this process run one at a time.
- A typed value is sent to the page field and then dropped. A driver error is recorded as “The field could not be filled.” The value is not copied into the event.
