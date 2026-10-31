import type { LucideIcon } from "lucide-react";
import { CalendarDays, House, Plane, Scissors, ShoppingBag, Sparkles, UtensilsCrossed } from "lucide-react";
import type { AgentId } from "../shared/hosts.ts";

export type { AgentId } from "../shared/hosts.ts";

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
    intro: "Tell me what you need. I can point you to Event, Travel, Food, Shop, Home, or Appointments Scout.",
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
    intro: "Tell me where you are going. I can talk through the trip. Live cab fares are not connected yet.",
    unavailable: "Travel Scout is not connected, so I can't compare live fares or book a ride.",
    icon: Plane,
  },
  {
    id: "food",
    name: "Food Scout",
    description: "Look up dishes and review a simulated order.",
    intro: "Tell me what you want to eat. I look at the simulated menu, then review the order with you.",
    unavailable: "",
    icon: UtensilsCrossed,
  },
  {
    id: "shop",
    name: "Shop Scout",
    description: "Compare Blinkit, Zepto, and Instamart, then hand payment to your phone.",
    intro: "Tell me an item. I check Blinkit, Zepto, and Instamart, then hand the pay link to your phone.",
    unavailable: "",
    icon: ShoppingBag,
  },
  {
    id: "home",
    name: "Home Scout",
    description: "Help with things around the house.",
    intro: "Tell me what you need around the house. No home service is connected yet, so I can plan it with you.",
    unavailable: "Home Scout is not connected, so I can't take that on.",
    icon: House,
  },
  {
    id: "appointments",
    name: "Appointments Scout",
    description: "Request a simulated salon time.",
    intro: "Tell me the service, the time, and your name. I request it from the simulated salon and wait for an answer.",
    unavailable: "",
    icon: Scissors,
  },
];

export function agentById(id: AgentId): Agent {
  switch (id) {
    case "main":
    case "event":
    case "travel":
    case "food":
    case "shop":
    case "home":
    case "appointments": {
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
