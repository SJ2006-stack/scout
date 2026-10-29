import type { CommerceAgent } from "../shared/commerce.ts";
import type { AgentId } from "../shared/hosts.ts";

export type AgentRoute =
  | { kind: "event" }
  | { kind: "commerce"; agent: CommerceAgent }
  | { kind: "unavailable" };

export function agentRoute(agent: AgentId): AgentRoute {
  switch (agent) {
    case "event":
      return { kind: "event" };
    case "shop":
    case "food":
    case "appointments":
      return { kind: "commerce", agent };
    case "main":
    case "travel":
    case "home":
      return { kind: "unavailable" };
    default: {
      const neverAgent: never = agent;
      return neverAgent;
    }
  }
}

export function agentEndpoint(agent: AgentId): "/api/chat" | "/api/commerce" | null {
  const route = agentRoute(agent);
  switch (route.kind) {
    case "event":
      return "/api/chat";
    case "commerce":
      return "/api/commerce";
    case "unavailable":
      return null;
    default: {
      const neverRoute: never = route;
      return neverRoute;
    }
  }
}
