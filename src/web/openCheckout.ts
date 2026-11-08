type NativeWindow = Window & {
  ScoutNative?: { request?: (json: string) => string };
};

export type CheckoutReply = { accepted: boolean; status: string };

/** Asks the Scout Android app to open the cart or event app. Null on the website, where there is no bridge. */
export function requestOpenCheckout(app: string): CheckoutReply | null {
  const native = (window as NativeWindow).ScoutNative;
  if (typeof native?.request !== "function") return null;
  try {
    const parsed = JSON.parse(native.request(JSON.stringify({ op: "open_checkout", app }))) as { accepted?: unknown; status?: unknown };
    return {
      accepted: parsed.accepted === true,
      status: typeof parsed.status === "string" ? parsed.status : "failed",
    };
  } catch {
    return { accepted: false, status: "failed" };
  }
}
