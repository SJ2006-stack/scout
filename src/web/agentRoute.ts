import type { CommerceAgent } from "../shared/commerce.ts";
import type { AgentId } from "../shared/hosts.ts";

export type AgentRoute = { kind: "chat"; agent: AgentId };

export function agentRoute(agent: AgentId): AgentRoute {
  switch (agent) {
    case "main":
    case "event":
    case "travel":
    case "food":
    case "shop":
    case "home":
    case "appointments":
      return { kind: "chat", agent };
    default: {
      const neverAgent: never = agent;
      return neverAgent;
    }
  }
}

export function agentEndpoint(agent: AgentId): "/api/chat" {
  switch (agent) {
    case "main":
    case "event":
    case "travel":
    case "food":
    case "shop":
    case "home":
    case "appointments":
      return "/api/chat";
    default: {
      const neverAgent: never = agent;
      return neverAgent;
    }
  }
}

export function commerceAgent(agent: AgentId): CommerceAgent | null {
  switch (agent) {
    case "shop":
    case "food":
    case "appointments":
      return agent;
    case "main":
    case "event":
    case "travel":
    case "home":
      return null;
    default: {
      const neverAgent: never = agent;
      return neverAgent;
    }
  }
}
