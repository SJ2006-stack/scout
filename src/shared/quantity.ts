import type { Quantity } from "./offer.ts";

const UNIT =
  "millilitres?|milliliters?|litres?|liters?|kilograms?|grams?|ltr|kgs?|gms?|ml|l|g";

const UNIT_PATTERN = new RegExp(`(?<amount>\\d+(?:\\.\\d+)?)\\s*(?<unit>${UNIT})\\b`, "gi");

function toBase(amount: number, unitRaw: string, raw: string): Quantity | null {
  const unit = unitRaw.toLowerCase();
  if (/^(l|ltr|litres?|liters?)$/.test(unit)) {
    return { amount: amount * 1000, unit: "ml", raw };
  }
  if (/^(ml|millilitres?|milliliters?)$/.test(unit)) {
    return { amount, unit: "ml", raw };
  }
  if (/^(kg|kgs|kilograms?)$/.test(unit)) {
    return { amount: amount * 1000, unit: "g", raw };
  }
  if (/^(g|gm|gms|grams?)$/.test(unit)) {
    return { amount, unit: "g", raw };
  }
  return null;
}

export function parseQuantity(text: string): Quantity | null {
  const prefix = text.match(
    new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:x|×)\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNIT})\\b`, "i"),
  );
  if (prefix?.[1] && prefix[2] && prefix[3]) {
    return toBase(Number(prefix[1]) * Number(prefix[2]), prefix[3], prefix[0]);
  }
  const suffix = text.match(
    new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT})\\b\\s*(?:x|×)\\s*(\\d+)\\b`, "i"),
  );
  if (suffix?.[1] && suffix[2] && suffix[3]) {
    return toBase(Number(suffix[1]) * Number(suffix[3]), suffix[2], suffix[0]);
  }
  const matches = [...text.matchAll(UNIT_PATTERN)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    if (!match?.groups?.amount || !match.groups.unit || match[0] == null) continue;
    const quantity = toBase(Number(match.groups.amount), match.groups.unit, match[0]);
    if (quantity) return quantity;
  }
  return null;
}

export function quantitiesMatch(left: Quantity | null, right: Quantity | null): boolean {
  if (left == null || right == null) return false;
  return left.unit === right.unit && left.amount === right.amount;
}

export function quantityKey(quantity: Quantity | null): string {
  if (quantity == null) return "unknown";
  return `${quantity.amount}${quantity.unit}`;
}
