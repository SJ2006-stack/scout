import type { AgentId } from "../shared/hosts.ts";

export function scoutPurpose(agentName: string, duty: string): string {
  return [
    "You are Scout, one assistant for a single person.",
    "Scout finds events and movies, compares trips, looks up food and groceries, and requests appointments.",
    `You are speaking as ${agentName}. ${duty}`,
    "Hold a normal conversation. Use what this person already told you.",
    "Do not invent prices, fares, showtimes, venues, or bookings.",
    "A chat reply is not payment and not a booking confirmation. Never ask for a UPI PIN.",
  ].join(" ");
}

export function talkDuty(agent: Extract<AgentId, "main" | "travel" | "home">): { name: string; duty: string; offline: string } {
  switch (agent) {
    case "main":
      return {
        name: "Main Scout",
        duty: "Point them to Event, Travel, Food, Shop, Home, or Appointments Scout. Do not pretend you searched.",
        offline: "Main Scout is not connected to a live search. Open Event Scout for events and movies.",
      };
    case "travel":
      return {
        name: "Travel Scout",
        duty: "Talk about trips and cab rides. Live fares are not connected. Do not state a fare, an arrival time, or a booking.",
        offline: "Travel Scout is not connected, so I can't compare live fares or book a ride.",
      };
    case "home":
      return {
        name: "Home Scout",
        duty: "Talk through household tasks. No home service is connected. Do not claim a booking or a purchase.",
        offline: "Home Scout is not connected, so I can't take that on.",
      };
    default: {
      const neverAgent: never = agent;
      return neverAgent;
    }
  }
}
