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

export const PUBLIC_ORIGIN = "https://scout.shrianshjaiswal.me";

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

export function scoutSlug(agent: Exclude<AgentId, "main">): string {
  switch (agent) {
    case "event":
      return "event-scout";
    case "travel":
      return "travel-scout";
    case "food":
      return "food-scout";
    case "shop":
      return "grocery-scout";
    case "home":
      return "home-scout";
    case "appointments":
      return "appointments-scout";
    default: {
      const neverAgent: never = agent;
      return neverAgent;
    }
  }
}

export function publicScoutUrl(agent: AgentId): string {
  if (agent === "main") return `${PUBLIC_ORIGIN}/`;
  return `${PUBLIC_ORIGIN}/${scoutSlug(agent)}`;
}

export function agentFromPathname(pathname: string): AgentId | null {
  const slug = pathname.replace(/^\/+|\/+$/g, "").split("/")[0] ?? "";
  switch (slug) {
    case "event-scout":
      return "event";
    case "travel-scout":
      return "travel";
    case "food-scout":
      return "food";
    case "grocery-scout":
    case "shop-scout":
      return "shop";
    case "home-scout":
      return "home";
    case "appointments-scout":
      return "appointments";
    default:
      return null;
  }
}

export function agentFromHostname(hostname: string): AgentId | null {
  const host = hostname.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (host === "sj-scout.azurewebsites.net" || host === "scout.shrianshjaiswal.me") return "main";
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
