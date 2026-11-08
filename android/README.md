# Scout Android companion

The phone app for Scout. It opens `https://scout.shrianshjaiswal.me` in a WebView and adds native features the web page cannot do alone. It lives in `android/` of the `scout` repo (moved from the old `scout.apk` folder on Nov 8, 2026). `app/google-services.json` is ignored by git: download it from the Firebase console (project `scout-b4da3`, Android app `app.scout`) before building.

Current version: **0.9.2** (versionCode 16). Android 15 target (`targetSdk 35`), `minSdk 26`, Kotlin, Gradle. Sent to Firebase App Distribution testers on Nov 5, 2026. Not yet tried from that update.

## What it does

- **WebView shell:** every build loads `https://scout.shrianshjaiswal.me` (Azure `sj-scout`), so the app works without this Mac. To test against a local server, add `app/src/debug/res/values/strings.xml` with `azure_origin` set to `http://127.0.0.1:8787` and run `adb reverse tcp:8787 tcp:8787`. Remove that file again before sending a build to testers.
- **Native bridges** exposed to the page:
  - `ScoutNative`: native features such as the microphone (`window.ScoutNative.request({ op: "microphone" })`). Ops: `location`, `microphone`, `camera`, `notification`, `biometric`, `share`, `qr`, `permissions`, `action`. The `permissions` op opens the in-app Permissions panel from Scout Settings.
  - `action` runs a Scout phone action synchronously and returns `{op, id, status, message}` (`companion/PhoneActions.kt`): alarm and timer through the Clock app, reminders scheduled with `AlarmManager` and shown by `ReminderReceiver`, list and cancel reminders, open an allowlisted app (`PHONE_APPS`, mirrored in `<queries>`), maps, share, flashlight, volume, and capabilities. Expired or malformed actions are refused. `send_whatsapp` opens `https://wa.me/<number>?text=` with the package pinned to WhatsApp or WhatsApp Business. When the accessibility service is connected, the phone taps the Send button; a name instead of a number searches and sends only if one chat matches. The empty-box microphone is not tapped. If the service is off, a number still opens with the text filled in and Send left for them. Opening an app, sharing, sending a WhatsApp message, and muting the ringer show an Allow dialog and report the outcome later as a `scout-native` event. `app_cart_add`, after Allow, adds Blinkit, Zepto, and Instamart items through an Accessibility service limited to the store and event packages. Instamart stops with `no_address` when the cart says "Add address to proceed" and does not open the address editor. Instamart sends the search link right after starting Swiggy rather than waiting for its home, and sends it again if a cold Swiggy lands on home (agent-measured Nov 6: 16.6 s cold, 12.9 s warm, was 25 s). Every cart result carries `elapsedMs`, the run time after Allow, which Scout uses for its timing estimates. A Shop basket sends every item for one store in a single `app_cart_add`, and each store's script adds them one after another in the same run; a multi-item run from the chat has not been tried on the phone yet. The debug build only (`app/src/debug/res/xml/network_security_config.xml`) allows plain http to `127.0.0.1` and `localhost`, so it can load a local server over `adb reverse tcp:8787 tcp:8787`. Before every tap it refuses pay, Place Order, proceed to pay, UPI PIN, CVV, Blinkit `cv_checkout_container`, and Zepto `cart-pay-button`. One run at a time. The notification says "Scout is adding items… tap to stop." A touch or leaving the app stops the run. `get_capabilities` reports `automation.serviceOn` and whether Blinkit, Zepto, Instamart, BookMyShow, District, and Luma are installed, with version. `app_event_book` opens a BookMyShow, District, or Luma listing with the package pinned, closes a recognised dining or membership sheet, and stops before checkout, pay, register, RSVP, or Book tickets. It does not pick seats. This debug build has not been installed on the phone and has not been tried live.
  - `open_checkout` (in this tree, not in the build testers have): Pay asks the app to bring that store or event app forward, or to open its cart link with `setPackage`. The user taps Place Order. Scout never taps Pay or Place Order. Instamart has no app-claimed cart link, so Pay only brings Swiggy forward. Blinkit uses `https://blinkit.com/cart`; a cold start launches the app because that link drops. This build has not been installed on the phone.
- **Voice calls:** the Bolna call button in the web page uses the WebView microphone (`RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`).
  - `ScoutOtp`: one-time code handoff, with consent (`OtpConsent`).
  - `ScoutPay`: pay links from Shop Scout (`PayLinks`).
