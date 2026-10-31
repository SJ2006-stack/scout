import type { AgentId } from "../../shared/hosts.ts";

const STICKY_MS = 10 * 60_000;
const STICKY_LIMIT = 2_000;

const RULES: readonly { agent: AgentId; words: RegExp }[] = [
  { agent: "event", words: /\b(events?|shows?|comedy|stand ?up|concerts?|gigs?|workshops?|meetups?|parties|party|luma|district|bookmyshow|natak|theatre|theater|open mic|music|festival|exhibition|rsvp|hackathon)\b/i },
  { agent: "food", words: /\b(khana|khaana|bhook|swiggy|zomato|biryani|pizza|burger|dosa|restaurant|dinner|lunch|breakfast|nashta|menu|order food|food)\b/i },
  { agent: "shop", words: /\b(grocery|groceries|sabzi|sabji|doodh|milk|atta|blinkit|zepto|instamart|bigbasket|kharid\w*|buy|cheapest|sasta|price of|daam|eggs?|anda|bread)\b/i },
  { agent: "travel", words: /\b(cab|uber|ola|rapido|flights?|trains?|irctc|hotel|trip|travel|airport|metro|bus)\b/i },
  { agent: "home", words: /\b(plumber|electrician|cleaning|clean|ac service|repair|maid|carpenter|pest|urban company|painter)\b/i },
  { agent: "appointments", words: /\b(salon|haircut|hair cut|beard|baal|facial|spa|appointment|blowdry)\b/i },
];

export class VoiceRouter {
  private readonly last = new Map<string, { agent: AgentId; at: number }>();

  pick(userId: string, text: string, fallback: AgentId, now: number): AgentId {
    const matched = RULES.find((rule) => rule.words.test(text))?.agent;
    const previous = this.last.get(userId);
    const agent = matched ?? (previous && now - previous.at < STICKY_MS ? previous.agent : fallback);
    if (this.last.size >= STICKY_LIMIT && !this.last.has(userId)) {
      const oldest = this.last.keys().next().value;
      if (oldest) this.last.delete(oldest);
    }
    this.last.delete(userId);
    this.last.set(userId, { agent, at: now });
    return agent;
  }
}
