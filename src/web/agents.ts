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
    description: "Look up dishes and review a simulated order.",
    intro: "Ask for a dish. The menu, cart, and checkout are simulated.",
    unavailable: "",
    icon: UtensilsCrossed,
  },
  {
    id: "shop",
    name: "Shop Scout",
    description: "Look up Instamart items and review a simulated order.",
    intro: "Ask for an Instamart item. The cart and checkout are simulated.",
    unavailable: "",
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
  {
    id: "appointments",
    name: "Appointments Scout",
    description: "Request a simulated salon time.",
    intro: "Ask for a salon service. The request stays pending until the salon answers, and this booking is simulated.",
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
