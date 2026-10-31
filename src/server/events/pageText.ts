import { isListingUrl, type Platform } from "../../shared/event.ts";

export type FoundEvent = { title: string; url: string };

const ASK = "This is what I got when I last checked. Are you looking for something particular?";

export function readablePage(html: string): string {
  const description = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1]
    ?? "";
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
  const combined = [description.trim(), text].filter((part) => part.length > 0).join(" ");
  return combined.slice(0, 2_500);
}

export function listingPlatform(url: string): Platform | null {
  if (isListingUrl(url, "Luma")) return "Luma";
  if (isListingUrl(url, "District")) return "District";
  if (isListingUrl(url, "BookMyShow")) return "BookMyShow";
  return null;
}

export function matchFound(found: readonly FoundEvent[], title: string, url: string): FoundEvent | null {
  const direct = url.trim();
  if (listingPlatform(direct)) return { title: title.trim() || direct, url: direct };
  const needle = title.trim().toLowerCase();
  if (needle.length < 2) return null;
  return found.find((item) => item.title.toLowerCase().includes(needle)) ?? null;
}

export function wantsOneEvent(text: string): boolean {
  return /register|rsvp|sign me up|book me|use my (?:gmail|email|phone)|more detail|tell me more|full detail|browser worker|about\s+\S+/i.test(text);
}

export function browseFollowUp(reply: string, showed: number, userText: string): string {
  if (showed === 0 || wantsOneEvent(userText) || reply.includes("?")) return reply;
  const body = reply.trim();
  return body.length > 0 ? `${body}\n\n${ASK}` : ASK;
}
