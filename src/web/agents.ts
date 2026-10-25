import type { LucideIcon } from "lucide-react";
import { CalendarDays, House, Plane, ShoppingBag, Sparkles, UtensilsCrossed } from "lucide-react";

export type AgentId = "main" | "event" | "travel" | "food" | "shop" | "home";

export type Agent = {
  id: AgentId;
  name: string;
  description: string;
  intro: string;
  unavailable: string;
  icon: LucideIcon;
};

export const AGENTS: Agent[] = [
  {
    id: "main",
    name: "Main Scout",
    description: "A starting point for everyday requests.",
    intro: "Main Scout can point you to a specialist. Event search is the one that runs today.",
    unavailable: "Main Scout is not connected to a live search. Open Event Scout for events and movies.",
    icon: Sparkles,
  },
  {
    id: "event",
    name: "Event Scout",
    description: "Find shows, movies, and things to do.",
    intro: "Ask for a city and a time. I look on Luma, District, and BookMyShow.",
    unavailable: "",
    icon: CalendarDays,
  },
  {
    id: "travel",
    name: "Travel Scout",
    description: "Compare everyday trips and cab rides.",
    intro: "Travel Scout is for trip and cab comparisons. Live fares are not connected.",
    unavailable: "Travel Scout is not connected, so I can't compare live fares or book a ride.",
    icon: Plane,
  },
  {
    id: "food",
    name: "Food Scout",
    description: "Look for places to eat nearby.",
    intro: "Food Scout is not connected yet.",
    unavailable: "Food Scout is not connected, so I can't look up restaurants.",
    icon: UtensilsCrossed,
  },
  {
    id: "shop",
    name: "Shop Scout",
    description: "Help with everyday shopping.",
    intro: "Shop Scout is not connected yet.",
    unavailable: "Shop Scout is not connected, so I can't look up stores or prices.",
    icon: ShoppingBag,
  },
  {
    id: "home",
    name: "Home Scout",
    description: "Help with things around the house.",
    intro: "Home Scout is not connected yet.",
    unavailable: "Home Scout is not connected, so I can't take that on.",
    icon: House,
  },
];

export function agentById(id: AgentId): Agent {
  switch (id) {
    case "main":
    case "event":
    case "travel":
    case "food":
    case "shop":
    case "home": {
      const found = AGENTS.find((agent) => agent.id === id);
      if (!found) throw new Error("Missing specialist");
      return found;
    }
    default: {
      const neverId: never = id;
      throw new Error(neverId);
    }
  }
}
