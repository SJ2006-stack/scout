import { isListingUrl, kindFromText, unknownPrice, type Listing, type Platform } from "../../shared/event.ts";

const LUMA_SKIP = new Set([
  "discover",
  "signin",
  "sign-in",
  "pricing",
  "home",
  "create",
  "explore",
  "calendar",
  "bengaluru",
  "mumbai",
  "delhi",
  "new-delhi",
  "hyderabad",
]);

export function listingsFromHtml(html: string, platform: Platform, city: string | null, retrievedAt: string): Listing[] {
  const listings: Listing[] = [];
  const seen = new Set<string>();
  for (const url of linksFrom(html, platform)) {
    if (seen.has(url) || listings.length >= 8) continue;
    const title = titleFrom(url, platform);
    if (!title) continue;
    seen.add(url);
    listings.push({
      id: `${platform.toLowerCase()}:${url}`,
      sourceId: url,
      platform,
      title,
      kind: kindFromText(title),
      posterUrl: null,
      start: null,
      end: null,
      timezone: "Asia/Kolkata",
      city,
      venue: null,
      lat: null,
      lon: null,
      price: unknownPrice(),
      url,
      retrievedAt,
      category: null,
      driveMinutes: null,
    });
  }
  return listings;
}

function linksFrom(html: string, platform: Platform): string[] {
  const pattern = platform === "Luma"
    ? /https:\/\/(?:www\.)?luma\.com\/[A-Za-z0-9-]+/g
    : platform === "BookMyShow"
      ? /https:\/\/in\.bookmyshow\.com\/(?:events|movies)\/[^\s"'<>]+/g
      : /https:\/\/www\.district\.in\/(?:events|movies)\/[^\s"'<>]+/g;
  return [...html.matchAll(pattern)].map((match) => match[0].replace(/[),.;]+$/, ""));
}

function titleFrom(url: string, platform: Platform): string | null {
  if (!isListingUrl(url, platform)) return null;
  const path = new URL(url).pathname.split("/").filter((part) => part.length > 0);
  const slug = platform === "Luma" ? path[0] ?? "" : path[1] ?? "";
  if (slug.length < 2 || LUMA_SKIP.has(slug)) return null;
  const title = slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()).trim();
  return title.length > 1 ? title : null;
}
