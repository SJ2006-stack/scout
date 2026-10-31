import { join } from "node:path";
import { agentFromHostname } from "../shared/hosts.ts";

export function mainLandingFile(root: string, hostHeader: string | undefined, pathname: string): string | null {
  if (pathname !== "/" && pathname !== "/index.html") return null;
  const host = hostHeader?.split(",")[0]?.trim() ?? "";
  if (agentFromHostname(host) !== "main") return null;
  return join(root, "scout-landing", "index.html");
}
