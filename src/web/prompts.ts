import type { AgentId } from "../shared/hosts.ts";

const PROMPTS: Record<Exclude<AgentId, "main">, string[]> = {
  event: ["Find comedy shows in Delhi this weekend.", "What's happening tomorrow in Delhi?"],
  travel: ["Compare cabs to the airport.", "Plan a weekend trip."],
  food: ["Find dosa.", "Add 1 dosa."],
  shop: ["Find milk.", "Add 1 milk."],
  home: ["Help with something around the house."],
  appointments: ["Find a haircut.", "Book a haircut tomorrow at 4pm for Ada with Noor."],
};

export function promptsFor(agent: AgentId): string[] {
  switch (agent) {
    case "main":
      return [];
    case "event":
    case "travel":
    case "food":
    case "shop":
    case "home":
    case "appointments":
      return PROMPTS[agent];
    default: {
      const neverAgent: never = agent;
      return neverAgent;
    }
  }
}
