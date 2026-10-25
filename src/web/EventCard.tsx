import { useState } from "react";
import { cardAction, type Listing } from "../shared/event.ts";

export function EventCard({ listing }: { listing: Listing }) {
  const action = cardAction(listing);
  const [posterFailed, setPosterFailed] = useState(false);
  if (!action) return null;
  const when = listing.start == null ? null : new Date(listing.start).toLocaleString();
  const showPoster = listing.posterUrl != null && !posterFailed;
  return (
    <a className="card" href={action.href} target="_blank" rel="noreferrer">
      {showPoster ? (
        <img src={listing.posterUrl ?? ""} alt="" onError={() => setPosterFailed(true)} />
      ) : (
        <span className="poster-gap">{listing.kind}</span>
      )}
      <span className="card-copy">
        <span className="card-title">{listing.title}</span>
        {when ? <span className="card-line">{when}</span> : null}
        {listing.venue || listing.city ? <span className="card-line">{[listing.venue, listing.city].filter(Boolean).join(", ")}</span> : null}
        <span className="card-line">{priceLabel(listing)}</span>
        <span className="card-source">{listing.platform}{listing.category ? ` · ${listing.category}` : ""}</span>
        {listing.driveMinutes != null ? <span className="card-line">About {listing.driveMinutes} min drive</span> : null}
        <span className="card-action">{action.label}</span>
      </span>
    </a>
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
