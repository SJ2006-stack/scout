import type { FlightResult } from "../shared/errands.ts";

export function FlightCard({ flights }: { flights: FlightResult }) {
  return (
    <article className="review">
      <header>
        <strong>
          Flights {flights.from} to {flights.to}
        </strong>
        <span>{flights.date}</span>
      </header>
      <p className="review-note">Leaving in the {flights.window}. Scout cites each search. It does not book or pay.</p>
      <ul>
        {flights.cites.map((cite) => (
          <li key={cite.site}>
            <span>
              {cite.site}
              <br />
              <small>{cite.departs ? `Leaves ${cite.departs}` : "Open the search for times"}</small>
            </span>
            <span>{cite.rupees != null ? `₹${cite.rupees}` : "See fares"}</span>
          </li>
        ))}
      </ul>
      <p className="review-note">
        {flights.cites.map((cite) => (
          <a key={cite.url} className="chip" href={cite.url} target="_blank" rel="noreferrer">
            {cite.site}
          </a>
        ))}
      </p>
    </article>
  );
}
