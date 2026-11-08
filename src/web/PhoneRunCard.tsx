import { cheaperElsewhere, phoneMs, storeName, type CartEstimate } from "../shared/cartQuote.ts";
import { appName, isShopApp, type AppCartResult, type AppEventResult } from "../shared/deviceActions.ts";
import { openLabel, payLabel, phoneRunReason, phoneRunState, type PhoneRun, type PhoneRunState } from "../shared/phoneRun.ts";

/** estimate is the shop compare that came before this run in the chat, when there was one. */
export function PhoneRunCard({ run, estimate = null }: { run: PhoneRun; estimate?: CartEstimate | null }) {
  const state = phoneRunState(run);
  return (
    <article className="review">
      <header>
        <strong>{appName(run.app)}</strong>
        <span>{stateLabel(state, run)}</span>
      </header>
      <p>{run.summary}</p>
      <PhoneRunBody run={run} state={state} estimate={estimate} />
      <p className="review-note">Scout never taps Pay or asks for a UPI PIN. You pay in {appName(run.app)}.</p>
    </article>
  );
}

function PhoneRunBody({ run, state, estimate }: { run: PhoneRun; state: PhoneRunState; estimate: CartEstimate | null }) {
  switch (state) {
    case "waiting":
      return <p className="review-note">Tap Allow on your phone. Scout then works in {appName(run.app)} and stops before payment.{etaLine(run, estimate)}</p>;
    case "added":
      if (run.action === "app_event_book") {
        return (
          <>
            {run.message ? <p className="review-note">{run.message}</p> : null}
            {run.event ? <TicketLines event={run.event} /> : null}
            <button className="card-book" type="button" onClick={() => openLink(run.link)}>{openLabel(run)}</button>
          </>
        );
      }
      return (
        <>
          {run.cart ? <CartLines cart={run.cart} /> : null}
          {run.message && !run.cart ? <p className="review-note">{run.message}</p> : null}
          {run.cart ? <EstimateCheck cart={run.cart} estimate={estimate} /> : null}
          <button className="card-book" type="button" onClick={() => openLink(run.link)}>{payLabel(run)}</button>
        </>
      );
    case "needs_ok":
      return (
        <>
          <p className="review-note">{phoneRunReason(run) || "The app shows something different from what you asked for."}</p>
          {run.cart?.seen ? (
            <p>
              <span>In the app: {[run.cart.seen.name, run.cart.seen.size].filter(Boolean).join(" ")}</span>
              <span>{run.cart.seen.inStock === false ? "Out of stock" : rupees(run.cart.seen.price)}</span>
            </p>
          ) : null}
          {run.event?.total != null ? <p><span>In the app</span><span>{rupees(run.event.total)}</span></p> : null}
          <p className="review-note">Reply in chat to go ahead anyway or skip it.</p>
        </>
      );
    case "stopped":
      return (
        <>
          <p className="review-note">{phoneRunReason(run) || "Scout stopped before finishing."}</p>
          {stepLine(run) ? <p><span>Stopped at</span><span>{stepLine(run)}</span></p> : null}
          {run.cart && run.cart.added.length > 0 ? <CartLines cart={run.cart} /> : null}
          <button className="card-book" type="button" onClick={() => openLink(run.link)}>{openLabel(run)}</button>
        </>
      );
    case "handed":
      return (
        <>
          <p className="review-note">{run.message || `${appName(run.app)} needs you for this step.`}</p>
          {run.event ? <TicketLines event={run.event} /> : null}
          <button className="card-book" type="button" onClick={() => openLink(run.link)}>{openLabel(run)}</button>
        </>
      );
    default: {
      const neverState: never = state;
      return neverState;
    }
  }
}

