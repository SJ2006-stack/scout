# Booking and payment

How Scout takes an event or a cart to payment, and where it stops.

## What happens on Book

1. You tap Book or Register on a Luma, District, or BookMyShow card (or ask in chat).
2. The browser worker opens the listing in Playwright Chromium.
3. Luma: if the page has a register button, Scout fills the form from your profile (name, email, phone) and submits it.
4. Otherwise Scout clicks through the book, checkout, and pay buttons it finds.
5. On the pay screen it looks for a payment target, in this order:
   - a UPI deeplink the page tried to open (`upi://`, GPay, PhonePe, Paytm, BHIM),
   - a UPI link written in the page,
   - a QR code in a screenshot of the page,
   - the pay page URL itself.
6. The chat gets a `pay` event. On Android, the Pay button opens your UPI app through the `ScoutPay` bridge. On the web, it shows the QR or opens the page.

Shop works the same way: Scout reads Blinkit, Zepto, and Instamart, picks the cheapest offer, and hands back the pay link.

## Where it stops

- **Sign-in walls:** if the site asks you to log in first (BookMyShow's "Login to book"), the current flow cannot get past it and falls back to opening the page. Automatic phone sign-in with the SMS code read by the Android app is being built and is not on `main` yet.
- **You approve every payment.** Scout never asks for, reads, or stores a UPI PIN, card number, or CVV, and it never sets up autopay or mandates.
- Scout does not bypass CAPTCHAs, queues, or bot checks.
- A clicked button is not a confirmed booking. Scout reports a booking only when the site shows it.
