import type { BasketItem } from "./basket.ts";

const USUAL_GROCERIES = /\busual\s+grocer(?:y|ies)\b/i;
const ALSO_AN_ERRAND = /\b(events?|happening|things to do|plans?|shows?|movies?|concerts?|bus(?:es)?|flights?|fly|travel|trip|tickets?|whats ?app|\bsend\b|\bmessage\b|\btext\b|\btell\b)\b/i;

/** "Usual groceries" is the Vault basket, not a product name to search. */
export function asksUsualGroceries(text: string): boolean {
  return USUAL_GROCERIES.test(text) && !ALSO_AN_ERRAND.test(text);
}

/** The Usual grocery basket line, split into shop searches. Null when that line is missing or still blank. */
export function usualGroceryItems(markdown: string): BasketItem[] | null {
  const line = markdown.split("\n").find((row) => /usual grocery basket\s*:/i.test(row));
  if (!line) return null;
  const body = line.replace(/^.*usual grocery basket\s*:\s*/i, "").replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  if (body.length === 0 || /not yet provided/i.test(body)) return null;
  const items: BasketItem[] = [];
  for (const part of body.split(",")) {
    const item = usualItem(part);
    if (!item || items.some((seen) => seen.query.toLowerCase() === item.query.toLowerCase())) continue;
    items.push(item);
  }
  return items.length > 0 ? items : null;
}

function usualItem(part: string): BasketItem | null {
  let text = part.replace(/\s+/g, " ").trim();
  let quantity = 1;
  const times = text.match(/^(.*?)(?:\s+x\s*|\s*×\s*)(\d{1,2})$/i);
  if (times?.[1] && times[2]) {
    text = times[1].trim();
    quantity = Math.max(1, Number(times[2]));
  }
  const packed = text.match(/^(.*?)\s*\((?:a\s+)?(?:tray|pack|packet)\s+of\s+(\d{1,2})\)$/i);
  if (packed?.[1] && packed[2]) text = `${packed[1].trim()} ${packed[2]}`;
  const dozen = text.match(/^(.*?)\s*\((\d{1,2})\s+dozen\)$/i);
  if (dozen?.[1] && dozen[2]) text = `${dozen[1].trim()} ${dozen[2]} dozen`;
  text = text.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  if (text.length < 2) return null;
  return { query: text.slice(0, 80), quantity };
}