function CartLines({ cart }: { cart: AppCartResult }) {
  const bill = cart.cart;
  return (
    <>
      <ul>
        {cart.added.map((line, index) => (
          <li key={`${line.name}-${index}`}>
            <span>{line.quantity} × {line.name}{line.size ? ` ${line.size}` : ""}</span>
            <span>{rupees(line.lineTotal ?? (line.unitPrice == null ? null : line.unitPrice * line.quantity))}</span>
          </li>
        ))}
      </ul>
      {bill?.itemsTotal != null ? <p><span>Items</span><span>{rupees(bill.itemsTotal)}</span></p> : null}
      {bill?.handling != null ? <p><span>Handling</span><span>{rupees(bill.handling)}</span></p> : null}
      {bill?.delivery != null ? <p><span>Delivery</span><span>{rupees(bill.delivery)}</span></p> : null}
      {bill?.otherFees != null ? <p><span>Other fees</span><span>{rupees(bill.otherFees)}</span></p> : null}
      <p><span>Cart total</span><span>{rupees(bill?.grandTotal ?? null)}</span></p>
    </>
  );
}

function etaLine(run: PhoneRun, estimate: CartEstimate | null): string {
  if (run.action !== "app_cart_add" || !isShopApp(run.app)) return "";
  const seconds = estimate?.quote.estimates.find((row) => row.store === run.app)?.phoneSeconds ?? Math.round(phoneMs(run.app, []) / 1000);
  return ` It usually takes about ${seconds} s.`;
}

/** Compares the bill the phone read with the estimate, and says when another store's estimate now beats it. */
function EstimateCheck({ cart, estimate }: { cart: AppCartResult; estimate: CartEstimate | null }) {
  const took = cart.elapsedMs != null ? `The phone took ${Math.round(cart.elapsedMs / 1000)} s.` : "";
  const units = cart.added.reduce((sum, line) => sum + line.quantity, 0);
  const addedTotal = cart.added.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0);
  const itemsTotal = cart.cart?.itemsTotal ?? null;
  const onlyOurs = itemsTotal != null && Math.abs(itemsTotal - addedTotal) < 1;
  const own = estimate?.quote.estimates.find((row) => row.store === cart.store);
  const comparable = onlyOurs && own != null && own.units === units;
  const guess = comparable ? own : undefined;
  const grand = cart.cart?.grandTotal ?? null;
  const cheaper = estimate && comparable ? cheaperElsewhere(estimate.quote, cart.store, grand) : null;
  const versus = guess && grand != null ? ` Scout estimated ₹${guess.total}; the app says ₹${grand}.` : "";
  const elsewhere = cheaper ? ` ${storeName(cheaper.store)} was estimated at ₹${cheaper.total}, which beats this bill. Ask Scout to fill ${storeName(cheaper.store)} instead if you want.` : "";
  const mixed = estimate && itemsTotal != null && !onlyOurs ? " Your cart already had other items, so this total is not compared with the estimate." : "";
  const line = `${took}${versus}${elsewhere}${mixed}`.trim();
  return line.length > 0 ? <p className="review-note">{line}</p> : null;
}

function TicketLines({ event }: { event: AppEventResult }) {
  return (
    <>
      {event.tickets != null ? <p><span>Tickets</span><span>{event.tickets}</span></p> : null}
      {event.showtime != null ? <p><span>Show</span><span>{new Date(event.showtime).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span></p> : null}
      {event.seats && event.seats.length > 0 ? <p><span>Seats</span><span>{event.seats.join(", ")}</span></p> : null}
      {event.total != null ? <p><span>Total</span><span>{rupees(event.total)}</span></p> : null}
    </>
  );
}

function stateLabel(state: PhoneRunState, run: PhoneRun): string {
  switch (state) {
    case "waiting":
      return "Waiting for your OK on the phone";
    case "added":
      if (run.action !== "app_event_book") return "Ready to pay";
      if (run.event?.reason === "checkout_ready") return "Ready to pay";
      if (run.event?.reason === "form") return "Ready to register";
      return "Pick your seats";
    case "needs_ok":
      return "Needs your OK";
    case "stopped":
      return "Stopped";
    case "handed":
      return "Over to you";
    default: {
      const neverState: never = state;
      return neverState;
    }
  }
}

function stepLine(run: PhoneRun): string | null {
  return run.cart?.stoppedAt ?? run.event?.stoppedAt ?? null;
}

function rupees(value: number | null): string {
  return value == null ? "Not shown" : `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function openLink(url: string): void {
  if (url.startsWith("https://")) window.open(url, "_blank", "noopener,noreferrer");
}
