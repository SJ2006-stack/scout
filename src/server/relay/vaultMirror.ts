import type { RestoreResult, SessionVault } from "../browser/sessionVault.ts";
import type { VaultMessage } from "../../shared/relay.ts";
import type { RelayHub } from "./relayHub.ts";

const MAX_OFFERS_PER_CONNECTION = 64;

/**
 * Keeps a sealed copy of each verified site sign-in on the user's phone. When
 * the phone connects it offers its copies back first, so a sign-in survives this
 * server losing its disk; then it receives everything the server has.
 */
export function mirrorVault(vault: SessionVault, hub: RelayHub, log: (line: string) => void = () => {}): void {
  const offers = new Map<string, number>();

  vault.onChange((change) => {
    if (change.kind === "drop") {
      hub.sendVault(change.ownerId, { op: "drop", domain: change.domain, at: change.at });
      return;
    }
    const sealed = vault.sealed(change.ownerId, change.domain);
    if (sealed) hub.sendVault(change.ownerId, { op: "put", ...sealed });
  });

  hub.onAttach((userId) => {
    offers.set(userId, 0);
    for (const sealed of vault.sealedAll(userId)) hub.sendVault(userId, { op: "put", ...sealed });
  });

  hub.onVault((userId, message) => {
    if (message.op !== "offer") return;
    const seen = (offers.get(userId) ?? 0) + 1;
    offers.set(userId, seen);
    if (seen > MAX_OFFERS_PER_CONNECTION) return;
    const result = restoreOffer(vault, userId, message);
    if (result === "restored") log(`Restored a ${message.domain} sign-in from the phone.`);
    if (result === "revoked") {
      hub.sendVault(userId, { op: "drop", domain: message.domain, at: vault.revokedAt(userId, message.domain) ?? Date.now() });
      return;
    }
    if (result === "kept") {
      const ours = vault.sealed(userId, message.domain);
      if (ours && ours.updatedAt > message.updatedAt) hub.sendVault(userId, { op: "put", ...ours });
    }
  });
}

function restoreOffer(vault: SessionVault, userId: string, message: Exclude<VaultMessage, { op: "drop" }>): RestoreResult {
  try {
    return vault.restore(userId, {
      domain: message.domain,
      updatedAt: message.updatedAt,
      expiresAt: message.expiresAt,
      lastValidatedAt: message.lastValidatedAt,
      blob: Buffer.from(message.blob),
    });
  } catch {
    return "rejected";
  }
}
