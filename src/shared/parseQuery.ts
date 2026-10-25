import type { Quantity } from "./offer.ts";
import { parseQuantity } from "./quantity.ts";

export type ParsedQuery = {
  raw: string;
  keywords: string;
  brand: string | null;
  quantity: Quantity | null;
};

const BRANDS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bmother dairy\b/i, label: "Mother Dairy" },
  { pattern: /\baashirvaad\b/i, label: "Aashirvaad" },
  { pattern: /\bbritannia\b/i, label: "Britannia" },
  { pattern: /\bnestle\b/i, label: "Nestle" },
  { pattern: /\bnandini\b/i, label: "Nandini" },
  { pattern: /\bamul\b/i, label: "Amul" },
  { pattern: /\btata\b/i, label: "Tata" },
];

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "find",
  "please",
  "near",
  "my",
  "me",
  "for",
  "of",
  "delivery",
  "location",
  "area",
]);

export function parseQuery(raw: string): ParsedQuery {
  const quantity = parseQuantity(raw);
  const brand = BRANDS.find((entry) => entry.pattern.test(raw))?.label ?? null;
  let keywords = raw.toLowerCase();
  if (quantity) keywords = keywords.replace(quantity.raw.toLowerCase(), " ");
  keywords = keywords
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOPWORDS.has(word))
    .join(" ");
  return { raw, keywords, brand, quantity };
}
