import type { FoundEvent } from "./chatMemory.ts";

const OTHER_RESULTS =
  /\b(?:any other|anything else|something else|what else|some other|other than|except|excluding|besides|not (?:these|those|the above)|different (?:ones|shows|events)|other (?:standup |comedy |shows|events|movies|listings)|more (?:standup |comedy |shows|events|movies|listings|of them|like that))\b/i;

/** True when they want listings other than the ones already on screen. */
export function asksForOtherResults(text: string): boolean {
  return OTHER_RESULTS.test(text);
}

/** Keeps earlier listings, then the ones just shown, and drops a repeated url. */
export function mergeShown(previous: readonly FoundEvent[] | undefined, next: readonly FoundEvent[]): FoundEvent[] {
  const seen = new Set<string>();
  const merged: FoundEvent[] = [];
  for (const item of [...(previous ?? []), ...next]) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    merged.push(item);
  }
  return merged.slice(-40);
}

/**
 * The listings to put on screen. A follow-up that asks for others leaves out urls already shown.
 * `repeated` means the search only found listings they have already seen.
 */
export function listingsToShow<T extends { url: string }>(
  ranked: readonly T[],
  already: readonly { url: string }[] | undefined,
  askAgain: boolean,
): { shown: T[]; repeated: boolean } {
  if (!askAgain) return { shown: [...ranked], repeated: false };
  const skip = new Set((already ?? []).map((item) => item.url));
  const shown = ranked.filter((item) => !skip.has(item.url));
  return { shown, repeated: shown.length === 0 && ranked.length > 0 };
}
