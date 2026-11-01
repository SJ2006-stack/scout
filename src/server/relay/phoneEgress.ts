import type { EgressProxy, ProxySettings } from "./egressProxy.ts";
import type { RelayHub } from "./relayHub.ts";

/** wait false uses the phone only if it is already connected, for reads that should not stall. */
export type Egress = (ownerId: string | undefined, options?: { wait?: boolean }) => Promise<ProxySettings | undefined>;

/**
 * Store traffic leaves through the owner's phone when it is connected.
 * wake asks the phone to connect; waitMs is how long a task waits for it.
 */
export function phoneEgress(hub: RelayHub, proxy: EgressProxy, options: { wake?: (userId: string) => void; waitMs: number }): Egress {
  return async (ownerId, call) => {
    if (!ownerId) return undefined;
    if (!hub.has(ownerId)) {
      if (options.waitMs <= 0 || call?.wait === false) return undefined;
      options.wake?.(ownerId);
      if (!(await hub.waitFor(ownerId, options.waitMs))) return undefined;
    }
    return await proxy.settingsFor(ownerId);
  };
}
