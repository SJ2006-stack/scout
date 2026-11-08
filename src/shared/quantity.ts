import type { Quantity } from "./offer.ts";

const UNIT =
  "millilitres?|milliliters?|litres?|liters?|kilograms?|grams?|ltr|kgs?|gms?|ml|l|g";

const UNIT_PATTERN = new RegExp(`(?<amount>\\d+(?:\\.\\d+)?)\\s*(?<unit>${UNIT})\\b`, "gi");

/** Display units for a product reference. Includes the pack words the shelf already matches, plus pcs. */
const SIZE_UNIT =
  "kilograms?|grams?|millilitres?|milliliters?|litres?|liters?|kgs?|gms?|pcs?|pieces?|ltr|ml|kg|gm|l|g";

const SIZE_PATTERN = new RegExp(
  `(\\d+(?:\\.\\d+)?)(?:\\s*[x×]\\s*(\\d+(?:\\.\\d+)?))?\\s*(${SIZE_UNIT})\\b`,
  "gi",
);

type SizeHit = { index: number; raw: string; label: string };

function shortUnit(unit: string): "kg" | "g" | "ml" | "l" | "pcs" {
  const value = unit.toLowerCase();
  if (value === "kg" || value === "kgs" || /^kilogram/.test(value)) return "kg";
  if (value === "g" || value === "gm" || value === "gms" || /^gram/.test(value)) return "g";
  if (value === "ml" || /^millilit/.test(value)) return "ml";
  if (value === "l" || value === "ltr" || /^litre/.test(value) || /^liter/.test(value)) return "l";
  return "pcs";
}

function lastSize(text: string): SizeHit | null {
  const matches = [...text.matchAll(SIZE_PATTERN)];
  const match = matches.at(-1);
  if (!match?.[1] || !match[3] || match.index == null || match[0] == null) return null;
  const amount = match[2] ? `${match[1]} x ${match[2]}` : match[1];
  return { index: match.index, raw: match[0], label: `${amount} ${shortUnit(match[3])}` };
}

/** The pack size as the stores print it: "500 gm", "1 kilogram", and "6 pieces" become "500 g", "1 kg", and "6 pcs". */
export function normalisedSize(text: string): string | null {
  return lastSize(text)?.label ?? null;
}

/** Drops a size that sits at the end of a product name, so a slug is not built from "80 g". */
export function withoutTrailingSize(text: string): string {
  const found = lastSize(text);
  const trimmed = text.trim();
  if (!found) return trimmed;
  const end = found.index + found.raw.length;
  if (text.slice(end).trim().length > 0) return trimmed;
  const name = text.slice(0, found.index).replace(/\s+/g, " ").trim();
  return name || trimmed;
}

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
