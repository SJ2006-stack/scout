import { useState } from "react";
import { CalendarClock, Car, MapPin } from "lucide-react";
import { cardAction, type Listing } from "../shared/event.ts";
import { formatWhen } from "./uiText.ts";

type EventCardProps = {
  listing: Listing;
  busy: boolean;
  onBook: (listing: Listing) => void;
};

export function EventCard({ listing, busy, onBook }: EventCardProps) {
  const action = cardAction(listing);
  const [posterFailed, setPosterFailed] = useState(false);
  if (!action) return null;
  const when = formatWhen(listing.start, listing.timezone, new Date());
  const place = [listing.venue, listing.city].filter(Boolean).join(", ");
  const showPoster = listing.posterUrl != null && !posterFailed;
  const bookLabel = listing.platform === "Luma" ? "Register" : "Book";
  return (
    <article className="card">
      {showPoster ? (
        <img src={listing.posterUrl ?? ""} alt="" loading="lazy" onError={() => setPosterFailed(true)} />
      ) : (
        <span className="poster-gap">{listing.kind}</span>
      )}
      <div className="card-copy">
        <p className="card-source">
          {listing.platform}
          {listing.category ? ` · ${listing.category}` : ""}
        </p>
        <h3 className="card-title">{listing.title}</h3>
        {when ? <p className="card-line"><CalendarClock size={14} aria-hidden="true" />{when}</p> : null}
        {place ? <p className="card-line"><MapPin size={14} aria-hidden="true" />{place}</p> : null}
        {listing.driveMinutes != null ? <p className="card-line"><Car size={14} aria-hidden="true" />About {listing.driveMinutes} min drive</p> : null}
        <p className="card-price">{priceLabel(listing)}</p>
        <div className="card-actions">
          <button className="card-book" type="button" disabled={busy} onClick={() => onBook(listing)}>
            {bookLabel}
          </button>
          <a className="card-action" href={action.href} target="_blank" rel="noreferrer">{action.label}</a>
        </div>
      </div>
    </article>
  );
}

function priceLabel(listing: Listing): string {
  switch (listing.price.provenance) {
    case "free":
      return "Free";
    case "unknown":
      return "Price on provider page";
    case "advertised":
      return listing.price.min == null ? "Price on provider page" : `From ₹${listing.price.min}`;
    default: {
      const neverPrice: never = listing.price.provenance;
      return neverPrice;
    }
  }
}
