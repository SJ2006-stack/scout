# Grocery Scout

Personal prototype. The home screen is an event chat for Luma and District. Grocery search remains available at `POST /api/search`. There is no checkout, account, or payment flow.

## Event chat

Ask for comedy, concerts, workshops, or movies in Bengaluru, Mumbai, Delhi, or Hyderabad. A missing city gets a question. A budget is optional. "Under 500" hides advertised prices above that amount, and keeps free events and events whose price was not on the page.

Each search calls three tools: Luma, District, and BookMyShow. Luma comes from one plain request to its public discovery feed. District events and movies come from the public pages `https://www.district.in/events/` and `https://www.district.in/movies/`. BookMyShow uses Pomerado's read-only "Search movies and events" tool when `POMERADO_API_KEY` is set. A source that fails leaves the other cards on screen. Movie cards appear only when that page includes the movie's own link. Drive time appears only when `GOOGLE_MAPS_API_KEY` is set and Google returns a driving route.

View on Luma, View on District, and View on BookMyShow open the listing. Scout does not sign in, choose seats, or pay. See `docs/stage2-booking.md` for the later booking limits.

The only live candidate, QuickCompare's public group search, was checked once from this machine and rejected. Scout does not invent live prices. Demo mode replays a fixed, labelled sample through the same chat.

## Setup

Requires Node 22.6 or newer. This copy was run on Node 26.

```bash
cd scout
npm install
npm test
npm run dev
```

Open http://127.0.0.1:8787.

Optional environment variables are listed in `.env.example`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Local server port |
| `CACHE_TTL_MS` | `60000` | How long a successful price stays cached |
| `CONNECTOR_TIMEOUT_MS` | `8000` | Per-connector limit for a live search |
| `DEMO_STEP_MS` | `400` | Pause between demo events |

Copy `.env.example` to `.env` only if you want to change those values. The app has no secrets.

## What a search does

1. The request is parsed without a model. "1 litre" and "1 L" become 1000 ml. A 200 ml pack does not match a 1 L pack.
2. Choose **Detect your location**. The browser asks for permission only after that click, then Scout turns that device point into an address. A VPN does not move this reading. Saved addresses belong to an anonymous browser session and are kept in memory until Scout restarts.
3. Connectors run together. One timeout or failure still leaves the other connector's offers on screen. Stopping the request cancels work that has not emitted yet.
4. Successful prices are cached for 60 seconds. The cache key is the source, the normalised query, the pack size, the pincode, and coordinates rounded to two decimal degrees. Failures, timeouts, and malformed payloads are not cached. An expired entry is a miss.
5. Cards sort by ascending price. A discount is shown only when both MRP and price are numbers and MRP is higher. Every product link must be `https`.

Provenance on a card is one of `Live`, `Cached`, or `Demonstration data`.

## Address lookup

The page asks the browser for this device's location, then the server reverse-geocodes that point. Set `GOOGLE_MAPS_API_KEY` to use Google's formatted address. Leave it empty and Scout uses ArcGIS instead. The key stays on the server. A successful lookup for the same coordinate is remembered for one minute.

There is no user account and no database. `GET` and `POST /api/addresses` store addresses for the `scout_session` cookie issued by the server. A caller cannot supply a user id, and one session cannot read another session's addresses. Restarting the process drops them. Do not put a secret in `NOMINATIM_USER_AGENT`.

## Live source check

One plain GET, with `Accept: application/json`, a 10 second timeout, and no stealth headers:

`GET https://api.quickcompare.in/qc?type=groupsearch&query=milk&pincode=110054`

The response was HTTP 401 in 2787 ms: "Security validation failed: missing encrypted request id." That was the one allowed attempt. It was not retried with a browser, a different header set, or a TLS impersonation client.

No direct store connector was added. The store clients in the reference projects depend on browser automation or TLS impersonation, and those were out of scope. `src/server/index.ts` keeps the live connector list empty. A live search returns the unavailable message, zero offers, and a link to Blinkit's own search page for the same query. Scout does not request Blinkit.

The recorded result lives in `src/shared/liveCheck.ts`.

## Demo mode

Replay demo uses the prepared request "Find Amul Taaza milk, 1 litre, near my delivery location." The area label is "Demonstration area, pincode 110001". It is sample data, not your address.

Two fixture connectors run: Demo Mart returns two sample offers, and Demo Corner reports a typed failure. Links point at `https://example.com/scout-demo/...` so link handling can be checked. They are not store pages. Replay clears the transcript and streams the same sequence again. It does not call the network.

## Measured timings

These numbers are from the first working end-to-end demo replay with `DEMO_STEP_MS=400`. They are observations. This prototype does not set a latency target.

The `done` event reports the fixture clock: first useful offer at 400 ms, completion at 1200 ms, 2 offers. That clock is fixed so tests can compare replays.

A POST to `/api/demo` on this machine, with the default 400 ms step, received the first offer event at about 869 ms and finished the stream at about 2478 ms. Two status events are emitted before the first offer, so the wall clock is longer than the fixture clock.

A live search with no connector connected finished on this machine with `totalMs` of 1, returned no offers, and included a Blinkit search link.

## Manual check

After `npm test` and `npm run dev`:

1. Choose Replay demo. Confirm the transcript shows "Demonstration data", two sample prices, the Demo Corner failure, and example.com links. Replay again and confirm the same sequence replaces the transcript.
2. Choose Enter an address manually, add a 6-digit postal code, and choose Use this address. The note should name the pincode and say the area is approximate. Or choose Use my current location, check the suggested fields, and only then use the address.
3. Choose Search. The page should show the unavailable live-source message and no sample prices. A dead connector should leave that message visible rather than clearing the page.

## Limits

- Prices in demo mode are samples. Live mode opens a Blinkit search link and does not return a price.
- The price cache is in memory and lasts 60 seconds. Restarting the server drops it.
- A saved address is for this browser session only. There is no account, and restarting Scout clears it. The detected line is the address for the browser's point, and another geocoder can name the same building differently.
- Scout does not place an order.
- The QuickCompare endpoint is unofficial. A browser capture of it is not a feed this server is allowed to keep calling after a 401.