- **Voice:** the app records a clip with `MediaRecorder` (AAC, at most 30 seconds) and posts it to Scout's `/api/voice/stt`. Scout calls Gnani Prisma and returns text. The app does no speech recognition itself (`companion/Speech.kt`).
- **Settings, Permissions panel:** shows the state of Microphone, Location, Camera, Notifications, and Automation (Accessibility). The Automation row opens Accessibility settings. Each other row can request that permission. A button opens the Android app-details settings for a permission the system will no longer ask for.
- **Sign-in and sync:** the app starts on Continue with Google. Firebase Auth stays signed in. The app posts that account's ID token to Scout `POST /api/auth/google`, stores the `scout_session` cookie for that person, and flushes it when the page finishes and when the app pauses. A person with no phone or name then fills those in inside the chat. The next launch opens the same account. Sign-out, or a different Google account, clears cookies and WebView storage before the next person is signed in. Profile sync still goes to Firestore (database `scout`, region `asia-south1`). The public site has `POST /api/auth/google` since the Nov 8, 2026 deploy. The Firebase tester build (0.9.2) still opens Scout without this sign-in; only the local debug build on the agent's phone has it.
- **Companion desk:** pairing (`PairCode`), task codes (`TaskCode`), and desk hosts (`DeskHosts`) connect the phone to the web chat.
- **Messaging:** `ScoutMessaging` handles push notifications.
- **Store relay** (`relay/PhoneRelay.kt`): while the app is open, it holds a WebSocket to Scout's `/api/relay` using the WebView's `scout_session` cookie. Scout's browser on Azure sends Blinkit, Zepto, Instamart, BookMyShow, District, and Luma connections through it, so those sites see the phone's address. The phone opens only those hosts on port 443 and passes TLS bytes it cannot read. It stops when the app leaves the screen and reconnects with backoff.
- **Sign-in copies** (`relay/CopyStore.kt`): Scout sends a sealed copy of each verified store sign-in over the same socket. The phone cannot open them, adds its own Android Keystore encryption, and keeps them in `noBackupFilesDir/vault`. On connect it offers them back, so a sign-in survives the server losing its disk. Revokes from Scout delete the copy.

## Build and ship

```bash
cd scout/android
gradle assembleDebug                 # app/build/outputs/apk/debug/app-debug.apk
gradle testDebugUnitTest             # JVM unit tests
```

There is no `gradlew` script, only `gradle/wrapper/gradle-wrapper.properties`. Use Gradle 9.5 or open the folder in Android Studio.

Builds are shared through Firebase App Distribution (project `scout-b4da3`):

```bash
firebase appdistribution:distribute app/build/outputs/apk/debug/app-debug.apk \
  --app <FIREBASE_APP_ID> --project scout-b4da3
```

