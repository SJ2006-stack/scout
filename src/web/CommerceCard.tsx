import {
  formatAmount,
  lineBadge,
  outcomeLabel,
  providerLabel,
  type CartSnapshot,
  type QuoteSnapshot,
  type ReceiptSnapshot,
} from "../shared/commerce.ts";

export function CartCard({ cart }: { cart: CartSnapshot }) {
  return (
    <article className="review">
      <header>
        <strong>{providerLabel(cart.provider)}</strong>
        <span>{outcomeLabel(cart.provenance, "order")}</span>
      </header>
      <ul>
        {cart.lines.map((line) => (
          <li key={line.id}>
            <span>{line.quantity} × {line.name}</span>
            <span>{formatAmount(line.lineTotal)}</span>
            <span className="review-badge">{lineBadge(cart.provenance)}</span>
          </li>
        ))}
      </ul>
      <p><span>Delivery</span><span>{formatAmount(cart.deliveryFee)}</span></p>
      <p><span>Total</span><span>{formatAmount(cart.total)}</span></p>
    </article>
  );
}

export function QuoteCard({
  quote,
  busy,
  onConfirm,
}: {
  quote: QuoteSnapshot;
  busy: boolean;
  onConfirm: (quoteId: string) => void;
}) {
  return (
    <article className="review">
      <header>
        <strong>{quote.title}</strong>
        <span>{outcomeLabel(quote.provenance, quote.domain)}</span>
      </header>
      <ul>
        {quote.lines.map((line, index) => (
          <li key={`${line.label}-${index}`}>
            <span>{line.quantity} × {line.label}</span>
            <span>{formatAmount(line.amount)}</span>
            <span className="review-badge">{lineBadge(quote.provenance)}</span>
          </li>
        ))}
      </ul>
      {quote.details.map((detail) => (
        <p key={detail.label}><span>{detail.label}</span><span>{detail.value}</span></p>
      ))}
      {quote.domain === "order" ? <p><span>Delivery</span><span>{formatAmount(quote.deliveryFee)}</span></p> : null}
      <p><span>Total</span><span>{formatAmount(quote.total)}</span></p>
      {quote.total == null ? (
        <p>The total is unknown, so this stays unpaid.</p>
      ) : (
        <button type="button" disabled={busy} onClick={() => onConfirm(quote.id)}>Confirm review</button>
      )}
      <p className="review-note">A chat reply is not a payment. Scout does not ask for a UPI PIN.</p>
    </article>
  );
}

export function ReceiptCard({ receipt }: { receipt: ReceiptSnapshot }) {
  return (
    <article className="review">
      <header>
        <strong>{receipt.label}</strong>
        <span>{receipt.provider}</span>
      </header>
      <p><span>Status</span><span>{receipt.status}</span></p>
      <p><span>Total</span><span>{formatAmount(receipt.total)}</span></p>
      <p><span>Reference</span><span>{receipt.id}</span></p>
      {receipt.lines.map((line) => (
        <p key={line.label}><span>{line.label}</span><span>{line.value}</span></p>
      ))}
    </article>
  );
}
