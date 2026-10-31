import { agentFromHostname, agentFromPathname, isAgentId, type AgentId } from "../shared/hosts.ts";
import { apiUrl } from "./backend.ts";

export function siteAgentFromHostname(hostname: string): AgentId | null {
  return agentFromHostname(hostname);
}

export function siteAgentFromLocation(hostname: string, pathname: string): AgentId | null {
  return agentFromPathname(pathname) ?? agentFromHostname(hostname);
}

export async function siteAgentFromHealth(fetchImpl: typeof fetch = fetch): Promise<AgentId | null> {
  try {
    const response = await fetchImpl(apiUrl("/api/health"));
    if (!response.ok) return null;
    const body = (await response.json()) as { agent?: unknown };
    return isAgentId(body.agent) ? body.agent : null;
  } catch {
    return null;
  }
}
