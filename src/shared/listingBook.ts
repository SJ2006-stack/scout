import type { Listing, Platform } from "./event.ts";
import type { EventApp } from "./productRef.ts";
import { DEVICE_ACTION_TTL_MS, deviceSummary, needsConfirmation, readDeviceCommand, type DeviceAction } from "./deviceActions.ts";

export function eventAppFor(platform: Platform): EventApp {
  switch (platform) {
    case "BookMyShow":
      return "bookmyshow";
    case "District":
      return "district";
    case "Luma":
      return "luma";
    default: {
      const neverPlatform: never = platform;
      return neverPlatform;
    }
  }
}

/** The app_event_book a card's Book button sends when the Scout app can drive that event app. Null when the listing fails the same checks the server uses. */
export function bookActionForListing(listing: Listing, id: string, now: number): DeviceAction | null {
  const startsAt = listing.start ? Date.parse(listing.start) : Number.NaN;
  // A District event's start is a day and slot the phone can pick; a movie's start is not a chosen show.
  const showtime = listing.platform === "District" && listing.kind !== "movie" && Number.isFinite(startsAt) && startsAt > now ? startsAt : null;
  const read = readDeviceCommand(
    "app_event_book",
    {
      ref: {
        app: eventAppFor(listing.platform),
        eventId: null,
        link: listing.url,
        title: listing.title,
        venue: listing.venue,
        startsAt: Number.isFinite(startsAt) ? startsAt : null,
        price: listing.price.min,
      },
      tickets: 1,
      maxPricePerTicket: null,
      seat: "user_picks",
      showtime,
    },
    now,
  );
  if (!read.ok) return null;
  return {
    ...read.command,
    id,
    summary: deviceSummary(read.command, listing.timezone),
    confirm: needsConfirmation(read.command),
    expiresAt: now + DEVICE_ACTION_TTL_MS,
  };
}
