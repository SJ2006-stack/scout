import type { BusResult } from "../shared/errands.ts";

export function BusCard({ buses }: { buses: BusResult }) {
  return (
    <article className="review">
      <header>
        <strong>
          Buses {buses.from} to {buses.to}
        </strong>
        <span>{buses.date}</span>
      </header>
      <p className="review-note">
        Cheapest first, leaving in the {buses.window}. {buses.total != null ? `redBus lists ${buses.total} buses that day.` : ""}
      </p>
      <ul>
        {buses.options.slice(0, 6).map((bus) => (
          <li key={`${bus.operator}-${bus.departs}-${bus.rupees}`}>
            <span>
              {bus.departs} → {bus.arrives} · {bus.operator}
              <br />
              <small>
                {bus.busType}
                {bus.rating != null ? ` · ${bus.rating}★` : ""}
                {bus.seats != null ? ` · ${bus.seats} seats` : ""}
              </small>
            </span>
            <span>₹{bus.rupees}</span>
          </li>
        ))}
      </ul>
      <a className="chip" href={buses.url} target="_blank" rel="noreferrer">
        Book on redBus
      </a>
    </article>
  );
}