Bump `versionCode` and `versionName` in `app/build.gradle.kts` for every release. The landing page invite form adds a tester through the same service (`FIREBASE_DISTRIBUTION_*` in Scout's `.env`).

## Layout

```
app/src/main/java/app/scout/            MainActivity, bridges, pair and task codes
app/src/main/java/app/scout/companion/  Speech, OTP handoff, device access, desk, realtime feed
app/src/main/java/app/scout/data/       Local store, companion sync, messaging
app/src/test/java/app/scout/            Unit tests (pair code, task code, OTP consent, desk hosts, runtime)
firestore.rules, firebase.json          Firebase setup
```

Never commit `local.properties`, `app/google-services.json`, signing keys, or Firebase service keys.

## Known limits

- Debug builds only are shipped. There is no release signing or minify.
- Tests are JVM unit tests. There is no instrumented test for the permission flow.
- The app does not read SMS and does not make payments itself.
- The store relay runs only while the app is on screen, so a store task on Azure waits or fails if the app is closed. 0.9.2 (versionCode 16) was sent to the existing Firebase tester on Nov 5, 2026. It has not been tried from that update.
- 0.9.2 adds Blinkit, Zepto, and Instamart cart scripts, WhatsApp send, and `app_event_book`. The event action opens a BookMyShow, District, or Luma listing and stops before checkout. It does not pick seats. Instamart stops when the cart says "Add address to proceed". Cold-start links, gestures, the notification, and touch-to-stop are still untested on a device.
- Tested by the agent on the connected phone (HyperOS) on Nov 6, 2026, with a local debug build that is not on Firebase. The tests used `scratch/phone-run.sh` and the debug-only `DebugCartRun` activity, not a run started from the chat. Blinkit cart: done, stopping before Place Order. Zepto cart: 4 of 4 back-to-back runs done in 6 to 7 s, reading the footer "To Pay" total. BookMyShow and District `app_event_book`: they land on the listing. Later the same day, BookMyShow and District went on to the seat map or Checkout, Luma to its registration form, and Instamart to its bill (see the bullets below). WhatsApp send was not tested live.
- Fixes in that local build: only the topmost app window is read, so the HyperOS island and status bar no longer look like leaving the app; late window events from a backgrounded app no longer stop a run; Zepto is brought forward instead of having its task cleared (clearing it hung Zepto on a blank home); Zepto accepts home, results, or cart as loaded, sends the search link again once if it is ignored, and taps Cart again once; a bill is re-read for up to 1.5 s after each scroll; Blinkit "FREE" delivery reads as ₹0; the "Location permission not enabled" dialog stops with `location_off`; an event run waits for the app to show the listing and sends the link once more, else says `not_on_event`; "instant order", "cash on delivery", and "buy now" are refused like Pay. A stopped run logs ids and node count (no text) under the `ScoutDebug` tag.
- BookMyShow movies (local build, Nov 6, 2026, `BookMyShowBook.kt`): after the movie page opens, Scout taps Book tickets, picks the first format chip, taps the day in the date strip, finds the time under the cinema named in `ref.venue`, sets the ticket count on the 1 to 10 slider (or through "Tickets" on the seat map when the app remembered another count), taps Select Seats, and stops on the seat map (`reason: "seat_map"`). Without a showtime it stops on the showtimes (`showtimes`) and lists up to three cinemas with their times; a time it cannot find gives `showtime_missing`. Seats and Pay are never tapped. Tried live with Ramayana (ET00451914) today and tomorrow, 4 to 8 s per run. A "Long press to check seat price" tooltip can hide times on that page; the run then scrolls and reads again.
- District (local build, Nov 6, 2026, `DistrictBook.kt`): an event taps the unlabelled Book tickets button, the day on the calendar (a day is open when a price shows under it), and the time slot that starts at `showtime`, then adds the cheapest ticket type at or under `maxPricePerTicket` and taps the unlabelled plus beside the count until it matches. It stops with Checkout on screen (`reason: "checkout_ready"`, `total` filled). No `showtime` gives `dates` with the open days; every type over the limit gives `over_budget`. The ticket page is a web view, so Add is tapped with a gesture. A movie picks the day tab and the showtime at `ref.venue`, then stops on the seat map (`seat_map`); District has no ticket-count step, so they pick that many seats. Tried live: Comedy Nights at Foyer, 2 tickets, ₹498, 20 s; Ramayana at PVR Promenade, 10 s.
- Luma (local build, `LumaBook.kt`): taps Register in the event page's action row (beside Contact) and stops on the Registration screen (`form`), counting required answers Luma filled in. The Registration screen's own Register button is never tapped. Free events with no questions show that screen too. Paid Luma tickets were not tried.
- `isAccessibilityTool="true"` is set on the service: without it Swiggy shows the service one empty node, so Instamart timed out at home. With it, Instamart added Tata Salt and read a ₹77 bill in 25 s. A Swiggy offer that is only a picture and a close button is closed while waiting for home.
- Debug builds: `adb shell am start -n app.scout/app.scout.companion.DebugCartRun --ez dump true` logs what the service sees in the foreground app (tag `ScoutDebug`) and writes it as uiautomator-style XML to `/sdcard/Android/data/app.scout/files/screen.xml`. That copy includes screen text, so do not commit it without removing addresses.
- Gradle: `gradlew` is not in this folder. Use a Gradle 9 install, e.g. `~/.gradle/wrapper/dists/gradle-9.5.0-bin/*/gradle-9.5.0/bin/gradle :app:testDebugUnitTest :app:assembleDebug`.
- Alarms and timers are handed to the Clock app, so the result is `handoff_started`, not a confirmed alarm. Reminders are not rescheduled after a reboot. Without the exact-alarm permission on Android 12+, reminders can fire a few minutes late.
