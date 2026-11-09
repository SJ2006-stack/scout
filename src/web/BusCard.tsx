import type { BusResult, BusSiteResult } from "../shared/errands.ts";

export function BusCard({ buses }: { buses: BusResult }) {
  const sites = buses.sites && buses.sites.length > 0 ? buses.sites : [fallbackSite(buses)];
  return (
    <article className="review">
      <header>
        <strong>
          Buses {buses.from} to {buses.to}
        </strong>
        <span>{buses.date}</span>
      </header>
      <p className="review-note">
        Cheapest first, leaving in the {buses.window}. Scout scrolls each site until that window shows up, or the list stops.
      </p>
      {sites.map((site) => (
        <section key={site.site}>
          <p className="review-note">
            {site.site}
            {site.total != null ? ` lists ${site.total} that day.` : ""}
            {site.options.length === 0
              ? site.loaded > 0
                ? ` Loaded ${site.loaded} departures. None leave in this window.`
                : " No departure times could be read."
              : ""}
          </p>
          <ul>
            {site.options.slice(0, 4).map((bus) => (
              <li key={`${site.site}-${bus.operator}-${bus.departs}-${bus.rupees}`}>
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
          <a className="chip" href={site.url} target="_blank" rel="noreferrer">
            See on {site.site}
          </a>
        </section>
      ))}
    </article>
  );
}

function fallbackSite(buses: BusResult): BusSiteResult {
  return { site: "redBus", url: buses.url, total: buses.total, loaded: buses.options.length, options: buses.options };
}
