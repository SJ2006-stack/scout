import type { CommerceEvent } from "../shared/commerce.ts";
import { isListingUrl, type Platform } from "../shared/event.ts";
import type { BrowserWorker } from "./browser/worker.ts";
import { isLiveShopQuery, payResultLine } from "./browser/shelf.ts";
import { withEmoji } from "../shared/emoji.ts";

export { isLiveShopQuery };

export async function runShopSearch(
  worker: BrowserWorker,
  query: string,
  emit: (event: CommerceEvent) => void,
  signal: AbortSignal,
  ownerId?: string,
): Promise<void> {
  emit({ type: "status", message: "Opening Blinkit, then Zepto, then Instamart." });
  const shop = await worker.compareShop(query, signal, ownerId, (message) => emit({ type: "status", message }));
  if (signal.aborted) return;
  if (shop.signIn) emit({ type: "text", message: withEmoji(shop.signIn) });
  emit({ type: "text", message: withEmoji(shop.summary) });
  if (shop.pay) {
    emit({ type: "status", message: payResultLine(shop.pay) });
    emit({ type: "pay", pay: shop.pay });
  } else if (shop.cheapest) emit({ type: "note", message: "The pay link was not on the page." });
  emit({ type: "done" });
}

export async function runListingPay(
  worker: BrowserWorker,
  pageUrl: string,
  title: string,
  emit: (event: CommerceEvent) => void,
  signal: AbortSignal,
  ownerId?: string,
): Promise<void> {
  const merchant = merchantFor(pageUrl);
  if (!merchant) {
    emit({ type: "text", message: withEmoji("That listing is not a Luma, District, or BookMyShow page.") });
    emit({ type: "done" });
    return;
  }
  emit({ type: "status", message: merchant === "Luma" ? "Registering for the event." : "Opening the pay screen." });
  const result = await worker.collectPay(pageUrl, title, merchant, signal, ownerId);
  if (signal.aborted) return;
  if (result?.message) emit({ type: "status", message: result.message });
  if (result?.pay) emit({ type: "pay", pay: result.pay });
  else if (!result?.message) emit({ type: "text", message: withEmoji("The pay link was not on the page.") });
  emit({ type: "done" });
}

export function parsePayRequest(value: unknown): { ok: true; url: string; title: string } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "Send the listing to book." };
  const body = value as { url?: unknown; title?: unknown };
  if (typeof body.url !== "string" || merchantFor(body.url) == null) {
    return { ok: false, error: "Send a Luma, District, or BookMyShow listing." };
  }
  const title = typeof body.title === "string" && body.title.trim().length > 0 ? body.title.trim().slice(0, 120) : "Ticket";
  return { ok: true, url: body.url, title };
}

function merchantFor(url: string): Platform | null {
  if (isListingUrl(url, "Luma")) return "Luma";
  if (isListingUrl(url, "District")) return "District";
  if (isListingUrl(url, "BookMyShow")) return "BookMyShow";
  return null;
}
