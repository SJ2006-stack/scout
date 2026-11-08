import { storeName, type CartEstimate } from "../shared/cartQuote.ts";

export function EstimateCard({ estimate }: { estimate: CartEstimate }) {
  const { quote } = estimate;
  const best = quote.estimates[0];
  const rough = quote.estimates.some((row) => row.basis === "rough");
  const basket = estimate.lines > 1;
  return (
    <article className="review">
      <header>
        <strong>Estimated totals</strong>
        <span>{best ? `${storeName(best.store)} looks cheapest` : "No prices"}</span>
      </header>
      <p>{basket ? `${estimate.item}, in one cart` : `One ${estimate.item}`}, with delivery and handling</p>
      <ul>
        {quote.estimates.map((row) => (
          <li key={row.store}>
            <span>
              {storeName(row.store)}{row.store === quote.best ? " (best)" : ""}
              {row.missing.length > 0 ? ` · no ${row.missing.join(", ")}` : ""}
            </span>
            <span>₹{row.total} · phone about {row.phoneSeconds} s</span>
          </li>
        ))}
      </ul>
      <p className="review-note">
        {rough
          ? "Some fees are Scout's starting guess. Each cart your phone fills teaches Scout that store's real fees."
          : "Fees come from the bills your phone read in these apps."}
        {basket ? " Ask to order it and the phone fills the whole basket in the best store, in one run." : " Ask to buy it and only the best store's cart is filled."}
      </p>
    </article>
  );
}
