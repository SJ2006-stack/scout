export type LiveProviderName = "swiggy" | "razorpay" | "saloning";

export type LiveLink = {
  provider: LiveProviderName;
  authorized: boolean;
  reason: string;
};

const PROVIDERS: readonly { provider: LiveProviderName; keys: readonly string[] }[] = [
  { provider: "swiggy", keys: ["SWIGGY_ACCESS_TOKEN"] },
  { provider: "razorpay", keys: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"] },
  { provider: "saloning", keys: ["SALONING_API_KEY", "SALONING_SALON_ID"] },
];

export function inspectLiveLinks(env: Record<string, string | undefined>): LiveLink[] {
  return PROVIDERS.map((entry) => inspectProvider(entry.provider, env, entry.keys));
}

export function liveHoldNote(links: LiveLink[]): string {
  if (links.every((link) => link.authorized)) {
    return "Live orders stay off until an operation is confirmed for this account.";
  }
  return "This checkout is simulated. Live Swiggy, Razorpay, and Saloning are not authorized for this account.";
}

function inspectProvider(provider: LiveProviderName, env: Record<string, string | undefined>, keys: readonly string[]): LiveLink {
  const missingCredentials = keys.some((key) => (env[key] ?? "").trim().length === 0);
  if (missingCredentials) {
    return { provider, authorized: false, reason: "Credentials are not available, so the labeled mock stays in place." };
  }
  return { provider, authorized: false, reason: "The provider schema is not available, so the labeled mock stays in place." };
}
