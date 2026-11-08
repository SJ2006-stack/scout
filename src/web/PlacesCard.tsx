import type { SavedPlace } from "../shared/places.ts";

/** The app pages a task opened, kept in the chat so they can be opened again. */
export function PlacesCard({ places }: { places: readonly SavedPlace[] }) {
  return (
    <article className="review">
      <header>
        <strong>Open again</strong>
      </header>
      <div className="card-actions">
        {places.map((place) => (
          <a className="card-book" key={place.url} href={place.url} target="_blank" rel="noreferrer">
            {place.label}
          </a>
        ))}
      </div>
    </article>
  );
}
