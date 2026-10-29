export type AgentId = "main" | "event" | "travel" | "food" | "shop" | "home" | "appointments";

const AGENT_IDS: readonly AgentId[] = ["main", "event", "travel", "food", "shop", "home", "appointments"];

const HOSTS: Record<AgentId, string> = {
  main: "https://sj-scout.azurewebsites.net",
  event: "https://sj-event-scout.azurewebsites.net",
  travel: "https://sj-travel-scout.azurewebsites.net",
  food: "https://sj-food-scout.azurewebsites.net",
  shop: "https://sj-shop-scout.azurewebsites.net",
  home: "https://sj-home-scout.azurewebsites.net",
  appointments: "https://sj-appointments-scout.azurewebsites.net",
};

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && AGENT_IDS.some((id) => id === value);
}

export function scoutAgent(value: string | undefined): AgentId {
  const trimmed = value?.trim().toLowerCase();
  if (isAgentId(trimmed)) return trimmed;
  return "event";
}

export function hostFor(agent: AgentId): string {
  switch (agent) {
    case "main":
    case "event":
    case "travel":
    case "food":
    case "shop":
    case "home":
    case "appointments":
      return HOSTS[agent];
    default: {
      const neverAgent: never = agent;
      return neverAgent;
    }
  }
}

export function agentFromHostname(hostname: string): AgentId | null {
  const host = hostname.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (host === "sj-scout.azurewebsites.net") return "main";
  const azure = /^sj-(event|travel|food|shop|home|appointments)-scout\.azurewebsites\.net$/.exec(host);
  if (azure && isAgentId(azure[1])) return azure[1];
  if (host.startsWith("event-scout.")) return "event";
  if (host.startsWith("travel-scout.")) return "travel";
  if (host.startsWith("food-scout.")) return "food";
  if (host.startsWith("shop-scout.")) return "shop";
  if (host.startsWith("home-scout.")) return "home";
  if (host.startsWith("appointments-scout.")) return "appointments";
  return null;
}
