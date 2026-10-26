import { scoutAgent, type AgentId } from "../shared/hosts.ts";

export function healthPayload(envValue = process.env.SCOUT_AGENT): { ok: true; agent: AgentId } {
  return { ok: true, agent: scoutAgent(envValue) };
}
